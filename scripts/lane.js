#!/usr/bin/env node
'use strict';

// Transmogrify operator CLI: one provider-neutral entry point for lane
// lifecycle, parent contexts, dispatch, and bounded child waits. It resolves the
// provider from the durable lane record, strips provider control handles from
// every public result, and maps each adapter code to a fixed public message, a
// delivery projection, and an exit status: 0 confirmed, 2 safe refusal or
// precondition failure, 3 transport, protocol, or provider uncertainty.

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, TextDecoder } = require('node:util');
const codex = require('./lib/codex-adapter');
const claude = require('./lib/claude-adapter');
const {
  acknowledgeEvent,
  countEvents,
  createParentContext,
  digest,
  listDispatches,
  listEvents,
  listParentContexts,
  loadParentContext,
  recordEvent,
  recordObservation,
} = require('./lib/dispatch');
const {
  SAFE_REFUSALS, exitCodeForError, failureBody, publicErrorMessage, safeDetails, safeString,
} = require('./lib/public-error');
const {
  ABANDONABLE_OPERATION_TYPES, abandonPendingLaneOperation,
  listOperations, pendingOperationForLane, requireOwnedLane, resolveProject,
  settleTerminalLaneOperationPointer, withLaneLease,
} = require('./lib/state');

const MAX_INPUT_BYTES = 64 * 1024;
// Provider registry: a new provider is one adapter module listed here. Each
// adapter publishes a descriptor naming its operations and the provider flags
// it accepts, so no operation below branches on a provider by name.
const PROVIDERS = new Map([codex, claude].map((adapter) => [
  adapter.descriptor.target, { ...adapter.descriptor, adapter },
]));
const TARGETS = [...PROVIDERS.keys()];
const PROVIDER_FLAGS = ['url', 'claude-bin', 'private-archive', 'finish-retirements', 'allow-protocol-only'];

function providerForTarget(target) {
  return PROVIDERS.get(target) || null;
}

// Refuse a provider flag on a provider that does not accept it, naming the
// providers that do.
function rejectForeignFlags(provider, values, context) {
  for (const flag of PROVIDER_FLAGS) {
    if (values[flag] === undefined || provider.options.has(flag)) continue;
    const accepting = [...PROVIDERS.values()]
      .filter((entry) => entry.options.has(flag)).map((entry) => entry.target).join('|') || 'no';
    usage(`--${flag} is valid only for ${accepting} ${context}`);
  }
}

function providerForBackend(backend) {
  for (const provider of PROVIDERS.values()) {
    if (provider.backend === backend) return provider;
  }
  return null;
}
const HELP = `usage: lane.js <operation> [options]

operations:
  parent-init --host-provider <slug> --host-app <slug> --name <parent task>
              [--native-task-ref <private-ref>]
  parent-list
  capabilities --target codex|claude
  spawn      --target codex|claude --name <summary> (--input <text> | --input-file <absolute|->)
             --parent-context-file <absolute>
             [--cwd <absolute>] [--worktrees <absolute> (or WORKTREES)]
             [--intent <intent>] [--model <provider-model>] [--effort <level>]
             [--speed standard|fast] [--allow-protocol-only]
  children   --parent-context-file <absolute>
  wait       --parent-context-file <absolute> [--after <sequence>] [--timeout-ms <0..60000>]
             [--url <loopback-ws-url>] [--claude-bin <absolute-path>]
  ack        --parent-context-file <absolute> --event <event-id>
  steer      --lane <lane-id> (--input <text> | --input-file <absolute|->)
  status     --lane <lane-id>
  interrupt  --lane <lane-id>                         Codex only
  stop       --lane <lane-id>                         Claude only
  recover    --lane <lane-id> [--input <text> | --input-file <absolute|->]
             Codex input starts one boundary turn; Claude recovery accepts no input
  retire     --lane <lane-id> --harvested-output-sha256 <sha256>
             [--private-archive] [--no-cleanup-worktree]
             [--accept-manual-seat-removal]   after an owner-removed blocked seat
  reconcile  --target codex|claude [--lane <lane-id>]
             [--finish-retirements] [--private-archive] [--no-cleanup-worktree]
  abandon    --lane <lane-id> --reason <text>
             Owner-authorized: closes a stranded pending spawn, steer, stop, recover,
             resume, or interrupt as failed with an unknown provider outcome

provider options:
  --url <loopback-ws-url>       Codex only (or TRANSMOGRIFY_URL)
  --claude-bin <absolute-path>  Claude only (or CLAUDE_BIN)
  --timeout-ms <100..600000>    bound each provider request of a lane operation

exit codes (shared by every Transmogrify command):
  0  confirmed result
  2  usage error or safe refusal; nothing was attempted
  3  failure or uncertain outcome after an attempt; observe before retrying
  1  unexpected internal error

--private-archive and --finish-retirements are Claude-only. Repository-bound
operations accept --repo-root or REPO_ROOT; parent-init, parent-list,
capabilities, and ack do not require it. Run the installed SKILL.md workflow
before using mutating operations. Spawn canonicalizes native task names to
::: <summary>.`;
const OPERATIONS = new Set([
  'parent-init',
  'parent-list',
  'capabilities',
  'spawn',
  'children',
  'wait',
  'ack',
  'steer',
  'status',
  'interrupt',
  'stop',
  'recover',
  'retire',
  'reconcile',
  'abandon',
]);
const OPERATION_OPTIONS = {
  'parent-init': new Set([
    'host-provider', 'host-app', 'name', 'native-task-ref',
  ]),
  'parent-list': new Set(),
  capabilities: new Set(['target', 'url', 'claude-bin']),
  spawn: new Set([
    'repo-root', 'target', 'name', 'input', 'input-file', 'cwd', 'worktrees',
    'url', 'claude-bin', 'parent-context-file', 'intent', 'model', 'effort', 'speed',
    'allow-protocol-only', 'timeout-ms',
  ]),
  children: new Set(['repo-root', 'parent-context-file']),
  wait: new Set([
    'repo-root', 'parent-context-file', 'after', 'timeout-ms', 'url', 'claude-bin',
  ]),
  ack: new Set(['parent-context-file', 'event']),
  steer: new Set(['repo-root', 'lane', 'input', 'input-file', 'url', 'claude-bin', 'timeout-ms']),
  status: new Set(['repo-root', 'lane', 'url', 'claude-bin', 'timeout-ms']),
  abandon: new Set(['repo-root', 'lane', 'reason']),
  interrupt: new Set(['repo-root', 'lane', 'url', 'timeout-ms']),
  stop: new Set(['repo-root', 'lane', 'claude-bin', 'timeout-ms',
  ]),
  recover: new Set(['repo-root', 'lane', 'input', 'input-file', 'url', 'claude-bin', 'timeout-ms',
  ]),
  retire: new Set([
    'repo-root', 'lane', 'url', 'claude-bin', 'private-archive',
    'no-cleanup-worktree', 'accept-manual-seat-removal', 'harvested-output-sha256', 'timeout-ms',
  ]),
  reconcile: new Set([
    'repo-root', 'target', 'lane', 'url', 'claude-bin', 'private-archive',
    'finish-retirements', 'no-cleanup-worktree', 'timeout-ms',
  ]),
};
function usage(message) {
  const error = new Error(message);
  error.code = 'USAGE_ERROR';
  throw error;
}

// Caller input must be strict UTF-8 without NUL or unpaired surrogates, so a
// prompt cannot carry an unencodable byte to a provider.
function decodeInput(buffer, label) {
  let value;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch {
    usage(`${label} must be valid UTF-8`);
  }
  if (value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) {
    usage(`${label} must not contain NUL or unpaired surrogates`);
  }
  return value;
}

// Read at most the input bound from a descriptor, refusing anything longer
// rather than silently truncating it.
function readBounded(descriptor, label) {
  const chunks = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(16 * 1024, MAX_INPUT_BYTES + 1 - total));
    const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_INPUT_BYTES) usage(`${label} exceeds ${MAX_INPUT_BYTES} bytes`);
    chunks.push(chunk.subarray(0, count));
  }
  return decodeInput(Buffer.concat(chunks), label);
}

// Resolve --input, or --input-file with - for stdin, into one bounded string. A
// file must be absolute, owner-controlled, non-symlinked, and regular.
function readInput(values) {
  if (values.input !== undefined && values['input-file'] !== undefined) {
    usage('use either --input or --input-file, not both');
  }
  if (values.input !== undefined) {
    if (Buffer.byteLength(values.input, 'utf8') > MAX_INPUT_BYTES) {
      usage(`inline input exceeds ${MAX_INPUT_BYTES} bytes`);
    }
    if (values.input.includes('\0') || /[\uD800-\uDFFF]/u.test(values.input)) {
      usage('inline input must not contain NUL or unpaired surrogates');
    }
    return values.input;
  }
  if (values['input-file'] === undefined) return undefined;
  if (values['input-file'] === '-') return readBounded(0, 'stdin input');
  if (!path.isAbsolute(values['input-file'])) usage('--input-file must be absolute or -');
  let descriptor;
  try {
    descriptor = fs.openSync(
      values['input-file'],
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        (stat.mode & 0o022) !== 0) {
      usage('--input-file must be a safe bounded regular file');
    }
    return readBounded(descriptor, 'input file');
  } catch (error) {
    if (error.code === 'USAGE_ERROR') throw error;
    usage('--input-file must be a safe bounded regular file');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

// The adapter that owns a lane, chosen from the durable record's backend. An
// unowned lane is NOT_OWNED and an unknown backend is ADAPTER_MISMATCH.
function providerForLane(repoRoot, laneId, env) {
  let lane;
  try { lane = requireOwnedLane(repoRoot, laneId, env); } catch (error) {
    if (/^NOT_OWNED:/.test(error.message)) error.code = 'NOT_OWNED';
    throw error;
  }
  const provider = providerForBackend(lane.backend);
  if (provider) return provider;
  const error = new Error(`unsupported lane backend ${lane.backend}`);
  error.code = 'ADAPTER_MISMATCH';
  throw error;
}

// Provider-advertised catalogs, selection guides, and immutable execution
// profiles are public metadata: their `id`, `name`, and source fields are not
// provider control handles, so key stripping stops at these subtrees while
// string redaction still applies.
const PROJECTION_EXEMPT_KEYS = new Set([
  'catalog',
  'executionProfile',
  'guidance',
  'intents',
  'observedProfile',
  'requestedProfile',
  'resolvedProfile',
  'selectionGuide',
]);
const PRIVATE_RESULT_KEYS = new Set([
  'agent',
  'bridgeId',
  'completedTurnId',
  'codexHome',
  'cwd',
  'endpoint',
  'error',
  'expectedTurnId',
  'file',
  'id',
  'jobId',
  'log',
  'message',
  'name',
  'observedTurnId',
  'path',
  'pid',
  'pids',
  'providerId',
  'providerIdentity',
  'repoRoot',
  'gitCommonDir',
  'recoveredTurnId',
  'runtime',
  'sessionId',
  'socket',
  'stderr',
  'stdout',
  'transcript',
  'turnId',
  'url',
  'userAgent',
]);

// Parse an integer option inside explicit bounds. Anything else is a usage error
// rather than a clamped value.
function boundedInteger(value, label, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) usage(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    usage(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

// The public view of one dispatch, carrying its lane state or, when the lane
// cannot be resolved, why.
function dispatchSummary(dispatch, resolved = { lane: null, reason: 'missing' }) {
  const lane = resolved.lane;
  return {
    dispatchId: dispatch.dispatchId,
    laneId: dispatch.child.laneId,
    target: dispatch.child.targetProvider,
    displayName: dispatch.child.displayName,
    state: lane?.state || dispatch.state,
    ...(lane ? {} : { laneObservation: resolved.reason }),
    createdAt: dispatch.createdAt,
    requestedProfile: dispatch.requestedProfile,
    resolvedProfile: dispatch.resolvedProfile,
    observedProfile: dispatch.observedProfile,
  };
}

// Whether a lane lookup failed because its repository or registry is gone rather
// than because the lane is not owned.
function repositoryUnavailable(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ||
    /not a git repository|ownership registry does not exist|REPO_ROOT must be/.test(error?.message || '');
}

// Resolve the exact owned lane behind a dispatch. `lane` is null when the lane
// record is missing (`reason: 'missing'`) or when its repository can no longer
// be resolved (`reason: 'repository-unavailable'`); both are observed as
// attention conditions instead of failing the whole parent.
function resolveDispatchLane(dispatch, env) {
  let lane;
  try { lane = requireOwnedLane(dispatch.child.repoRoot, dispatch.child.laneId, env); } catch (error) {
    if (/^NOT_OWNED:/.test(error.message)) return { lane: null, reason: 'missing' };
    if (repositoryUnavailable(error)) return { lane: null, reason: 'repository-unavailable' };
    throw error;
  }
  const expectedBackend = providerForTarget(dispatch.child.targetProvider)?.backend ?? null;
  if (!lane.lineage || lane.lineage.dispatchId !== dispatch.dispatchId ||
      lane.lineage.parentRef !== dispatch.parentRef ||
      lane.lineage.installationId !== dispatch.installationId ||
      lane.backend !== dispatch.child.backend || lane.backend !== expectedBackend ||
      lane.target !== dispatch.child.targetProvider ||
      lane.displayName !== dispatch.child.displayName) {
    const error = new Error('dispatch lineage does not match the exact owned lane');
    error.code = 'NOT_OWNED';
    throw error;
  }
  return { lane, reason: null };
}

function laneForDispatch(dispatch, env) {
  return resolveDispatchLane(dispatch, env).lane;
}

// The one completed spawn journal for this dispatch, used to emit the spawned
// event a crashed launch never recorded. Two matches is invalid local state.
function completedSpawnOperation(dispatch, lane, env) {
  if (!lane?.providerId) return null;
  const matches = listOperations(dispatch.child.repoRoot, env).filter((operation) =>
    operation.type === 'spawn' && operation.state === 'complete' &&
    operation.laneId === lane.laneId && operation.providerId === lane.providerId &&
    operation.details?.dispatchId === dispatch.dispatchId
  );
  if (matches.length > 1) {
    const error = new Error('multiple completed spawn receipts match one dispatch');
    error.code = 'INVALID_LOCAL_STATE';
    throw error;
  }
  return matches[0] || null;
}

// The one terminal spawn journal for a dispatch whose lane never bound a
// provider: a proven failure rather than an unknown.
function terminalUnstartedSpawnOperation(dispatch, lane, env) {
  if (lane?.providerId) return null;
  const matches = listOperations(dispatch.child.repoRoot, env).filter((operation) =>
    operation.type === 'spawn' && ['failed', 'notDelivered'].includes(operation.state) &&
    operation.laneId === lane.laneId && operation.details?.dispatchId === dispatch.dispatchId
  );
  if (matches.length > 1) {
    const error = new Error('multiple terminal spawn receipts match one dispatch');
    error.code = 'INVALID_LOCAL_STATE';
    throw error;
  }
  return matches[0] || null;
}

// Derive at most one child event from durable local state alone: a completed or
// terminal spawn journal, a retirement phase needing attention, or a
// delivery-unknown lane. It contacts no provider and never invents an event for
// an open spawn journal.
function localEventForLane(dispatch, lane, env) {
  if (!lane) return null;
  const spawnOperation = completedSpawnOperation(dispatch, lane, env);
  if (spawnOperation) {
    recordEvent({
      dispatchId: dispatch.dispatchId,
      type: 'child.spawned',
      fingerprint: `spawn-complete:${spawnOperation.operationId}:${lane.providerId}`,
      data: { state: 'spawned' },
    }, env);
  }
  const unstartedSpawn = terminalUnstartedSpawnOperation(dispatch, lane, env);
  if (unstartedSpawn) {
    return recordObservation({
      dispatchId: dispatch.dispatchId,
      phase: 'failed',
      providerFingerprint: `spawn-terminal:${unstartedSpawn.operationId}:${unstartedSpawn.state}`,
      eventType: 'child.failed',
      data: { state: 'failed' },
    }, env).event;
  }
  const pending = pendingOperationForLane(dispatch.child.repoRoot, lane.laneId, env);
  if (pending?.type === 'retire') {
    if (pending.state === 'providerRetiredCleanupBlocked') {
      return recordObservation({
        dispatchId: dispatch.dispatchId,
        phase: 'cleanup-blocked',
        providerFingerprint: `retire:${pending.operationId}:${pending.state}`,
        eventType: 'child.cleanup-blocked',
        data: { state: 'cleanup-blocked' },
      }, env).event;
    }
    if (['providerRetiredCleanupDeferred', 'cleanupDeferred', 'localRemovalUnknown']
      .includes(pending.state)) {
      return recordObservation({
        dispatchId: dispatch.dispatchId,
        phase: 'needs-attention',
        providerFingerprint: `retire:${pending.operationId}:${pending.state}`,
        eventType: 'child.needs-attention',
        data: { state: 'needs-attention' },
      }, env).event;
    }
    if (['providerRetired', 'remoteArchived', 'worktreeRemoved',
      'localRemovalDispatching', 'localRemovalDispatched', 'localRemoved']
      .includes(pending.state)) {
      return recordObservation({
        dispatchId: dispatch.dispatchId,
        phase: 'needs-attention',
        providerFingerprint: `retire:${pending.operationId}:${pending.state}`,
        eventType: 'child.needs-attention',
        data: { state: 'needs-attention' },
      }, env).event;
    }
  }
  const terminal = new Map([
    ['deliveryUnknown', ['delivery-unknown', 'child.delivery-unknown']],
    ['archiveUnknown', ['delivery-unknown', 'child.delivery-unknown']],
  ]).get(lane.state);
  if (!terminal && !pending && ['archivedVerified', 'logicallyRetired', 'worktreeRemoved']
    .includes(lane.state)) {
    return recordObservation({
      dispatchId: dispatch.dispatchId,
      phase: 'retired',
      providerFingerprint: `retired:${lane.state}:${lane.updatedAt}`,
      eventType: 'child.retired',
      data: { state: 'retired' },
    }, env).event;
  }
  if (!terminal) return null;
  // An open spawn journal is reported once by the unresolved-spawn path after
  // non-replaying reconciliation; reporting it here as well would alternate
  // observation phases and re-notify the parent on every wait.
  if (pending?.type === 'spawn') return null;
  const [phase, eventType] = terminal;
  return recordObservation({
    dispatchId: dispatch.dispatchId,
    phase,
    providerFingerprint: `${lane.state}:${lane.turnId || 'none'}:${pending?.operationId || 'none'}`,
    eventType,
    data: { state: phase },
  }, env).event;
}

// Reconcile a child's open spawn journal through its own adapter, without
// replaying the launch. Returns the refreshed lane.
async function reconcilePendingSpawnDispatch(dispatch, lane, values, env, timeoutMs) {
  const pending = pendingOperationForLane(dispatch.child.repoRoot, lane.laneId, env);
  if (pending?.type !== 'spawn') return lane;
  const options = {
    repoRoot: dispatch.child.repoRoot,
    laneId: lane.laneId,
    url: values.url || lane.runtime?.endpoint,
    claudeBin: values['claude-bin'],
    timeoutMs,
    commandTimeoutMs: timeoutMs,
  };
  try {
    await providerForBackend(lane.backend).adapter.reconcile(options, env);
  } catch (error) {
    // Exhausting this child's share of the wait budget is not an observation
    // failure: the journal is unchanged and the next round retries.
    if (error.code !== 'TIMEOUT') throw error;
  }
  return requireOwnedLane(dispatch.child.repoRoot, lane.laneId, env);
}

// Observe one child and record at most one event for it. A dispatch whose lane
// stays unresolvable past a grace period becomes an attention event rather than
// a failure of the whole parent.
async function observeDispatch(dispatch, values, env, deadline, remainingChildren) {
  const resolved = resolveDispatchLane(dispatch, env);
  let lane = resolved.lane;
  if (!lane) {
    const ageMs = Date.now() - Date.parse(dispatch.createdAt);
    if (Number.isFinite(ageMs) && ageMs >= 30_000) {
      const unavailable = resolved.reason === 'repository-unavailable';
      const attention = unavailable || dispatch.state === 'reserved';
      const observation = recordObservation({
        dispatchId: dispatch.dispatchId,
        phase: attention ? 'needs-attention' : 'delivery-unknown',
        providerFingerprint: unavailable
          ? `repository-unavailable:${dispatch.child.repoRoot}`
          : `missing-lane:${dispatch.state}:${dispatch.createdAt}`,
        eventType: attention ? 'child.needs-attention' : 'child.delivery-unknown',
        data: { state: attention ? 'needs-attention' : 'delivery-unknown' },
      }, env);
      return { lane: null, event: observation.event };
    }
    return { lane: null, event: null };
  }
  const terminalPending = pendingOperationForLane(
    dispatch.child.repoRoot,
    lane.laneId,
    env,
  );
  const locallySettleable = terminalPending &&
    ['complete', 'failed', 'notDelivered'].includes(terminalPending.state) &&
    (terminalPending.type !== 'spawn' ||
      (terminalPending.state === 'complete' && Boolean(lane.providerId)));
  if (locallySettleable) {
    await withLaneLease(dispatch.child.repoRoot, lane.laneId, async () => {
      settleTerminalLaneOperationPointer(dispatch.child.repoRoot, lane.laneId, env);
    }, env);
    lane = laneForDispatch(dispatch, env);
  }
  let localEvent = localEventForLane(dispatch, lane, env);
  if (localEvent) return { lane, event: localEvent };
  let pending = pendingOperationForLane(dispatch.child.repoRoot, lane.laneId, env);
  if (pending?.type === 'spawn') {
    const spawnRemainingMs = deadline - Date.now();
    if (spawnRemainingMs < 100) return { lane, event: null };
    const spawnBudget = Math.max(
      100,
      Math.floor(spawnRemainingMs / Math.max(1, remainingChildren * 4)),
    );
    lane = await reconcilePendingSpawnDispatch(dispatch, lane, values, env, spawnBudget);
    localEvent = localEventForLane(dispatch, lane, env);
    if (localEvent) return { lane, event: localEvent };
    pending = pendingOperationForLane(dispatch.child.repoRoot, lane.laneId, env);
    if (pending?.type === 'spawn') {
      // The spawn journal is still open after non-replaying reconciliation:
      // wake the parent exactly once per journal state instead of going silent.
      const observation = recordObservation({
        dispatchId: dispatch.dispatchId,
        phase: 'needs-attention',
        providerFingerprint: `spawn-unresolved:${pending.operationId}:${pending.state}`,
        eventType: 'child.needs-attention',
        data: { state: 'needs-attention' },
      }, env);
      return { lane, event: observation.event };
    }
  }
  if (['deliveryUnknown', 'archiveUnknown'].includes(lane.state) ||
      (!pendingOperationForLane(dispatch.child.repoRoot, lane.laneId, env) &&
       ['archivedVerified', 'logicallyRetired', 'worktreeRemoved'].includes(lane.state))) {
    return { lane, event: localEvent };
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs < 100) return { lane, event: null };
  const requestBudget = Math.max(100, Math.floor(remainingMs / Math.max(1, remainingChildren * 4)));
  if (!lane.providerId) return { lane, event: null };
  const options = {
    repoRoot: dispatch.child.repoRoot,
    laneId: lane.laneId,
    url: values.url || lane.runtime?.endpoint,
    claudeBin: values['claude-bin'],
    timeoutMs: requestBudget,
    commandTimeoutMs: requestBudget,
  };
  const provider = providerForBackend(lane.backend);
  const result = await provider.adapter.status(options, env);
  lane = requireOwnedLane(dispatch.child.repoRoot, lane.laneId, env);
  let phase = result.phase;
  let eventType = null;
  let providerFingerprint;
  const data = { state: lane.state };
  if (provider.target === 'codex') {
    const turn = result.turn;
    providerFingerprint = `turn:${turn?.id || 'none'}:${turn?.status || phase}`;
    phase = phase === 'executing' ? 'working' : phase;
    if (turn && ['completed', 'interrupted', 'failed'].includes(turn.status)) {
      eventType = turn.status === 'failed' ? 'child.failed' : 'child.turn-completed';
      phase = turn.status === 'failed' ? 'failed' : 'idle';
      data.status = turn.status;
    } else if (phase === 'idle') {
      eventType = 'child.idle-observed';
    }
  } else {
    const epoch = lane.providerIdentity?.executionEpochs?.at(-1);
    providerFingerprint = `epoch:${epoch?.epochId || 'none'}:${phase}`;
    if (phase === 'waiting') eventType = 'child.needs-attention';
    else if (phase === 'idle') eventType = 'child.idle-observed';
    else if (phase === 'stopped') eventType = 'child.stopped';
    else if (phase === 'failed') eventType = 'child.failed';
  }
  const observation = recordObservation({
    dispatchId: dispatch.dispatchId,
    phase,
    providerFingerprint,
    eventType,
    data: eventType ? {
      state: phase,
      ...(data.status ? { status: data.status } : {}),
    } : {},
  }, env);
  return { lane, event: observation.event };
}

// One observation round over every outstanding child, collecting per-child
// errors instead of aborting the round.
async function observeParentChildren(context, values, env, deadline) {
  const dispatches = listDispatches(context, env)
    .filter((dispatch) => !values['repo-root'] || dispatch.child.repoRoot === values['repo-root']);
  const errors = [];
  // Observe every outstanding child each round; the durable event store is
  // read afterwards, so one busy child cannot starve a later child's event.
  for (let index = 0; index < dispatches.length; index += 1) {
    if (Date.now() >= deadline) break;
    const dispatch = dispatches[index];
    try {
      await observeDispatch(dispatch, values, env, deadline, dispatches.length - index);
    } catch (error) {
      errors.push({ dispatchId: dispatch.dispatchId, code: error.code || 'OBSERVATION_FAILED' });
    }
  }
  return { dispatches, errors };
}

// Bounded parent wait: return pending events immediately, otherwise observe
// every child and check again until the deadline. Expiry is NO_EVENT, and
// unacknowledged events stay pending rather than being consumed here.
async function waitForParentEvent(context, values, env) {
  const timeoutMs = boundedInteger(values['timeout-ms'], '--timeout-ms', 0, 60_000, 60_000);
  const after = boundedInteger(values.after, '--after', 0, Number.MAX_SAFE_INTEGER, 0);
  const deadline = Date.now() + timeoutMs;
  const project = values['repo-root'] ? resolveProject(values['repo-root']) : null;
  const observationValues = project ? { ...values, 'repo-root': project.root } : values;
  const projectKey = project ? digest(project.commonDir) : undefined;
  const eventOptions = { after, projectKey };
  while (true) {
    let events = listEvents(context, eventOptions, env);
    if (events.length > 0) return { version: 1, ok: true, operation: 'wait', events };
    if (Date.now() >= deadline) {
      const error = new Error('bounded child wait expired without an event');
      error.code = 'NO_EVENT';
      error.details = { attempted: 0 };
      throw error;
    }
    const observed = await observeParentChildren(context, observationValues, env, deadline);
    events = listEvents(context, eventOptions, env);
    if (events.length > 0) {
      return { version: 1, ok: true, operation: 'wait', events, observerErrors: observed.errors };
    }
    if (observed.errors.length > 0) {
      const error = new Error('one or more exact child observations failed');
      error.code = 'OBSERVATION_FAILED';
      error.details = {
        attempted: observed.dispatches.length,
        failures: observed.errors.map((entry) => ({ dispatchId: entry.dispatchId, code: entry.code })),
      };
      throw error;
    }
    if (Date.now() >= deadline) {
      const error = new Error('bounded child wait expired without an event');
      error.code = 'NO_EVENT';
      error.details = { attempted: observed.dispatches.length };
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
  }
}

// Project a successful result for public output: strip provider control handles
// and redact every string, stopping key stripping inside the exempt metadata
// subtrees while still redacting their strings.
function publicSuccess(value, exempt = false) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => publicSuccess(entry, exempt));
  if (typeof value === 'string') return safeString(value);
  if (typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => exempt || !PRIVATE_RESULT_KEYS.has(key))
    .map(([key, nested]) => [
      key,
      publicSuccess(nested, exempt || PROJECTION_EXEMPT_KEYS.has(key)),
    ]));
}

// Owner-authorized closure of a stranded pending operation. The journal is
// settled as failed with an abandonment receipt; nothing is claimed about the
// provider, so the projection reports providerOutcome unknown and the lane keeps
// any provider identity it already bound.
function abandonLaneOperation(repoRoot, values, env) {
  if (typeof values.reason !== 'string' || !values.reason.trim()) usage('abandon requires --reason');
  const pending = pendingOperationForLane(repoRoot, values.lane, env);
  if (!pending) {
    const error = new Error(`lane ${values.lane} has no pending operation`);
    error.code = 'NO_PENDING_OPERATION';
    throw error;
  }
  if (!ABANDONABLE_OPERATION_TYPES.has(pending.type)) {
    const error = new Error(`a ${pending.type} operation cannot be abandoned`);
    error.code = 'ABANDON_REFUSED';
    error.details = { pendingType: pending.type, pendingState: pending.state };
    throw error;
  }
  const { operation, lane } = abandonPendingLaneOperation(
    repoRoot, values.lane, { reason: values.reason }, env,
  );
  return {
    version: 1,
    ok: true,
    operation: 'abandon',
    laneId: lane.laneId,
    lane: { laneId: lane.laneId, state: lane.state, backend: lane.backend },
    abandoned: {
      operationId: operation.operationId,
      type: operation.type,
      fromState: operation.details.abandoned.fromState,
      reason: operation.details.abandoned.reason,
      at: operation.details.abandoned.at,
    },
    providerOutcome: 'unknown',
    delivery: { providerMutation: 'unknown' },
  };
}

// Each operation accepts only its own options, so a flag is never silently
// ignored on the wrong command.
function validateOptionGrammar(operation, usedOptions) {
  const allowed = OPERATION_OPTIONS[operation];
  for (const option of usedOptions) {
    if (!allowed.has(option)) usage(`--${option} is not valid for ${operation}`);
  }
}

// The public delivery projection for a failure. An adapter that reported exact
// per-phase outcomes keeps them; otherwise only a proven refusal is
// notAttempted and everything else defaults to unknown.
function errorEffect(code, details = {}) {
  if (['verified', 'unknown'].includes(details?.providerMutation) &&
      ['verified', 'notAttempted', 'unknown'].includes(details.stop || 'verified') &&
      ['verified', 'notAttempted', 'unknown'].includes(details.archive || 'verified') &&
      ['verified', 'blocked', 'retryable'].includes(details.cleanup || 'verified') &&
      ['verified', 'notAttempted', 'unknown'].includes(details.localRemoval || 'verified')) {
    return {
      providerMutation: details.providerMutation,
      ...(details.stop ? { stop: details.stop } : {}),
      ...(details.archive ? { archive: details.archive } : {}),
      ...(details.cleanup ? { cleanup: details.cleanup } : {}),
      ...(details.localRemoval ? { localRemoval: details.localRemoval } : {}),
    };
  }
  if (code === 'CLEANUP_BLOCKED') {
    return { providerMutation: 'verified', cleanup: 'blocked' };
  }
  if (code === 'CLEANUP_RETRYABLE') {
    return { providerMutation: 'verified', cleanup: 'retryable' };
  }
  if (code === 'NOT_DELIVERED' || SAFE_REFUSALS.has(code) || code === 'USAGE_ERROR') {
    return { providerMutation: 'notAttempted' };
  }
  if (code === 'FORKED_COPY' || /UNCERTAIN|UNKNOWN|PARTIAL/.test(code || '')) {
    return { providerMutation: 'unknown' };
  }
  return { providerMutation: 'unknown' };
}

// Exit status for a fleet result carrying per-lane outcomes: 0 when all are
// confirmed, 2 when the only incomplete entries are safe refusals or deferrals,
// and 3 as soon as one entry is uncertain.
function resultExitCode(result) {
  if (result?.ok !== false) return 0;
  const entries = [
    ...(Array.isArray(result.results) ? result.results : []),
    ...(Array.isArray(result.recovered) ? result.recovered : []),
  ];
  const safeIncompleteOutcomes = new Set([
    'cleanupRetryable', 'differentRuntime', 'retirementPending',
  ]);
  let foundIncomplete = false;
  for (const entry of entries) {
    if (entry?.skipped === 'differentRuntime' || safeIncompleteOutcomes.has(entry?.outcome)) {
      foundIncomplete = true;
      continue;
    }
    if (entry?.error || entry?.delivery === 'unknown' ||
        /Unknown$|Pending$|uncertain/i.test(entry?.outcome || '')) {
      foundIncomplete = true;
      if (!SAFE_REFUSALS.has(entry?.code)) return 3;
    }
  }
  return foundIncomplete ? 2 : 3;
}

// Parse and dispatch one operation. Every path returns a projected result, and
// the caller turns it into output and an exit status.
async function main(argv, env = process.env) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    return { help: HELP };
  }
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    tokens: true,
    options: {
      'repo-root': { type: 'string' },
      lane: { type: 'string' },
      target: { type: 'string' },
      name: { type: 'string' },
      'host-provider': { type: 'string' },
      'host-app': { type: 'string' },
      'native-task-ref': { type: 'string' },
      'parent-context-file': { type: 'string' },
      event: { type: 'string' },
      after: { type: 'string' },
      'timeout-ms': { type: 'string' },
      reason: { type: 'string' },
      input: { type: 'string' },
      'input-file': { type: 'string' },
      cwd: { type: 'string' },
      worktrees: { type: 'string' },
      url: { type: 'string' },
      'claude-bin': { type: 'string' },
      model: { type: 'string' },
      intent: { type: 'string' },
      effort: { type: 'string' },
      speed: { type: 'string' },
      'allow-protocol-only': { type: 'boolean' },
      'private-archive': { type: 'boolean' },
      'accept-manual-seat-removal': { type: 'boolean' },
      'finish-retirements': { type: 'boolean' },
      'no-cleanup-worktree': { type: 'boolean' },
      'harvested-output-sha256': { type: 'string' },
    },
  });
  if (parsed.positionals.length !== 1 || !OPERATIONS.has(parsed.positionals[0])) {
    usage(`operation must be one of: ${[...OPERATIONS].join(', ')}`);
  }
  const operation = parsed.positionals[0];
  const values = parsed.values;
  validateOptionGrammar(
    operation,
    new Set(parsed.tokens.filter((token) => token.kind === 'option').map((token) => token.name)),
  );
  if (operation === 'parent-init') {
    if (!values['host-provider'] || !values['host-app'] || !values.name) {
      usage('parent-init requires --host-provider, --host-app, and --name');
    }
    const created = createParentContext({
      hostProvider: values['host-provider'],
      hostApp: values['host-app'],
      displayName: values.name,
      nativeTaskRef: values['native-task-ref'],
    }, env);
    return {
      version: 1,
      ok: true,
      operation: 'parent-init',
      parentRef: created.parent.parentRef,
      contextFile: created.file,
      hostProvider: created.parent.hostProvider,
      hostApp: created.parent.hostApp,
      displayName: created.parent.displayName,
    };
  }
  if (operation === 'parent-list') {
    const parents = listParentContexts(env).map((context) => ({
      parentRef: context.parent.parentRef,
      contextFile: context.file,
      hostProvider: context.parent.hostProvider,
      hostApp: context.parent.hostApp,
      displayName: context.parent.displayName,
      createdAt: context.parent.createdAt,
      children: listDispatches(context, env).length,
      unacknowledgedEvents: countEvents(context, {}, env),
    }));
    return { version: 1, ok: true, operation: 'parent-list', parents };
  }
  if (operation === 'capabilities') {
    if (!TARGETS.includes(values.target)) {
      usage('capabilities requires --target codex|claude');
    }
    const provider = providerForTarget(values.target);
    rejectForeignFlags(provider, values, 'capabilities');
    const { adapter } = provider;
    if (typeof adapter.executionCapabilities !== 'function') {
      usage(`${values.target} execution capabilities are unavailable`);
    }
    return adapter.executionCapabilities({ url: values.url, claudeBin: values['claude-bin'] }, env);
  }
  if (operation === 'spawn') {
    if (!TARGETS.includes(values.target)) usage('spawn requires --target codex|claude');
    rejectForeignFlags(providerForTarget(values.target), values, 'spawns');
  }
  const needsParent = ['spawn', 'children', 'wait', 'ack'].includes(operation);
  const parentContext = needsParent
    ? loadParentContext(values['parent-context-file'], env)
    : null;
  if (operation === 'children') {
    const repoFilter = values['repo-root'];
    if (repoFilter !== undefined && !path.isAbsolute(repoFilter)) usage('--repo-root must be absolute');
    const project = repoFilter ? resolveProject(repoFilter) : null;
    const children = listDispatches(parentContext, env)
      .filter((dispatch) => !project || dispatch.child.repoRoot === project.root)
      .map((dispatch) => dispatchSummary(dispatch, resolveDispatchLane(dispatch, env)));
    const projectKey = project ? digest(project.commonDir) : undefined;
    const unacknowledgedEvents = countEvents(parentContext, { projectKey }, env);
    return {
      version: 1,
      ok: true,
      operation: 'children',
      parentRef: parentContext.parent.parentRef,
      children,
      unacknowledgedEvents,
    };
  }
  if (operation === 'wait') return waitForParentEvent(parentContext, values, env);
  if (operation === 'ack') {
    if (!values.event) usage('ack requires --event');
    const acknowledgement = acknowledgeEvent(parentContext, values.event, env);
    return {
      version: 1,
      ok: true,
      operation: 'ack',
      eventId: acknowledgement.eventId,
      acknowledgedAt: acknowledgement.acknowledgedAt,
    };
  }
  const repoRoot = values['repo-root'] || env.REPO_ROOT;
  if (!repoRoot || !path.isAbsolute(repoRoot)) usage('--repo-root (or REPO_ROOT) must be absolute');
  const input = readInput(values);
  const timeoutMs = boundedInteger(values['timeout-ms'], '--timeout-ms', 100, 600_000, undefined);
  const options = {
    repoRoot,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    laneId: values.lane,
    name: values.name,
    input,
    message: input,
    cwd: values.cwd,
    worktrees: values.worktrees,
    url: values.url,
    claudeBin: values['claude-bin'],
    model: values.model,
    intent: values.intent,
    effort: values.effort,
    speed: values.speed,
    allowProtocolOnly: values['allow-protocol-only'] === true,
    parentContext,
    privateArchive: values['private-archive'],
    acceptManualSeatRemoval: values['accept-manual-seat-removal'],
    finishRetirements: values['finish-retirements'],
    cleanupWorktree: !values['no-cleanup-worktree'],
    harvestedOutputSha256: values['harvested-output-sha256'],
  };

  if (operation === 'spawn') {
    return providerForTarget(values.target).adapter.spawn(options, env);
  }
  if (operation === 'reconcile') {
    if (!TARGETS.includes(values.target)) usage('reconcile requires --target codex|claude');
    const provider = providerForTarget(values.target);
    rejectForeignFlags(provider, values, 'reconciliation');
    const result = await provider.adapter.reconcile(options, env);
    return { ...result, operation: 'reconcile' };
  }
  if (!values.lane) usage(`${operation} requires --lane`);
  const provider = providerForLane(repoRoot, values.lane, env);
  rejectForeignFlags(provider, values, 'lanes');
  if (operation === 'abandon') return abandonLaneOperation(repoRoot, values, env);
  if (!provider.operations.has(operation)) usage(`${operation} is not supported by ${provider.target} lanes`);
  if (operation === 'recover' && input !== undefined && !provider.recoverAcceptsInput) {
    usage(`--input is not accepted by ${provider.target} recovery`);
  }
  return provider.adapter[operation](options, env);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((result) => {
    if (result?.help) {
      console.log(result.help);
      return;
    }
    console.log(JSON.stringify(publicSuccess(result), null, 2));
    process.exitCode = resultExitCode(result);
  }).catch((error) => {
    const code = error.code || 'OPERATOR_ERROR';
    const effect = errorEffect(code, error.details);
    const stageUnknown = Object.values(effect).includes('unknown');
    const body = failureBody(error, {
      delivery: stageUnknown ? 'unknown' :
        effect.providerMutation === 'verified' ? 'confirmed' :
          code === 'NOT_DELIVERED' ? 'notDelivered' : 'notAttempted',
      effect,
    });
    console.error(JSON.stringify(body, null, 2));
    process.exitCode = exitCodeForError(body.code);
  });
}

module.exports = {
  errorEffect,
  exitCodeForError,
  main,
  publicSuccess,
  publicErrorMessage,
  readInput,
  resultExitCode,
  safeDetails,
  safeString,
  validateOptionGrammar,
};
