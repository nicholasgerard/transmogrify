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
const {
  PROVIDER_FLAGS, PROVIDERS, TARGETS, providerForBackend, providerForTarget, targetsAccepting,
} = require('./lib/providers');
const { observeParentChildren, resolveDispatchLane } = require('./lib/observe');
const { sleep } = require('./lib/async');
const {
  WAIT_THRESHOLDS,
  acknowledgeEvent,
  countEvents,
  createParentContext,
  digest,
  kindForEvent,
  kindSatisfies,
  listDispatches,
  listEvents,
  listParentContexts,
  loadParentContext,
} = require('./lib/dispatch');
const {
  SAFE_REFUSALS, exitCodeForError, failureBody, publicErrorMessage, safeDetails, safeString,
} = require('./lib/public-error');
const { describeSchema, publicResult } = require('./lib/output-schema');
const {
  ABANDONABLE_OPERATION_TYPES, abandonPendingLaneOperation,
  listOperations, pendingOperationForLane, requireOwnedLane, resolveProject,
  settleTerminalLaneOperationPointer, withLaneLease,
} = require('./lib/state');

const MAX_INPUT_BYTES = 64 * 1024;
// Refuse a provider flag on a provider that does not accept it, naming the
// providers that do.
function rejectForeignFlags(provider, values, context) {
  for (const flag of PROVIDER_FLAGS) {
    if (values[flag] === undefined || provider.options.has(flag)) continue;
    const accepting = targetsAccepting(flag).join('|') || 'no';
    usage(`--${flag} is valid only for ${accepting} ${context}`);
  }
}

const HELP = `usage: lane.js <operation> [options]

operations:
  parent-init --host-provider <slug> --host-app <slug> --name <parent task>
              [--native-task-ref <private-ref>]
  parent-list
  schema                                             print the public output contract
  capabilities --target codex|claude
  spawn      --target codex|claude --name <summary> (--input <text> | --input-file <absolute|->)
             --parent-context-file <absolute>
             [--cwd <absolute>] [--worktrees <absolute> (or WORKTREES)]
             [--intent <intent>] [--model <provider-model>] [--effort <level>]
             [--speed standard|fast] [--allow-protocol-only]
  children   --parent-context-file <absolute> [--observe]
  wait       --parent-context-file <absolute> [--after <sequence>] [--timeout-ms <0..1800000>]
             [--until any|complete|terminal]
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
  'schema',
]);
const OPERATION_OPTIONS = {
  'parent-init': new Set([
    'host-provider', 'host-app', 'name', 'native-task-ref',
  ]),
  'parent-list': new Set(),
  schema: new Set(),
  capabilities: new Set(['target', 'url', 'claude-bin']),
  spawn: new Set([
    'repo-root', 'target', 'name', 'input', 'input-file', 'cwd', 'worktrees',
    'url', 'claude-bin', 'parent-context-file', 'intent', 'model', 'effort', 'speed',
    'allow-protocol-only', 'timeout-ms',
  ]),
  children: new Set(['repo-root', 'parent-context-file', 'observe', 'url', 'claude-bin']),
  wait: new Set([
    'repo-root', 'parent-context-file', 'after', 'timeout-ms', 'until', 'url', 'claude-bin',
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
// Bounded parent wait. Every call first observes every outstanding child
// (each round bounded so a slow provider read cannot stall the others), then
// returns everything unacknowledged, old and new together, as soon as one
// event meets the `--until` threshold. A wait of 0 ms drains pending events
// without observing. Expiry is NO_EVENT; the events stay pending until acked.
const MAX_WAIT_MS = 1_800_000;
const OBSERVATION_ROUND_MS = 30_000;
async function waitForParentEvent(context, values, env) {
  const timeoutMs = boundedInteger(values['timeout-ms'], '--timeout-ms', 0, MAX_WAIT_MS, 60_000);
  const after = boundedInteger(values.after, '--after', 0, Number.MAX_SAFE_INTEGER, 0);
  const until = values.until ?? 'any';
  if (!WAIT_THRESHOLDS.includes(until)) usage(`--until must be one of: ${WAIT_THRESHOLDS.join(', ')}`);
  const deadline = Date.now() + timeoutMs;
  const project = values['repo-root'] ? resolveProject(values['repo-root']) : null;
  const observationValues = project ? { ...values, 'repo-root': project.root } : values;
  const projectKey = project ? digest(project.commonDir) : undefined;
  const eventOptions = { after, projectKey };
  const result = (events, observed) => ({
    version: 1,
    ok: true,
    operation: 'wait',
    until,
    events,
    observed: observed.observed,
    ...(observed.errors.length > 0 ? { observerErrors: observed.errors } : {}),
  });
  const expired = (attempted, pending) => {
    const error = new Error('bounded child wait expired without an event');
    error.code = 'NO_EVENT';
    error.details = { attempted, pending, until };
    return error;
  };
  if (timeoutMs === 0) {
    const events = listEvents(context, eventOptions, env);
    if (events.some((event) => kindSatisfies(event.kind, until))) {
      return result(events, { observed: [], errors: [] });
    }
    throw expired(0, events.length);
  }
  for (;;) {
    const roundDeadline = Math.max(Date.now() + 100, Math.min(deadline, Date.now() + OBSERVATION_ROUND_MS));
    const observed = await observeParentChildren(context, observationValues, env, roundDeadline);
    const events = listEvents(context, eventOptions, env);
    if (events.some((event) => kindSatisfies(event.kind, until))) return result(events, observed);
    if (observed.errors.length > 0) {
      const error = new Error('one or more exact child observations failed');
      error.code = 'OBSERVATION_FAILED';
      error.details = {
        attempted: observed.dispatches.length,
        failures: observed.errors.map((entry) => ({ dispatchId: entry.dispatchId, code: entry.code })),
      };
      throw error;
    }
    if (Date.now() >= deadline) throw expired(observed.dispatches.length, events.length);
    await sleep(Math.min(1000, deadline - Date.now()));
  }
}

// Project a successful result for public output: strip provider control handles
// and redact every string, stopping key stripping inside the exempt metadata
// subtrees while still redacting their strings.
// The public view of a command result: the allowlist projection in
// lib/output-schema.js, kept under the name the tests and callers use.
const publicSuccess = publicResult;

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
      until: { type: 'string' },
      observe: { type: 'boolean' },
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
  if (operation === 'schema') return describeSchema();
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
    const projectKey = project ? digest(project.commonDir) : undefined;
    // --observe refreshes every child through its provider first, so the
    // summary below reflects the live phase and the events that observation
    // just recorded.
    let observed = new Map();
    if (values.observe === true) {
      const round = await observeParentChildren(parentContext, {
        ...values, 'repo-root': project ? project.root : undefined,
      }, env, Date.now() + OBSERVATION_ROUND_MS);
      observed = new Map(round.observed.map((entry) => [entry.dispatchId, entry]));
    }
    const pendingEvents = listEvents(parentContext, { projectKey }, env);
    const children = listDispatches(parentContext, env)
      .filter((dispatch) => !project || dispatch.child.repoRoot === project.root)
      .map((dispatch) => {
        const summary = dispatchSummary(dispatch, resolveDispatchLane(dispatch, env));
        const mine = pendingEvents.filter((event) => event.dispatchId === dispatch.dispatchId);
        const latest = mine.at(-1) || null;
        const live = observed.get(dispatch.dispatchId);
        return {
          ...summary,
          ...(live ? { phase: live.phase } : {}),
          unacknowledgedEvents: mine.length,
          latestEventType: latest?.type ?? null,
          latestEventKind: latest ? kindForEvent(latest.type) : null,
        };
      });
    const unacknowledgedEvents = pendingEvents.length;
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
