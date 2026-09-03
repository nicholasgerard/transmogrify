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
  listOperations, pendingOperationForLane, requireOwnedLane, resolveProject,
  settleTerminalLaneOperationPointer, withLaneLease,
} = require('./lib/state');

const MAX_INPUT_BYTES = 64 * 1024;
// Provider registry: a new provider is one adapter module plus one entry here.
// Every adapter exposes spawn, status, steer, recover/reconcile, retire, and
// executionCapabilities; the fleet reconciliation entry point name differs
// per provider, so it is bound once in this table.
const PROVIDERS = new Map([
  ['codex', {
    target: 'codex',
    backend: 'codex-app-server',
    adapter: codex,
    reconcile: (options, env) => codex.recover(options, env),
  }],
  ['claude', {
    target: 'claude',
    backend: claude.BACKEND,
    adapter: claude,
    reconcile: (options, env) => claude.reconcile(options, env),
  }],
]);
const TARGETS = [...PROVIDERS.keys()];

function providerForTarget(target) {
  return PROVIDERS.get(target) || null;
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

provider options:
  --url <loopback-ws-url>       Codex only (or TRANSMOGRIFY_URL)
  --claude-bin <absolute-path>  Claude only (or CLAUDE_BIN)

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
    'allow-protocol-only',
  ]),
  children: new Set(['repo-root', 'parent-context-file']),
  wait: new Set([
    'repo-root', 'parent-context-file', 'after', 'timeout-ms', 'url', 'claude-bin',
  ]),
  ack: new Set(['parent-context-file', 'event']),
  steer: new Set(['repo-root', 'lane', 'input', 'input-file', 'url', 'claude-bin']),
  status: new Set(['repo-root', 'lane', 'url', 'claude-bin']),
  interrupt: new Set(['repo-root', 'lane', 'url']),
  stop: new Set(['repo-root', 'lane', 'claude-bin']),
  recover: new Set(['repo-root', 'lane', 'input', 'input-file', 'url', 'claude-bin']),
  retire: new Set([
    'repo-root', 'lane', 'url', 'claude-bin', 'private-archive',
    'no-cleanup-worktree', 'accept-manual-seat-removal', 'harvested-output-sha256',
  ]),
  reconcile: new Set([
    'repo-root', 'target', 'lane', 'url', 'claude-bin', 'private-archive',
    'finish-retirements', 'no-cleanup-worktree',
  ]),
};
// The only error-detail keys that reach public output. Everything else is
// dropped, so a provider handle cannot leak through a failure path.
const SAFE_DETAIL_KEYS = new Set([
  'alreadyStopped',
  'attempted',
  'archive',
  'causeCode',
  'causeMessage',
  'cleanup',
  'code',
  'copiesStopped',
  'correlatedCopies',
  'delivery',
  'exactSession',
  'dispatchId',
  'executionEpoch',
  'failures',
  'httpStatus',
  'laneId',
  'localRemoval',
  'operationId',
  'outcome',
  'ownerAction',
  'phase',
  'presentation',
  'providerMutation',
  'providerRetired',
  'queued',
  'removed',
  'state',
  'stop',
]);
// Codes that prove no provider mutation was attempted. They exit 2; every other
// code is projected as uncertain and exits 3.
const SAFE_REFUSALS = new Set([
  'ADAPTER_MISMATCH',
  'CLEANUP_BLOCKED',
  'CLEANUP_RETRYABLE',
  'EXECUTION_EPOCH_UNBOUND',
  'EXECUTION_PROFILE_UNSUPPORTED',
  'HARVEST_MISMATCH',
  'HARVEST_REQUIRED',
  'INVALID_STATE',
  'LANE_RETIRED',
  'LOCAL_LOCK_TIMEOUT',
  'NOT_DELIVERED',
  'NO_ACTIVE_TURN',
  'NO_EVENT',
  'NOT_OWNED',
  'LOCAL_STATE_LIMIT',
  'NATIVE_VISIBILITY_REQUIRED',
  'OPERATION_PENDING',
  'OWNERSHIP_MISMATCH',
  'PENDING_OPERATION',
  'PRIVATE_API_DISABLED',
  'PRIVATE_AUTH_REJECTED',
  'PRIVATE_AUTH_UNAVAILABLE',
  'PRIVATE_TRUST_REQUIRED',
  'RUNTIME_MISMATCH',
  'SEAT_MISMATCH',
  'TARGET_ACTIVE',
  'UNSUPPORTED_ENVIRONMENT',
  'UNVERIFIED_PRIVATE_VERSION',
  'UNVERIFIED_RUNTIME',
  'USAGE_ERROR',
]);
// Fixed public text per code. Routine CLI output never echoes a provider or
// local exception message.
const PUBLIC_ERROR_MESSAGES = new Map([
  ['ADAPTER_MISMATCH', 'lane backend does not support this operation'],
  ['CLEANUP_BLOCKED', 'provider retirement is verified; local cleanup remains blocked'],
  ['CLEANUP_RETRYABLE', 'provider retirement is verified; local cleanup failed safely and may be retried'],
  ['COMPLETION_UNKNOWN', 'lane launch is verified; completion observation is unknown'],
  ['DELIVERY_UNCERTAIN', 'provider delivery outcome is unknown'],
  ['EXECUTION_EPOCH_UNBOUND', 'live provider execution no longer matches the owned receipt'],
  ['EXECUTION_PROFILE_UNSUPPORTED', 'the requested model, effort, or speed is unsupported'],
  ['FORKED_COPY', 'recovery forked into a separate provider session; the fork this recovery created was stopped and the lane remains stopped'],
  ['HARVEST_MISMATCH', 'the supplied harvest receipt does not match the durable retirement receipt'],
  ['HARVEST_REQUIRED', 'retirement requires a durable harvested-output receipt'],
  ['HOST_CALLBACK_FAILED', 'lane launch is verified; the host launch callback failed'],
  ['INVALID_STATE', 'the owned lane is not in a valid state for this operation'],
  ['LANE_RETIRED', 'the owned lane is already retiring or retired'],
  ['LOCAL_REMOVAL_UNCERTAIN', 'local provider removal outcome is unknown'],
  ['NOT_DELIVERED', 'the provider mutation was not delivered'],
  ['NOT_OWNED', 'the requested lane is not owned by this operator installation'],
  ['NO_ACTIVE_TURN', 'the owned Codex lane has no active turn'],
  ['NO_EVENT', 'no child event was observed before the bounded timeout'],
  ['LOCAL_LOCK_TIMEOUT', 'the private operator state is locked by another live Transmogrify process; retry shortly'],
  ['LOCAL_STATE_LIMIT', 'the private operator state exceeded a bounded record limit'],
  ['NATIVE_VISIBILITY_REQUIRED', 'Codex spawn requires a native-visibility receipt (Codex Desktop attached to the selected runtime; see desktop-attach.js) or explicit protocol-only authorization'],
  ['OBSERVATION_FAILED', 'one or more exact child lanes could not be observed safely'],
  ['OWNERSHIP_MISMATCH', 'live provider identity does not match the owned receipt'],
  ['PARENT_EVENT_UNRECORDED', 'lane launch is verified; the durable parent event could not be recorded'],
  ['OPERATION_PENDING', 'the owned lane has an unresolved operation'],
  ['PENDING_OPERATION', 'the owned lane has an unresolved operation'],
  ['PRIVATE_API_DISABLED', 'Claude retirement requires explicit private archive authorization'],
  ['PRIVATE_AUTH_REJECTED', 'Claude rejected the private archive credential'],
  ['PRIVATE_AUTH_UNAVAILABLE', 'Claude private archive authentication is unavailable'],
  ['PRIVATE_TRUST_REQUIRED', 'Claude private archival requires manual trusted-device enrollment'],
  ['REMOTE_CONTROL_UNAVAILABLE', 'the Claude session did not register Remote Control; check claude auth status, then stop and remove that session and reconcile'],
  ['PROTOCOL_ERROR', 'the provider returned an unverified protocol shape'],
  ['RECOVERY_UNCERTAIN', 'provider recovery outcome is unknown'],
  ['REMOTE_ARCHIVE_UNCERTAIN', 'remote provider archive outcome is unknown'],
  ['RUNTIME_MISMATCH', 'the provider runtime no longer matches the owned receipt'],
  ['SEAT_MISMATCH', 'the lane worktree no longer matches the owned receipt'],
  ['SPAWN_UNCERTAIN', 'provider spawn outcome is unknown'],
  ['STOP_UNCERTAIN', 'provider stop outcome is unknown'],
  ['TARGET_ACTIVE', 'the provider lane is still active'],
  ['TRANSPORT_UNKNOWN', 'provider transport outcome is unknown'],
  ['UNSUPPORTED_ENVIRONMENT', 'the local provider environment is unsupported'],
  ['UNVERIFIED_PRIVATE_VERSION', 'the installed Claude private surface is not pinned'],
  ['USAGE_ERROR', 'invalid operator request'],
]);

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
function adapterForLane(repoRoot, laneId, env) {
  let lane;
  try { lane = requireOwnedLane(repoRoot, laneId, env); } catch (error) {
    if (/^NOT_OWNED:/.test(error.message)) error.code = 'NOT_OWNED';
    throw error;
  }
  const provider = providerForBackend(lane.backend);
  if (provider) return provider.adapter;
  const error = new Error(`unsupported lane backend ${lane.backend}`);
  error.code = 'ADAPTER_MISMATCH';
  throw error;
}

// Redact bearer tokens, provider session and bridge ids, and credential-shaped
// query or key/value pairs from any string that reaches public output.
function safeString(value) {
  return value
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\b(?:session|cse)_[0-9A-Za-z_-]+\b/g, '[redacted-provider-id]')
    .replace(/([?&](?:token|secret|authorization|cookie|credential|api[-_]?key|password)=)[^&\s]+/gi,
      '$1[redacted]')
    .replace(/\b(token|secret|authorization|cookie|credential|api[-_ ]?key|password)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]');
}

// The fixed message for a code, with a generic fallback so an unmapped code
// still cannot print internal text.
function publicErrorMessage(code) {
  if (PUBLIC_ERROR_MESSAGES.has(code)) return PUBLIC_ERROR_MESSAGES.get(code);
  if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_')) {
    return 'invalid command-line arguments';
  }
  return 'operator operation failed';
}

// Project error details down to the allowlisted keys, redacting every surviving
// string.
function safeDetails(details) {
  if (details === null || details === undefined) return undefined;
  if (Array.isArray(details)) return details.map(safeDetails);
  if (typeof details === 'string') return safeString(details);
  if (typeof details !== 'object') return details;
  return Object.fromEntries(Object.entries(details)
    .filter(([key]) => SAFE_DETAIL_KEYS.has(key))
    .map(([key, value]) => [key, safeDetails(value)]));
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
    await providerForBackend(lane.backend).reconcile(options, env);
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
        failures: errors.map((entry) => ({ dispatchId: entry.dispatchId, code: entry.code })),
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

// Safe refusals and argument errors exit 2; everything else exits 3.
function exitCodeForError(code) {
  return SAFE_REFUSALS.has(code) || String(code || '').startsWith('ERR_PARSE_ARGS_') ? 2 : 3;
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
    if (values.target === 'codex' && values['claude-bin'] !== undefined) {
      usage('--claude-bin is valid only for Claude capabilities');
    }
    if (values.target === 'claude' && values.url !== undefined) {
      usage('--url is valid only for Codex capabilities');
    }
    const { adapter } = providerForTarget(values.target);
    if (typeof adapter.executionCapabilities !== 'function') {
      usage(`${values.target} execution capabilities are unavailable`);
    }
    return adapter.executionCapabilities({ url: values.url, claudeBin: values['claude-bin'] }, env);
  }
  if (operation === 'spawn' && !TARGETS.includes(values.target)) {
    usage('spawn requires --target codex|claude');
  }
  if (operation === 'spawn' && values.target === 'codex' && values['claude-bin'] !== undefined) {
    usage('--claude-bin is valid only for Claude targets');
  }
  if (operation === 'spawn' && values.target === 'claude' && values.url !== undefined) {
    usage('--url is valid only for Codex targets');
  }
  if (operation === 'spawn' && values.target === 'claude' && values['allow-protocol-only'] !== undefined) {
    usage('--allow-protocol-only is valid only for Codex targets');
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
  const options = {
    repoRoot,
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
    if (values.target === 'codex' && (values['claude-bin'] !== undefined || values['private-archive'] !== undefined)) {
      usage('Claude options are valid only for Claude reconciliation');
    }
    if (values.target === 'codex' && values['finish-retirements'] !== undefined) {
      usage('--finish-retirements is valid only for Claude reconciliation');
    }
    if (values.target === 'claude' && values.url !== undefined) {
      usage('--url is valid only for Codex reconciliation');
    }
    const result = await providerForTarget(values.target).reconcile(options, env);
    return { ...result, operation: 'reconcile' };
  }
  if (!values.lane) usage(`${operation} requires --lane`);
  const adapter = adapterForLane(repoRoot, values.lane, env);
  if (values.url !== undefined && adapter !== codex) usage('--url is valid only for Codex lanes');
  if (values['claude-bin'] !== undefined && adapter !== claude) usage('--claude-bin is valid only for Claude lanes');
  if (values['private-archive'] !== undefined && adapter !== claude) {
    usage('--private-archive is valid only for Claude retirement');
  }
  if (operation === 'interrupt') {
    if (adapter !== codex) usage('interrupt is supported only for Codex turn cancellation');
    return codex.interrupt(options, env);
  }
  if (operation === 'stop') {
    if (adapter !== claude) usage('stop is supported only for Claude whole-session stopping');
    return claude.stop(options, env);
  }
  if (operation === 'recover' && input !== undefined) {
    if (adapter !== codex) usage('--input is valid only for Codex boundary recovery');
    const result = await codex.resume(options, env);
    return { ...result, operation: 'recover' };
  }
  if (typeof adapter[operation] !== 'function') usage(`${operation} is not supported by ${adapter === codex ? 'codex' : 'claude'}`);
  return adapter[operation](options, env);
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
    const details = safeDetails(error.details);
    const hasDetails = Array.isArray(details) ? details.length > 0 :
      details && typeof details === 'object' ? Object.keys(details).length > 0 :
        details !== undefined;
    const stageUnknown = Object.values(effect).includes('unknown');
    const body = {
      version: 1,
      ok: false,
      code,
      message: publicErrorMessage(code),
      delivery: stageUnknown ? 'unknown' :
        effect.providerMutation === 'verified' ? 'confirmed' :
          code === 'NOT_DELIVERED' ? 'notDelivered' : 'notAttempted',
      effect,
      ...(hasDetails ? { details } : {}),
    };
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
