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

module.exports = {
  AdapterError,
  executionRequest,
  laneResult,
  profileFailure,
  requireOwnedBackendLane,
  worktreesRoot,
};
