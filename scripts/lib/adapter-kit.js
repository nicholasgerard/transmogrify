'use strict';

// Invariants every provider adapter shares: the coded error, lane resolution
// by backend, the managed worktrees root, the caller's execution request, the
// execution-profile failure projection, and the uniform lane result envelope.
// A new provider adapter builds on these and adds only provider mechanics.

const { ExecutionProfileError } = require('./execution-profile');
const { requireOwnedLane } = require('./state');

// Adapter failure carrying a stable code. The code, not the message, is what
// the CLI maps to an exit status and a public delivery projection.
class AdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.details = details;
  }
}

// The lane a command may act on, proven owned and on the expected backend.
// An unowned lane is NOT_OWNED and another backend is ADAPTER_MISMATCH.
function requireOwnedBackendLane(repoRoot, laneId, backend, env) {
  let lane;
  try { lane = requireOwnedLane(repoRoot, laneId, env); } catch (error) {
    if (/^NOT_OWNED:/.test(error.message)) throw new AdapterError('NOT_OWNED', `lane ${laneId} is not owned`);
    throw error;
  }
  if (lane.backend !== backend) {
    throw new AdapterError('ADAPTER_MISMATCH', `lane ${lane.laneId} uses ${lane.backend}`);
  }
  return lane;
}

// The wall clock an operation reads for its dispatch windows and grace
// periods. options.clock lets a test move time instead of waiting for it.
function nowMs(options) {
  return typeof options?.clock === 'function' ? options.clock() : Date.now();
}

// An aggregate deadline computed once, on whatever clock options carries, so
// every later "how much is left" read stays on that same clock instead of a
// fresh Date.now() call. null when the caller set no bound at all; a caller
// that wants the exhausted-budget error wraps msLeft() itself, since the
// coded error is the adapter's, not the kit's, to throw.
function deadlineFor(options, timeoutMs) {
  if (!Number.isInteger(timeoutMs)) return null;
  const at = nowMs(options) + timeoutMs;
  return { at, msLeft: () => at - nowMs(options) };
}

// The managed worktrees root: explicit option, then WORKTREES, then the
// repository's own .worktrees directory.
function worktreesRoot(options, env = process.env) {
  return options.worktrees || env.WORKTREES || `${options.repoRoot}/.worktrees`;
}

// The caller's execution intent with unset controls omitted, so a provider
// default stays a default instead of being pinned to a resolved value.
function executionRequest(options) {
  return Object.fromEntries([
    ['intent', options.intent],
    ['model', options.model],
    ['effort', options.effort],
    ['speed', options.speed],
  ].filter(([, value]) => value !== undefined));
}

// Re-project an execution-profile failure as EXECUTION_PROFILE_UNSUPPORTED,
// keeping the original profile code in details. Any other error rethrows.
function profileFailure(error) {
  if (!(error instanceof ExecutionProfileError)) throw error;
  throw new AdapterError('EXECUTION_PROFILE_UNSUPPORTED', error.message, {
    profileCode: error.code,
  });
}

// The uniform success envelope. It carries the lane's identity, state,
// capabilities, and (when the provider has one) native visibility, so a caller
// never has to re-read the registry to interpret it.
function laneResult(operation, lane, extra = {}) {
  return {
    version: 1,
    ok: true,
    operation,
    operationId: lane.operationId || null,
    laneId: lane.laneId,
    adapter: lane.backend,
    providerId: lane.providerId ?? null,
    state: lane.state,
    capabilities: lane.capabilities,
    ...(lane.visibility !== undefined ? { visibility: lane.visibility } : {}),
    ...extra,
  };
}

// One reconcile entry is settled when its delivery is known, it was
// observed rather than skipped, and it carries no error code. A reconcile
// result is ok when every entry is.
function reconcileEntryOk(entry) {
  return entry.delivery !== 'unknown' && entry.outcome !== 'differentRuntime' &&
    entry.outcome !== 'uncertain' && entry.code === undefined && !entry.error;
}

function reconcileOk(entries) {
  return entries.every(reconcileEntryOk);
}

module.exports = {
  reconcileEntryOk,
  reconcileOk,
  AdapterError,
  deadlineFor,
  executionRequest,
  laneResult,
  nowMs,
  profileFailure,
  requireOwnedBackendLane,
  worktreesRoot,
};
