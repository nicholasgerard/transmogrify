'use strict';

// The Claude Code provider identity schema: the measured runtime tuple, the
// session/job/bridge binding, execution and runtime epochs, and the immutable
// spawn intent. The state store dispatches to this module by backend, so the
// registry itself stays provider-neutral.

const path = require('node:path');
const { SHA256_PATTERN, UUID_PATTERN, assertExactKeys, assertTimestamp } = require('./record-guards');

const CLAUDE_BACKEND = 'claude-code';
const CLAUDE_JOB_PATTERN = /^[0-9a-f]{8}$/i;
const CLAUDE_BRIDGE_PATTERN = /^session_(?:staging_)?[0-9A-Za-z]{1,64}$/;

// One Claude execution epoch: UUID, contiguous ordinal, worker pid with its
// measured process birth, and the 0600 control socket's device, inode, uid and
// mode. Contiguous ordinals mean no epoch can be dropped or reordered.
function validateExecutionEpoch(epoch, expectedOrdinal) {
  if (!epoch || typeof epoch !== 'object' || Array.isArray(epoch)) {
    throw new Error('Claude execution epoch must be an object');
  }
  assertExactKeys(epoch, new Set([
    'epochId', 'ordinal', 'pid', 'processBirth', 'socket', 'observedAt',
  ]), 'Claude execution epoch');
  if (!UUID_PATTERN.test(epoch.epochId || '')) throw new Error('Claude execution epoch requires a UUID');
  if (epoch.ordinal !== expectedOrdinal) throw new Error('Claude execution epoch ordinals must be contiguous');
  if (!Number.isInteger(epoch.pid) || epoch.pid < 1) throw new Error('Claude execution epoch PID is invalid');
  if (typeof epoch.processBirth !== 'string' || !epoch.processBirth) {
    throw new Error('Claude execution epoch process birth is required');
  }
  assertTimestamp(epoch.observedAt, 'Claude execution epoch observedAt');
  const socket = epoch.socket;
  if (!socket || typeof socket !== 'object' || Array.isArray(socket)) {
    throw new Error('Claude execution epoch socket receipt is required');
  }
  assertExactKeys(socket, new Set([
    'path', 'device', 'inode', 'uid', 'mode', 'tokenSha256',
  ]), 'Claude execution epoch socket');
  if (!path.isAbsolute(socket.path || '')) throw new Error('Claude execution socket path must be absolute');
  for (const key of ['device', 'inode', 'uid', 'mode']) {
    if (!Number.isInteger(socket[key]) || socket[key] < 0) {
      throw new Error(`Claude execution socket ${key} is invalid`);
    }
  }
  if (socket.mode !== 0o600) throw new Error('Claude execution socket mode must be 0600');
  if (socket.tokenSha256 !== undefined && !SHA256_PATTERN.test(socket.tokenSha256)) {
    throw new Error('Claude execution socket tokenSha256 is invalid');
  }
}

const CLAUDE_RUNTIME_KEYS = new Set([
  'protocolGeneration', 'platform', 'arch', 'cliPath', 'cliVersion', 'cliSha256',
  'configDir', 'configDevice', 'configInode', 'projectsDirectory', 'projectsDevice',
  'projectsInode', 'accountFingerprint',
]);
const CLAUDE_RUNTIME_IDENTITY_KEYS = [
  'protocolGeneration', 'platform', 'arch', 'configDir', 'configDevice',
  'configInode', 'projectsDirectory', 'projectsDevice', 'projectsInode',
  'accountFingerprint',
];

// The measured Claude compatibility tuple: platform, arch, CLI path, version
// and SHA-256, config and projects directory identities, and the account
// fingerprint. allowLegacyProjectsIdentity keeps a pre-0.2 receipt on an
// already-retired lane readable without weakening any check on a live lane.
function validateClaudeRuntime(runtime, label = 'Claude runtime', options = {}) {
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new Error(`${label} must be an object`);
  }
  assertExactKeys(runtime, CLAUDE_RUNTIME_KEYS, label);
  if (runtime.protocolGeneration !== 1 || typeof runtime.platform !== 'string' ||
      typeof runtime.arch !== 'string' || !/^\d+\.\d+\.\d+$/.test(runtime.cliVersion || '') ||
      !SHA256_PATTERN.test(runtime.cliSha256 || '') ||
      !SHA256_PATTERN.test(runtime.accountFingerprint || '')) {
    throw new Error(`${label} has an invalid compatibility identity`);
  }
  for (const key of ['cliPath', 'configDir', 'projectsDirectory']) {
    if (!path.isAbsolute(runtime[key] || '')) throw new Error(`${label} ${key} must be absolute`);
  }
  for (const key of ['configDevice', 'configInode']) {
    if (!Number.isInteger(runtime[key]) || runtime[key] < 0) {
      throw new Error(`${label} ${key} is invalid`);
    }
  }
  const legacyProjectsIdentity = options.allowLegacyProjectsIdentity === true &&
    runtime.projectsDevice === undefined && runtime.projectsInode === undefined;
  if (!legacyProjectsIdentity) {
    for (const key of ['projectsDevice', 'projectsInode']) {
      if (!Number.isInteger(runtime[key]) || runtime[key] < 0) {
        throw new Error(`${label} ${key} is invalid`);
      }
    }
  }
}

// The subset of the runtime tuple that must survive a CLI upgrade unchanged.
// The build hash is deliberately excluded: it is what a transition rebinds.
function sameClaudeRuntimeIdentity(left, right) {
  return CLAUDE_RUNTIME_IDENTITY_KEYS.every((key) => left?.[key] === right?.[key]);
}

// Whole-record invariant for a Claude lane: session and job bind atomically and
// the job is the session's first eight hex characters, a bridge or execution
// epoch requires that session, and the runtime-epoch chain must preserve the
// immutable identity while advancing build hash and epoch ordinals in order.
function validateClaudeProviderIdentity(lane) {
  const identity = lane.providerIdentity;
  if (identity === undefined) return;
  if (lane.backend !== CLAUDE_BACKEND) {
    throw new Error(`lane ${lane.laneId} uses Claude provider identity with backend ${lane.backend}`);
  }
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error(`lane ${lane.laneId} has an invalid Claude provider identity`);
  }
  assertExactKeys(identity, new Set([
    'version', 'sessionId', 'jobId', 'bridgeId', 'executionEpochs', 'runtimeEpochs',
  ]), `lane ${lane.laneId} Claude provider identity`);
  if (identity.version !== 1) throw new Error(`lane ${lane.laneId} has an unsupported Claude provider identity`);
  for (const key of ['sessionId', 'jobId', 'bridgeId']) {
    if (identity[key] !== null && typeof identity[key] !== 'string') {
      throw new Error(`lane ${lane.laneId} Claude ${key} must be a string or null`);
    }
  }
  const hasSession = identity.sessionId !== null;
  const hasJob = identity.jobId !== null;
  if (hasSession !== hasJob) throw new Error(`lane ${lane.laneId} Claude session and job must bind atomically`);
  if (hasSession) {
    if (!UUID_PATTERN.test(identity.sessionId)) throw new Error(`lane ${lane.laneId} Claude session id is invalid`);
    if (identity.sessionId !== identity.sessionId.toLowerCase() || identity.jobId !== identity.jobId.toLowerCase()) {
      throw new Error(`lane ${lane.laneId} Claude session and job ids must be lowercase`);
    }
    if (!CLAUDE_JOB_PATTERN.test(identity.jobId) ||
        identity.sessionId.slice(0, 8).toLowerCase() !== identity.jobId.toLowerCase()) {
      throw new Error(`lane ${lane.laneId} Claude job id does not match its session`);
    }
    if (lane.providerId !== identity.sessionId) {
      throw new Error(`lane ${lane.laneId} Claude session does not match providerId`);
    }
  } else if (lane.providerId !== null) {
    throw new Error(`lane ${lane.laneId} Claude providerId is bound without a session`);
  }
  if (identity.bridgeId !== null && !CLAUDE_BRIDGE_PATTERN.test(identity.bridgeId)) {
    throw new Error(`lane ${lane.laneId} Claude bridge id is invalid`);
  }
  if (identity.bridgeId !== null && !hasSession) {
    throw new Error(`lane ${lane.laneId} Claude bridge is bound without a session`);
  }
  if (!Array.isArray(identity.executionEpochs)) {
    throw new Error(`lane ${lane.laneId} Claude execution epochs must be an array`);
  }
  if (identity.executionEpochs.length > 0 && (!hasSession || identity.bridgeId === null)) {
    throw new Error(`lane ${lane.laneId} has Claude execution epochs without a fully bound provider`);
  }
  const epochIds = new Set();
  identity.executionEpochs.forEach((epoch, index) => {
    validateExecutionEpoch(epoch, index + 1);
    if (epochIds.has(epoch.epochId)) throw new Error(`lane ${lane.laneId} has duplicate Claude execution epochs`);
    epochIds.add(epoch.epochId);
  });
  const runtimeEpochs = identity.runtimeEpochs || [];
  if (!Array.isArray(runtimeEpochs)) {
    throw new Error(`lane ${lane.laneId} Claude runtime epochs must be an array`);
  }
  const allowLegacyProjectsIdentity = lane.state === 'worktreeRemoved';
  const runtimeBound = lane.runtime !== null && lane.runtime !== undefined;
  if (hasSession || identity.executionEpochs.length > 0 || runtimeEpochs.length > 0 || runtimeBound) {
    validateClaudeRuntime(lane.runtime, `lane ${lane.laneId} initial Claude runtime`, {
      allowLegacyProjectsIdentity,
    });
  }
  const transitionIds = new Set();
  let priorRuntime = lane.runtime;
  let priorExecutionOrdinal = 0;
  runtimeEpochs.forEach((transition, index) => {
    const label = `lane ${lane.laneId} Claude runtime epoch`;
    if (!transition || typeof transition !== 'object' || Array.isArray(transition)) {
      throw new Error(`${label} must be an object`);
    }
    assertExactKeys(transition, new Set([
      'transitionId', 'ordinal', 'fromCliSha256', 'runtime', 'worker',
      'executionEpochOrdinal', 'observedAt',
    ]), label);
    if (!UUID_PATTERN.test(transition.transitionId || '') ||
        transitionIds.has(transition.transitionId)) {
      throw new Error(`${label} id is invalid or duplicated`);
    }
    if (transition.ordinal !== index + 1 ||
        transition.fromCliSha256 !== priorRuntime?.cliSha256) {
      throw new Error(`${label} chain is invalid`);
    }
    validateClaudeRuntime(transition.runtime, label, { allowLegacyProjectsIdentity });
    if (!sameClaudeRuntimeIdentity(priorRuntime, transition.runtime) ||
        transition.runtime.cliSha256 === priorRuntime.cliSha256) {
      throw new Error(`${label} changes the immutable provider identity or repeats a build`);
    }
    const worker = transition.worker;
    if (!worker || typeof worker !== 'object' || Array.isArray(worker)) {
      throw new Error(`${label} worker receipt is required`);
    }
    assertExactKeys(worker, new Set(['path', 'sha256']), `${label} worker`);
    if (worker.path !== transition.runtime.cliPath || worker.sha256 !== transition.runtime.cliSha256) {
      throw new Error(`${label} worker does not match its runtime`);
    }
    if (!Number.isInteger(transition.executionEpochOrdinal) ||
        transition.executionEpochOrdinal <= priorExecutionOrdinal ||
        transition.executionEpochOrdinal > identity.executionEpochs.length) {
      throw new Error(`${label} execution reference is invalid`);
    }
    assertTimestamp(transition.observedAt, `${label} observedAt`);
    transitionIds.add(transition.transitionId);
    priorRuntime = transition.runtime;
    priorExecutionOrdinal = transition.executionEpochOrdinal;
  });
}

// The immutable intent recorded before the Claude CLI is executed: operation,
// nonce, display name, prompt digests, preflight session census, and capture
// paths. It must still match the lane's ownership, so a replayed or edited
// intent cannot be used to adopt a different provider session.
function validateClaudeSpawnIntent(lane) {
  if (lane.providerIdentity === undefined) return;
  const intent = lane.ownership?.spawnIntent;
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new Error(`lane ${lane.laneId} requires an immutable Claude spawn intent`);
  }
  assertExactKeys(intent, new Set([
    'operationId', 'spawnNonce', 'displayName', 'promptSha256', 'promptMarkerSha256',
    'preflightSessionIds', 'stdoutPath', 'stderrPath', 'modelSelector',
  ]), `lane ${lane.laneId} Claude spawn intent`);
  if (!UUID_PATTERN.test(intent.operationId || '') || !UUID_PATTERN.test(intent.spawnNonce || '') ||
      intent.operationId !== lane.operationId || intent.operationId !== lane.ownership.operationId) {
    throw new Error(`lane ${lane.laneId} Claude spawn intent operation does not match ownership`);
  }
  if (intent.displayName !== lane.displayName) {
    throw new Error(`lane ${lane.laneId} Claude spawn intent name does not match`);
  }
  if (intent.modelSelector !== undefined &&
      (typeof intent.modelSelector !== 'string' ||
       !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(intent.modelSelector))) {
    throw new Error(`lane ${lane.laneId} Claude spawn intent model is invalid`);
  }
  for (const key of ['promptSha256', 'promptMarkerSha256']) {
    if (!SHA256_PATTERN.test(intent[key] || '')) {
      throw new Error(`lane ${lane.laneId} Claude spawn intent ${key} is invalid`);
    }
  }
  if (!Array.isArray(intent.preflightSessionIds) ||
      intent.preflightSessionIds.some((entry) => !UUID_PATTERN.test(entry) || entry !== entry.toLowerCase()) ||
      new Set(intent.preflightSessionIds).size !== intent.preflightSessionIds.length) {
    throw new Error(`lane ${lane.laneId} Claude spawn intent preflight census is invalid`);
  }
  for (const key of ['stdoutPath', 'stderrPath']) {
    if (!path.isAbsolute(intent[key] || '')) {
      throw new Error(`lane ${lane.laneId} Claude spawn intent ${key} must be absolute`);
    }
  }
}

// Every invariant the state store checks for a Claude lane record.
function validateLaneIdentity(lane) {
  validateClaudeProviderIdentity(lane);
  validateClaudeSpawnIntent(lane);
}

module.exports = {
  CLAUDE_BACKEND,
  CLAUDE_BRIDGE_PATTERN,
  CLAUDE_JOB_PATTERN,
  CLAUDE_RUNTIME_IDENTITY_KEYS,
  CLAUDE_RUNTIME_KEYS,
  sameClaudeRuntimeIdentity,
  validateClaudeProviderIdentity,
  validateClaudeRuntime,
  validateClaudeSpawnIntent,
  validateExecutionEpoch,
  validateLaneIdentity,
};
