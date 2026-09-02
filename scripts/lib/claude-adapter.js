'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  appendLaneExecutionEpoch, beginLaneOperation, beginOperation, bindClaudeSpawnObservation, bindLaneSeat,
  completeLaneOperation, ensureRegistry, listLanes, listOperations, observeLaneStopped,
  pendingOperationForLane, projectPaths, rebindClaudeRuntime, requireOwnedLane, reserveSpawn, updateLane,
  settleTerminalLaneOperationPointer, updateOperation, updatePendingLaneOperation, withLaneLease,
} = require('./state');
const {
  assertSafeModelSelector, assertUniqueShortJobId, claudeSpawnArgs, createClaudeSurface,
  MAX_STEER_BYTES, parseJobId, sha256,
} = require('./claude-surface');
const {
  captureHarvestReceipt, isPermanentCleanupError, materializeManagedSeat, planManagedSeat, removeManagedSeat,
  verifyLaneSeat, verifySeat,
} = require('./worktree');

const BACKEND = 'claude-code';
const RETIRED_STATES = new Set(['archivedVerified', 'cleanupEligible', 'worktreeRemoved']);
const RETIRING_STATES = new Set(['retireRequested', 'archiveUnknown', 'localRemovalPending']);
const NON_MUTABLE_STATES = new Set([...RETIRED_STATES, ...RETIRING_STATES]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

class ClaudeTransmogrifyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ClaudeTransmogrifyError';
    this.code = code;
    this.details = details;
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function worktreesRoot(options, env) {
  return options.worktrees || env.WORKTREES || `${options.repoRoot}/.worktrees`;
}
function publicRuntime(runtime) {
  const { cleanEnv: _cleanEnv, orgId: _orgId, ...persisted } = runtime;
  return persisted;
}
function sameRuntime(recorded, actual) {
  const current = publicRuntime(actual);
  return recorded && Object.keys(current).every((key) => recorded[key] === current[key]) &&
    Object.keys(recorded).every((key) => recorded[key] === current[key]);
}
function effectiveRuntime(lane) {
  return lane.providerIdentity?.runtimeEpochs?.at(-1)?.runtime || lane.runtime;
}
function sameRuntimeIdentity(left, right) {
  return [
    'protocolGeneration', 'platform', 'arch', 'configDir', 'configDevice',
    'configInode', 'projectsDirectory', 'projectsDevice', 'projectsInode',
    'accountFingerprint',
  ].every((key) => left?.[key] === right?.[key]);
}
function capabilities() {
  return {
    steering: 'queuedSafePointPublicCli', stop: 'wholeSession', cancelTurnOnly: false,
    recovery: 'exactSessionNoExtraFlags', retirement: 'remoteArchiveThenLocalRemoval',
    nativePresentation: 'remoteControlDeepLink', approvalRelay: false,
  };
}
function laneResult(operation, lane, extra = {}) {
  return {
    version: 1, ok: true, operation, adapter: BACKEND, laneId: lane.laneId,
    providerId: lane.providerId, state: lane.state, capabilities: lane.capabilities, ...extra,
  };
}
function assertSpawnSelection(lane, operation) {
  const intentSelector = lane.ownership?.spawnIntent?.modelSelector;
  const operationSelector = operation?.details?.modelSelector;
  if (intentSelector !== operationSelector) {
    throw new ClaudeTransmogrifyError(
      'OWNERSHIP_MISMATCH',
      'Claude model selector does not match the immutable spawn journal',
    );
  }
}
function surfaceFor(options) { return options.surface || createClaudeSurface(); }
function preflight(options, env, surface) {
  try { return surface.preflight(options, env); } catch (error) {
    if (error instanceof ClaudeTransmogrifyError) throw error;
    throw new ClaudeTransmogrifyError(error.code || 'UNSUPPORTED_ENVIRONMENT', error.message, error.details);
  }
}
function assertSeat(options, lane) {
  try { return verifyLaneSeat(options.repoRoot, lane.seat); } catch (error) {
    throw new ClaudeTransmogrifyError('SEAT_MISMATCH', error.message);
  }
}
function ownedLane(options, env, mutation = false) {
  if (!options.repoRoot || !path.isAbsolute(options.repoRoot)) {
    throw new ClaudeTransmogrifyError('USAGE_ERROR', 'repoRoot must be absolute');
  }
  const lane = requireOwnedLane(options.repoRoot, options.laneId, env);
  if (lane.backend !== BACKEND) {
    throw new ClaudeTransmogrifyError('ADAPTER_MISMATCH', `lane ${lane.laneId} uses ${lane.backend}`);
  }
  if (mutation && NON_MUTABLE_STATES.has(lane.state)) {
    throw new ClaudeTransmogrifyError('LANE_RETIRED', `lane ${lane.laneId} is retiring or retired`);
  }
  if (!lane.providerId || !lane.providerIdentity?.sessionId || !lane.providerIdentity?.jobId ||
      !lane.providerIdentity?.bridgeId) {
    throw new ClaudeTransmogrifyError('SPAWN_UNCERTAIN', `lane ${lane.laneId} has incomplete Claude identity`);
  }
  return lane;
}
function runtimeForLane(options, lane, env, surface) {
  const expected = effectiveRuntime(lane);
  const runtime = preflight({
    ...options,
    claudeBin: options.claudeBin || expected.cliPath,
  }, env, surface);
  if (!sameRuntime(expected, runtime)) {
    throw new ClaudeTransmogrifyError('RUNTIME_MISMATCH', 'Claude CLI/account/config identity changed');
  }
  return runtime;
}
function latestEpoch(lane) {
  return lane.providerIdentity.executionEpochs[lane.providerIdentity.executionEpochs.length - 1] || null;
}
function ensureLatestEpoch(lane, execution) {
  const epoch = latestEpoch(lane);
  if (!epoch || epoch.pid !== execution.pid || epoch.processBirth !== execution.processBirth) {
    throw new ClaudeTransmogrifyError('EXECUTION_EPOCH_UNBOUND', 'Claude worker execution epoch is not journaled');
  }
  for (const key of ['path', 'device', 'inode', 'uid', 'mode']) {
    if (epoch.socket[key] !== execution.socket[key]) {
      throw new ClaudeTransmogrifyError('EXECUTION_EPOCH_UNBOUND', `Claude worker socket ${key} changed`);
    }
  }
  return epoch;
}
function sameExecutionEpoch(epoch, discovery) {
  return Boolean(epoch && epoch.pid === discovery.pid && epoch.processBirth === discovery.processBirth &&
    ['path', 'device', 'inode', 'uid', 'mode'].every((key) =>
      epoch.socket[key] === discovery.socket[key]));
}
function epochFromDiscovery(discovery, epochId = crypto.randomUUID()) {
  return {
    epochId, pid: discovery.pid, processBirth: discovery.processBirth,
    socket: discovery.socket, observedAt: new Date().toISOString(),
  };
}
function phaseForAgent(agent) {
  const observedState = agent.status || agent.state || (agent.pid ? 'running' : 'stopped');
  const phase = agent.pid === null ? 'stopped' :
    ['working', 'busy', 'running'].includes(observedState) ? 'working' :
      ['idle', 'done', 'completed'].includes(observedState) ? 'idle' :
        agent.waitingFor ? 'waiting' : 'unknown';
  return { phase };
}
function runningLaneState(agent) { return phaseForAgent(agent).phase === 'working' ? 'active' : 'idle'; }
function updateRunningLane(repoRoot, lane, agent, env, patch = {}) {
  const target = runningLaneState(agent);
  let current = lane;
  if (current.state === 'stopped') {
    current = updateLane(repoRoot, current.laneId, { state: 'recoverRequested' }, env);
  } else if (current.state === 'stopRequested') {
    current = updateLane(repoRoot, current.laneId, { state: 'deliveryUnknown' }, env);
  }
  if (current.state !== target) {
    current = updateLane(repoRoot, current.laneId, { state: target, ...patch }, env);
  } else if (Object.keys(patch).length) {
    current = updateLane(repoRoot, current.laneId, patch, env);
  }
  return current;
}
async function pollAgents(surface, runtime, predicate, options = {}) {
  const attempts = options.attempts ?? 30;
  const delayMs = options.delayMs ?? 100;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const agents = await surface.agents(runtime);
    const result = predicate(agents);
    if (result) return { agents, result };
    if (attempt < attempts && delayMs) await sleep(delayMs);
  }
  return null;
}
function operationForType(repoRoot, lane, type, env, details) {
  const pending = pendingOperationForLane(repoRoot, lane.laneId, env);
  if (pending) {
    if (pending.type !== type) {
      throw new ClaudeTransmogrifyError(
        'PENDING_OPERATION',
        `lane ${lane.laneId} has unresolved ${pending.type} operation ${pending.operationId}`,
      );
    }
    return { operation: pending, resumed: true };
  }
  return {
    operation: beginLaneOperation(repoRoot, lane.laneId, {
      type, providerId: lane.providerId, details,
    }, env),
    resumed: false,
  };
}
function updatePending(repoRoot, laneId, operation, patch, env) {
  return updatePendingLaneOperation(repoRoot, laneId, operation.operationId, patch, env);
}
function completePending(repoRoot, laneId, operation, patch, env) {
  return completeLaneOperation(repoRoot, laneId, operation.operationId, patch, env);
}
function operationUsesPendingPointer(repoRoot, laneId, operation, env) {
  return requireOwnedLane(repoRoot, laneId, env).pendingOperationId === operation.operationId;
}
function updateOperationJournal(repoRoot, laneId, operation, patch, env) {
  return operationUsesPendingPointer(repoRoot, laneId, operation, env)
    ? updatePending(repoRoot, laneId, operation, patch, env)
    : updateOperation(repoRoot, operation.operationId, patch, env);
}
function completeOperationJournal(repoRoot, laneId, operation, patch, env) {
  return operationUsesPendingPointer(repoRoot, laneId, operation, env)
    ? completePending(repoRoot, laneId, operation, patch, env)
    : updateOperation(repoRoot, operation.operationId, { ...patch, state: patch.state || 'complete' }, env);
}
function observedStop(repoRoot, lane, operation, env, receipt = {}) {
  if (lane.state === 'stopped') return lane;
  return observeLaneStopped(repoRoot, lane.laneId, {
    observationId: operation?.operationId || crypto.randomUUID(),
    observedAt: new Date().toISOString(),
    receipt: {
      source: operation ? `pending-${operation.type}` : 'exact-agent-status',
      exactSession: true, ...receipt,
    },
  }, env);
}
async function presentLane(options, env, surface, runtime, lane) {
  const attemptedAt = new Date().toISOString();
  try {
    const presentation = await surface.dispatchDeepLink(runtime, lane.providerIdentity.bridgeId);
    const updated = updateLane(options.repoRoot, lane.laneId, {
      visibility: {
        surface: 'claudeDesktopRemoteControl', state: presentation.state, dispatchedAt: attemptedAt,
      },
      lastVerifiedAt: attemptedAt,
    }, env);
    return { lane: updated, presentation };
  } catch (error) {
    const updated = updateLane(options.repoRoot, lane.laneId, {
      visibility: {
        surface: 'claudeDesktopRemoteControl', state: 'dispatchUnknown', attemptedAt,
        errorCode: error.code || 'PRESENTATION_UNCERTAIN',
      },
      lastVerifiedAt: attemptedAt,
    }, env);
    return {
      lane: updated,
      presentation: { state: 'dispatchUnknown', errorCode: error.code || 'PRESENTATION_UNCERTAIN' },
    };
  }
}
function creationReceipt(candidate, jobId, discovery, stdout, runtime, transcript) {
  return {
    sessionId: candidate.sessionId, jobId, bridgeId: discovery.bridgeId, name: candidate.name,
    cwd: fs.realpathSync(candidate.cwd), kind: candidate.kind, startedAt: candidate.startedAt,
    stdoutSha256: sha256(stdout), transcript, worker: discovery.worker,
    runtime: publicRuntime(runtime), observedAt: new Date().toISOString(),
  };
}
function bridgeReceipt(discovery) {
  return {
    source: 'ownedWorkerMetadata', bridgeId: discovery.bridgeId, pid: discovery.pid,
    processBirth: discovery.processBirth, observedAt: new Date().toISOString(),
  };
}
function candidateFromJob(agents, jobId, intent, seat, dispatchStartedAt, dispatchFinishedAt) {
  const candidates = agents.filter((agent) => {
    if (typeof agent?.id !== 'string' || agent.id.toLowerCase() !== jobId ||
        (typeof agent.sessionId === 'string' &&
          intent.preflightSessionIds.includes(agent.sessionId.toLowerCase())) ||
        agent.name !== intent.displayName || !agent.pid ||
        !['background', 'interactive'].includes(agent.kind)) return false;
    try { if (fs.realpathSync(agent.cwd) !== seat.path) return false; } catch { return false; }
    const startedAt = typeof agent.startedAt === 'number' ? agent.startedAt : Date.parse(agent.startedAt);
    return Number.isFinite(startedAt) && startedAt >= dispatchStartedAt - 5000 &&
      startedAt <= dispatchFinishedAt + 5000;
  });
  return candidates.length === 1 ? candidates[0] : null;
}
function readDurableSpawnReceipt(repoRoot, lane, env) {
  const paths = projectPaths(repoRoot, env);
  const expected = path.join(paths.operations, `${lane.operationId}.spawn.stdout`);
  if (lane.ownership.spawnIntent.stdoutPath !== expected) {
    throw new ClaudeTransmogrifyError('SPAWN_UNCERTAIN', 'Claude spawn stdout receipt path does not match its operation');
  }
  let stat;
  try { stat = fs.lstatSync(expected); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o022) !== 0 || stat.size > 64 * 1024) {
    throw new ClaudeTransmogrifyError('SPAWN_UNCERTAIN', 'Claude spawn stdout receipt is unsafe');
  }
  return { stdout: fs.readFileSync(expected, 'utf8'), modifiedAt: stat.mtimeMs };
}
function removeDurableSpawnReceipts(repoRoot, lane, env) {
  const paths = projectPaths(repoRoot, env);
  for (const [suffix, recorded] of [
    ['stdout', lane.ownership.spawnIntent.stdoutPath],
    ['stderr', lane.ownership.spawnIntent.stderrPath],
  ]) {
    const expected = path.join(paths.operations, `${lane.operationId}.spawn.${suffix}`);
    if (recorded !== expected) {
      throw new ClaudeTransmogrifyError(
        'SPAWN_UNCERTAIN',
        `Claude spawn ${suffix} receipt path does not match its operation`,
      );
    }
    let stat;
    try { stat = fs.lstatSync(expected); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024) {
      throw new ClaudeTransmogrifyError(
        'SPAWN_UNCERTAIN',
        `Claude spawn ${suffix} receipt is unsafe to remove`,
      );
    }
    fs.unlinkSync(expected);
  }
}
async function finalizeSpawn(options, env, surface, runtime, lane, operation, jobId, stdout) {
  const dispatchStartedAt = operation.details.dispatchStartedAt;
  const receiptStat = fs.lstatSync(lane.ownership.spawnIntent.stdoutPath);
  const dispatchFinishedAt = operation.details.dispatchFinishedAt || receiptStat.mtimeMs;
  if (!Number.isFinite(dispatchStartedAt) || !Number.isFinite(dispatchFinishedAt)) {
    throw new ClaudeTransmogrifyError('SPAWN_UNCERTAIN', 'Claude spawn dispatch window is incomplete');
  }
  const located = await pollAgents(surface, runtime, (agents) => candidateFromJob(
    agents, jobId, lane.ownership.spawnIntent, lane.seat, dispatchStartedAt, dispatchFinishedAt,
  ), { attempts: options.discoveryAttempts, delayMs: options.discoveryDelayMs });
  if (!located) {
    throw new ClaudeTransmogrifyError('SPAWN_UNCERTAIN', 'spawned Claude job could not be attributed to one exact session');
  }
  const candidate = located.result;
  const transcript = surface.verifySpawnTranscript(runtime, candidate.sessionId, {
    spawnNonce: lane.ownership.spawnIntent.spawnNonce,
    promptSha256: lane.ownership.spawnIntent.promptSha256,
    promptMarkerSha256: lane.ownership.spawnIntent.promptMarkerSha256,
  });
  const discovery = surface.discoverExecution(runtime, {
    sessionId: candidate.sessionId, jobId, name: lane.displayName, cwd: lane.seat.path,
  }, candidate);
  lane = bindClaudeSpawnObservation(options.repoRoot, lane.laneId, {
    sessionId: candidate.sessionId, jobId, bridgeId: discovery.bridgeId,
    creationReceipt: creationReceipt(candidate, jobId, discovery, stdout, runtime, transcript),
    bridgeReceipt: bridgeReceipt(discovery),
    epoch: epochFromDiscovery(discovery, operation.operationId),
  }, env);
  lane = updateRunningLane(options.repoRoot, lane, candidate, env, {
    lastVerifiedAt: new Date().toISOString(),
  });
  const presented = await presentLane(options, env, surface, runtime, lane);
  lane = presented.lane;
  removeDurableSpawnReceipts(options.repoRoot, lane, env);
  completePending(options.repoRoot, lane.laneId, operation, {
    state: 'complete', providerId: lane.providerId,
    details: {
      ...operation.details, jobId, bridgeIdSha256: sha256(discovery.bridgeId),
      presentation: presented.presentation.state,
    },
  }, env);
  return { lane, discovery, presentation: presented.presentation };
}

async function spawnLane(options, env = process.env) {
  if (!options.repoRoot || !path.isAbsolute(options.repoRoot) ||
      typeof options.name !== 'string' || !options.name ||
      typeof options.input !== 'string' || !options.input) {
    throw new ClaudeTransmogrifyError('USAGE_ERROR', 'spawn requires absolute repoRoot, name, and input');
  }
  if (options.model !== undefined) assertSafeModelSelector(options.model);
  ensureRegistry(options.repoRoot, env);
  const surface = surfaceFor(options);
  const runtime = preflight(options, env, surface);
  const laneId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const preflightAgents = await surface.agents(runtime);
  const spawnNonce = crypto.randomUUID();
  const marker = `[transmogrify spawn ${spawnNonce}]`;
  const prompt = `${options.input}\n\n${marker}`;
  const argv = claudeSpawnArgs(options.name, prompt, {
    model: options.model,
  });
  const paths = projectPaths(options.repoRoot, env);
  const stdoutPath = path.join(paths.operations, `${operationId}.spawn.stdout`);
  const stderrPath = path.join(paths.operations, `${operationId}.spawn.stderr`);
  const seatIntent = options.cwd ? null : planManagedSeat(
    options.repoRoot, worktreesRoot(options, env), laneId,
    { branchName: options.branchName, baseRef: options.baseRef },
  );
  const externalSeat = options.cwd
    ? verifySeat(options.repoRoot, options.cwd, worktreesRoot(options, env)) : null;
  const spawnIntent = {
    operationId, spawnNonce, displayName: options.name, promptSha256: sha256(options.input),
    promptMarkerSha256: sha256(marker),
    modelSelector: options.model,
    preflightSessionIds: preflightAgents
      .filter((agent) => typeof agent.sessionId === 'string')
      .map((agent) => agent.sessionId.toLowerCase()).sort(),
    stdoutPath, stderrPath,
  };
  let { lane, operation } = reserveSpawn(options.repoRoot, {
    operation: {
      operationId, type: 'spawn', laneId,
      details: {
        target: 'claude', name: options.name, promptSha256: sha256(options.input),
        promptMarkerSha256: sha256(marker), spawnNonce, stdoutPath, stderrPath,
        modelSelector: options.model,
      },
    },
    lane: {
      laneId, backend: BACKEND, displayName: options.name, state: 'planned', operationId,
      capabilities: capabilities(), runtime: publicRuntime(runtime), seat: externalSeat, seatIntent,
      providerIdentity: {
        version: 1, sessionId: null, jobId: null, bridgeId: null,
        executionEpochs: [], runtimeEpochs: [],
      },
      spawnIntent,
    },
  }, env);
  if (!lane.seat) {
    const seat = materializeManagedSeat(options.repoRoot, lane.seatIntent);
    lane = bindLaneSeat(options.repoRoot, lane.laneId, operation.operationId, seat, env);
    operation = pendingOperationForLane(options.repoRoot, lane.laneId, env);
  }
  const dispatchStartedAt = Date.now();
  operation = updatePending(options.repoRoot, lane.laneId, operation, {
    state: 'dispatching', details: { ...operation.details, dispatchStartedAt },
  }, env);
  let launch;
  try {
    launch = await surface.launch(runtime, argv, {
      cwd: lane.seat.path, stdoutPath, stderrPath, timeoutMs: options.launchTimeoutMs,
    });
  } catch (error) {
    const definitelyNotStarted = ['ENOENT', 'EACCES'].includes(error.code);
    if (definitelyNotStarted) {
      operation = updatePending(options.repoRoot, lane.laneId, operation, {
        state: 'notDeliveredCaptureCleanup',
        details: { ...operation.details, errorCode: error.code },
      }, env);
      updateLane(options.repoRoot, lane.laneId, { state: 'failed' }, env);
      removeDurableSpawnReceipts(options.repoRoot, lane, env);
      completePending(options.repoRoot, lane.laneId, operation, {
        state: 'notDelivered', details: { ...operation.details, errorCode: error.code },
      }, env);
    } else {
      updatePending(options.repoRoot, lane.laneId, operation, { state: 'spawnUnknown' }, env);
      updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
    }
    throw new ClaudeTransmogrifyError(
      definitelyNotStarted ? 'NOT_DELIVERED' : 'SPAWN_UNCERTAIN', error.message,
      { laneId: lane.laneId },
    );
  }
  operation = updatePending(options.repoRoot, lane.laneId, operation, {
    state: 'dispatched',
    details: {
      ...operation.details, dispatchFinishedAt: Date.now(),
      stdoutSha256: sha256(launch.stdout), stderrSha256: sha256(launch.stderr),
    },
  }, env);
  let jobId;
  try { jobId = parseJobId(launch.stdout); } catch (error) {
    updatePending(options.repoRoot, lane.laneId, operation, { state: 'spawnUnknown' }, env);
    updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
    throw new ClaudeTransmogrifyError('SPAWN_UNCERTAIN', error.message, { laneId: lane.laneId });
  }
  try {
    const finalized = await finalizeSpawn(options, env, surface, runtime, lane, operation, jobId, launch.stdout);
    if (options.onLaunch) options.onLaunch(finalized.lane);
    return laneResult('spawn', finalized.lane, {
      operationId: operation.operationId,
      receipt: {
        jobId, sessionId: finalized.lane.providerId,
        bridgeIdSha256: sha256(finalized.lane.providerIdentity.bridgeId),
        presentation: finalized.presentation.state,
        requestedModelSelector: finalized.lane.ownership.spawnIntent.modelSelector || null,
      },
    });
  } catch (error) {
    const current = requireOwnedLane(options.repoRoot, lane.laneId, env);
    if (current.pendingOperationId === operation.operationId) {
      updatePending(options.repoRoot, lane.laneId, operation, { state: 'spawnUnknown' }, env);
      if (current.state === 'planned' || current.state === 'created') {
        updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
      }
    }
    throw new ClaudeTransmogrifyError('SPAWN_UNCERTAIN', error.message, {
      laneId: lane.laneId, providerId: current.providerId,
      ...(error.code ? { causeCode: error.code } : {}),
    });
  }
}

async function status(options, env = process.env) {
  let lane = ownedLane(options, env, false);
  if (RETIRED_STATES.has(lane.state) || RETIRING_STATES.has(lane.state)) {
    const phase = RETIRED_STATES.has(lane.state) ? 'retired' : 'retiring';
    return laneResult('status', lane, {
      phase,
      receipt: { durableLifecycle: true, providerInspectionDeferred: true },
    });
  }
  assertSeat(options, lane);
  const surface = surfaceFor(options);
  const runtime = runtimeForLane(options, lane, env, surface);
  const agents = await surface.agents(runtime);
  const agent = surface.exactOwnedAgent(agents, lane.providerIdentity, {
    name: lane.displayName, cwd: lane.seat.path,
  });
  let execution = null;
  if (agent.pid) {
    execution = surface.executionReceipt(runtime, lane, agent);
    ensureLatestEpoch(lane, execution);
    lane = updateRunningLane(options.repoRoot, lane, agent, env);
  } else {
    lane = observedStop(options.repoRoot, lane, null, env);
  }
  const { phase } = phaseForAgent(agent);
  const updated = updateLane(options.repoRoot, lane.laneId, {
    providerState: {
      phase, waiting: Boolean(agent.waitingFor), pid: agent.pid,
    },
    lastVerifiedAt: new Date().toISOString(),
  }, env);
  return laneResult('status', updated, {
    phase,
    receipt: {
      exactSession: true,
      executionEpoch: execution ? updated.providerIdentity.executionEpochs.length : null,
    },
  });
}

async function reconcileSteer(options, env, surface, runtime, lane, operation) {
  let receipt;
  try {
    receipt = surface.verifyDeliveryTranscript(runtime, lane.providerId, {
      messageSha256: operation.details.messageSha256,
      deliveryToken: operation.details.deliveryToken,
    });
  } catch (error) {
    const mutationMayHaveStarted = ['dispatching', 'queued', 'unknown'].includes(operation.state);
    if (!mutationMayHaveStarted && error.code !== 'DELIVERY_UNCERTAIN') throw error;
    if (mutationMayHaveStarted && operation.state !== 'unknown') {
      operation = updatePending(options.repoRoot, lane.laneId, operation, { state: 'unknown' }, env);
    }
    let current = requireOwnedLane(options.repoRoot, lane.laneId, env);
    if (['active', 'idle'].includes(current.state)) {
      current = updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
    }
    return {
      complete: false,
      lane: current,
      error: new ClaudeTransmogrifyError('DELIVERY_UNCERTAIN', error.message, {
        ...(error.code ? { causeCode: error.code } : {}),
      }),
    };
  }
  completePending(options.repoRoot, lane.laneId, operation, {
    state: 'complete', details: { ...operation.details, observation: receipt },
  }, env);
  let current = requireOwnedLane(options.repoRoot, lane.laneId, env);
  const priorLaneState = operation.details.laneStateBeforeDispatch;
  if (current.state === 'deliveryUnknown' && ['active', 'idle'].includes(priorLaneState)) {
    current = updateLane(options.repoRoot, lane.laneId, { state: priorLaneState }, env);
  }
  return { complete: true, receipt, lane: current };
}
async function steer(options, env = process.env) {
  if (typeof options.message !== 'string' || !options.message) {
    throw new ClaudeTransmogrifyError('USAGE_ERROR', 'steer requires a non-empty message');
  }
  if (options.writeTimeoutMs !== undefined &&
      (!Number.isInteger(options.writeTimeoutMs) || options.writeTimeoutMs < 100 ||
        options.writeTimeoutMs > 120_000)) {
    throw new ClaudeTransmogrifyError('USAGE_ERROR', 'invalid Claude follow-up timeout');
  }
  let lane = ownedLane(options, env, true);
  assertSeat(options, lane);
  const surface = surfaceFor(options);
  return withLaneLease(options.repoRoot, lane.laneId, async () => {
    lane = ownedLane({ ...options, laneId: lane.laneId }, env, true);
    const runtime = runtimeForLane(options, lane, env, surface);
    const pending = pendingOperationForLane(options.repoRoot, lane.laneId, env);
    if (pending) {
      if (pending.type !== 'steer') {
        throw new ClaudeTransmogrifyError('PENDING_OPERATION', `lane ${lane.laneId} has unresolved ${pending.type} operation`);
      }
      if (pending.details.messageSha256 !== sha256(options.message)) {
        throw new ClaudeTransmogrifyError('DELIVERY_UNCERTAIN', 'a different Claude steer remains unresolved');
      }
      const reconciled = await reconcileSteer(options, env, surface, runtime, lane, pending);
      if (!reconciled.complete) {
        throw new ClaudeTransmogrifyError('DELIVERY_UNCERTAIN', 'the prior Claude steer remains unobserved', {
          operationId: pending.operationId,
        });
      }
      return laneResult('steer', reconciled.lane, {
        operationId: pending.operationId, delivery: 'deliveredObserved', receipt: reconciled.receipt,
      });
    }
    const agents = await surface.agents(runtime);
    const agent = surface.exactOwnedAgent(agents, lane.providerIdentity, {
      name: lane.displayName, cwd: lane.seat.path,
    });
    if (!agent.pid) throw new ClaudeTransmogrifyError('INVALID_STATE', 'Claude lane is stopped');
    const execution = surface.executionReceipt(runtime, lane, agent);
    const epoch = ensureLatestEpoch(lane, execution);
    const deliveryToken = crypto.randomUUID();
    const framed = `${options.message}\n\n[transmogrify delivery ${deliveryToken}]`;
    if (options.message.includes('\0') || /[\uD800-\uDFFF]/u.test(options.message) ||
        Buffer.byteLength(framed, 'utf8') > MAX_STEER_BYTES) {
      throw new ClaudeTransmogrifyError(
        'USAGE_ERROR',
        `Claude steer input plus its delivery receipt must not exceed ${MAX_STEER_BYTES} bytes`,
      );
    }
    const snapshot = surface.transcriptSnapshot(runtime, lane.providerId);
    let operation = beginLaneOperation(options.repoRoot, lane.laneId, {
      type: 'steer', providerId: lane.providerId,
      details: {
        target: 'claude', mode: 'queuedSafePointPublicCli', messageSha256: sha256(options.message),
        deliveryToken, deliveryTokenSha256: sha256(deliveryToken), executionEpochId: epoch.epochId,
        laneStateBeforeDispatch: ['active', 'idle'].includes(lane.state) ? lane.state : null,
        transcript: { device: snapshot.device, inode: snapshot.inode, offset: snapshot.offset },
      },
    }, env);
    try {
      operation = updatePending(options.repoRoot, lane.laneId, operation, {
        state: 'dispatching',
        details: { ...operation.details, dispatchStartedAt: Date.now() },
      }, env);
      const write = await surface.sendRemoteFollowup(
        runtime,
        lane.providerIdentity.bridgeId,
        framed,
        { cwd: lane.seat.path, timeoutMs: options.writeTimeoutMs },
      );
      operation = updatePending(options.repoRoot, lane.laneId, operation, {
        state: 'queued',
        details: {
          ...operation.details,
          dispatchFinishedAt: Date.now(),
          providerAcknowledged: write.queued,
          providerSessionIdSha256: write.sessionIdSha256,
          stdoutSha256: write.stdoutSha256,
          stderrSha256: write.stderrSha256,
        },
      }, env);
    } catch (error) {
      if (error.code === 'NOT_DELIVERED') {
        completePending(options.repoRoot, lane.laneId, operation, { state: 'notDelivered' }, env);
      } else {
        updatePending(options.repoRoot, lane.laneId, operation, { state: 'unknown' }, env);
        updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
      }
      throw new ClaudeTransmogrifyError(
        error.code === 'NOT_DELIVERED' ? 'NOT_DELIVERED' : 'DELIVERY_UNCERTAIN',
        error.message,
        error.code && error.code !== 'DELIVERY_UNCERTAIN' ? { causeCode: error.code } : {},
      );
    }
    try {
      const observed = await surface.waitForTranscriptDelivery(
        snapshot, framed, options.deliveryObserveTimeoutMs,
      );
      completePending(options.repoRoot, lane.laneId, operation, {
        state: 'complete', details: { ...operation.details, observation: observed },
      }, env);
      return laneResult('steer', lane, {
        operationId: operation.operationId, delivery: 'deliveredObserved',
        receipt: {
          mode: 'queuedSafePointPublicCli', observation: observed.state,
          observedAtOffset: observed.offset, deliveryTokenSha256: sha256(deliveryToken),
        },
      });
    } catch (error) {
      updatePending(options.repoRoot, lane.laneId, operation, { state: 'unknown' }, env);
      updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
      throw new ClaudeTransmogrifyError('DELIVERY_UNCERTAIN', error.message, {
        queued: true, operationId: operation.operationId,
      });
    }
  }, env);
}

async function exactAgent(surface, runtime, lane) {
  return surface.exactOwnedAgent(await surface.agents(runtime), lane.providerIdentity, {
    name: lane.displayName, cwd: lane.seat.path,
  });
}
async function stopOwnedLane(options, env, surface, runtime, lane, operation, allowMutation = true) {
  let agent = await exactAgent(surface, runtime, lane);
  if (agent.pid === null) {
    lane = observedStop(options.repoRoot, lane, operation, env, { alreadyStopped: true });
    return { lane, alreadyStopped: true };
  }
  if (!allowMutation) return { lane, pending: true, agent };
  if (operation.state !== 'planned') {
    throw new ClaudeTransmogrifyError(
      'STOP_UNCERTAIN',
      `Claude stop operation ${operation.operationId} remains ${operation.state}; refusing to replay it`,
      { operationId: operation.operationId },
    );
  }
  const execution = surface.executionReceipt(runtime, lane, agent);
  ensureLatestEpoch(lane, execution);
  const immediateAgents = await surface.agents(runtime);
  agent = surface.exactOwnedAgent(immediateAgents, lane.providerIdentity, {
    name: lane.displayName, cwd: lane.seat.path,
  });
  if (!agent.pid || agent.pid !== execution.pid) {
    throw new ClaudeTransmogrifyError('STOP_UNCERTAIN', 'Claude worker changed immediately before stop');
  }
  if (lane.state !== 'stopRequested') {
    lane = updateLane(options.repoRoot, lane.laneId, { state: 'stopRequested' }, env);
  }
  operation = updateOperationJournal(
    options.repoRoot, lane.laneId, operation, { state: 'dispatching' }, env,
  );
  try {
    await surface.run(runtime, ['stop', lane.providerIdentity.jobId], {
      cwd: lane.seat.path, timeoutMs: options.commandTimeoutMs,
    });
    operation = updateOperationJournal(
      options.repoRoot, lane.laneId, operation, { state: 'dispatched' }, env,
    );
  } catch {
    try {
      updateOperationJournal(options.repoRoot, lane.laneId, operation, { state: 'unknown' }, env);
    } catch {}
    updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
    throw new ClaudeTransmogrifyError('STOP_UNCERTAIN', 'Claude stop outcome is unknown');
  }
  const stopped = await pollAgents(surface, runtime, (agents) => {
    try {
      const row = surface.exactOwnedAgent(agents, lane.providerIdentity, {
        name: lane.displayName, cwd: lane.seat.path,
      });
      return row.pid === null ? row : null;
    } catch { return null; }
  }, { attempts: options.stopVerifyAttempts, delayMs: options.stopVerifyDelayMs });
  if (!stopped) {
    updateOperationJournal(options.repoRoot, lane.laneId, operation, { state: 'unknown' }, env);
    updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
    throw new ClaudeTransmogrifyError('STOP_UNCERTAIN', 'Claude stop was not verified');
  }
  lane = observedStop(options.repoRoot, lane, operation, env, { stopVerified: true });
  return { lane, alreadyStopped: false };
}
function unresolvedEmergencyStop(repoRoot, laneId, env) {
  const unfinished = listOperations(repoRoot, env).filter((operation) =>
    operation.laneId === laneId && operation.type === 'stop' &&
    operation.details.emergency === true &&
    !['complete', 'notDelivered'].includes(operation.state)
  );
  if (unfinished.length > 1) {
    throw new ClaudeTransmogrifyError(
      'STOP_UNCERTAIN',
      `lane ${laneId} has multiple unresolved emergency stop journals; refusing another mutation`,
    );
  }
  return unfinished[0] || null;
}
async function stop(options, env = process.env) {
  let lane = ownedLane(options, env, false);
  if (RETIRED_STATES.has(lane.state)) {
    throw new ClaudeTransmogrifyError('LANE_RETIRED', `lane ${lane.laneId} is retired`);
  }
  assertSeat(options, lane);
  const surface = surfaceFor(options);
  return withLaneLease(options.repoRoot, lane.laneId, async () => {
    lane = ownedLane({ ...options, laneId: lane.laneId }, env, false);
    const runtime = runtimeForLane(options, lane, env, surface);
    const existing = pendingOperationForLane(options.repoRoot, lane.laneId, env);
    const priorEmergency = unresolvedEmergencyStop(options.repoRoot, lane.laneId, env);
    const selected = priorEmergency
      ? { operation: priorEmergency, emergency: true }
      : existing && existing.type !== 'stop'
      ? {
        operation: beginOperation(options.repoRoot, {
          type: 'stop', laneId: lane.laneId, providerId: lane.providerId,
          details: {
            target: 'claude', mode: 'wholeSession', emergency: true,
            preservedPendingOperationId: existing.operationId,
          },
        }, env),
        emergency: true,
      }
      : operationForType(options.repoRoot, lane, 'stop', env, {
        target: 'claude', mode: 'wholeSession',
      });
    const result = await stopOwnedLane(
      options, env, surface, runtime, lane, selected.operation, true,
    );
    completeOperationJournal(
      options.repoRoot, lane.laneId, selected.operation, { state: 'complete' }, env,
    );
    return laneResult('stop', result.lane, {
      operationId: selected.operation.operationId,
      receipt: { mode: 'wholeSession', alreadyStopped: result.alreadyStopped },
    });
  }, env);
}

function correlatedRecoveryCopies(agents, lane, operation) {
  const baseline = new Set(operation.details.baselineSessionIds || []);
  const started = operation.details.dispatchStartedAt;
  const notAfter = operation.details.dispatchNotAfter;
  return agents.filter((agent) => {
    if (!agent?.sessionId || agent.sessionId === lane.providerId || baseline.has(agent.sessionId) ||
        agent.name !== lane.displayName) return false;
    try { if (fs.realpathSync(agent.cwd) !== lane.seat.path) return false; } catch { return false; }
    const startedAt = typeof agent.startedAt === 'number' ? agent.startedAt : Date.parse(agent.startedAt);
    return Number.isFinite(startedAt) && Number.isFinite(started) && Number.isFinite(notAfter) &&
      startedAt >= started - 5000 && startedAt <= notAfter;
  });
}
async function observeRecovery(options, env, surface, runtime, lane, operation) {
  const located = await pollAgents(surface, runtime, (agents) => {
    const copies = correlatedRecoveryCopies(agents, lane, operation);
    if (copies.length) return { forked: copies.map((agent) => agent.sessionId) };
    try {
      const agent = surface.exactOwnedAgent(agents, lane.providerIdentity, {
        name: lane.displayName, cwd: lane.seat.path,
      });
      return agent.pid ? { agent } : null;
    } catch { return null; }
  }, { attempts: options.recoveryVerifyAttempts, delayMs: options.recoveryVerifyDelayMs });
  if (!located) return null;
  if (located.result.forked) {
    throw new ClaudeTransmogrifyError(
      'FORKED_COPY', 'Claude recovery correlated a new session with this lane; no copy was touched',
      { correlatedCopies: located.result.forked.length },
    );
  }
  const discovery = surface.discoverExecution(runtime, {
    sessionId: lane.providerId, jobId: lane.providerIdentity.jobId,
    name: lane.displayName, cwd: lane.seat.path,
  }, located.result.agent);
  if (discovery.bridgeId !== lane.providerIdentity.bridgeId) {
    throw new ClaudeTransmogrifyError('RECOVERY_UNCERTAIN', 'Claude recovery returned a different Remote Control bridge');
  }
  if (!sameExecutionEpoch(latestEpoch(lane), discovery)) {
    lane = appendLaneExecutionEpoch(
      options.repoRoot, lane.laneId, epochFromDiscovery(discovery, operation.operationId), env,
    );
  }
  lane = updateRunningLane(options.repoRoot, lane, located.result.agent, env, {
    lastVerifiedAt: new Date().toISOString(),
  });
  const presented = await presentLane(options, env, surface, runtime, lane);
  lane = presented.lane;
  completePending(options.repoRoot, lane.laneId, operation, {
    state: 'complete',
    details: {
      ...operation.details, sameSessionId: true, sameJobId: true, sameBridgeId: true,
      presentation: presented.presentation.state,
    },
  }, env);
  return { lane, presentation: presented.presentation };
}
async function recover(options, env = process.env) {
  let lane = ownedLane(options, env, false);
  assertSeat(options, lane);
  const surface = surfaceFor(options);
  return withLaneLease(options.repoRoot, lane.laneId, async () => {
    lane = ownedLane({ ...options, laneId: lane.laneId }, env, false);
    const runtime = runtimeForLane(options, lane, env, surface);
    const pending = pendingOperationForLane(options.repoRoot, lane.laneId, env);
    if (pending) {
      if (pending.type !== 'recover') {
        throw new ClaudeTransmogrifyError('PENDING_OPERATION', `lane ${lane.laneId} has unresolved ${pending.type} operation`);
      }
      try {
        const observed = await observeRecovery(options, env, surface, runtime, lane, pending);
        if (!observed) throw new ClaudeTransmogrifyError('RECOVERY_UNCERTAIN', 'prior Claude recovery remains unverified');
        return laneResult('recover', observed.lane, {
          operationId: pending.operationId,
          receipt: {
            sameSessionId: true, sameJobId: true, sameBridgeId: true,
            executionEpoch: observed.lane.providerIdentity.executionEpochs.length,
            presentation: observed.presentation.state,
          },
        });
      } catch (error) {
        throw new ClaudeTransmogrifyError('RECOVERY_UNCERTAIN', error.message, {
          ...(error.details || {}),
          ...(error.code ? { causeCode: error.code } : {}),
        });
      }
    }
    if (lane.state !== 'stopped') {
      throw new ClaudeTransmogrifyError('INVALID_STATE', `Claude recovery requires stopped, got ${lane.state}`);
    }
    const before = await surface.agents(runtime);
    const stoppedAgent = surface.exactOwnedAgent(before, lane.providerIdentity, {
      name: lane.displayName, cwd: lane.seat.path,
    });
    if (stoppedAgent.pid !== null) {
      throw new ClaudeTransmogrifyError('RECOVERY_UNCERTAIN', 'Claude session is already running outside this recovery');
    }
    const dispatchStartedAt = Date.now();
    const commandWindowMs = options.commandTimeoutMs ?? 30_000;
    let operation = beginLaneOperation(options.repoRoot, lane.laneId, {
      type: 'recover', providerId: lane.providerId,
      details: {
        target: 'claude', argvContract: 'resume-full-session-bg-no-extra-flags',
        baselineSessionIds: before
          .filter((agent) => typeof agent.sessionId === 'string')
          .map((agent) => agent.sessionId.toLowerCase()).sort(),
        dispatchStartedAt,
        dispatchNotAfter: dispatchStartedAt + commandWindowMs + 5000,
      },
    }, env);
    lane = updateLane(options.repoRoot, lane.laneId, { state: 'recoverRequested' }, env);
    operation = updatePending(options.repoRoot, lane.laneId, operation, {
      state: 'dispatching',
    }, env);
    try {
      const dispatched = await surface.run(runtime, ['--resume', lane.providerId, '--bg'], {
        cwd: lane.seat.path, timeoutMs: options.commandTimeoutMs,
      });
      operation = updatePending(options.repoRoot, lane.laneId, operation, {
        state: 'dispatched',
        details: {
          ...operation.details, dispatchFinishedAt: Date.now(),
          stdoutSha256: sha256(dispatched.stdout || ''), stderrSha256: sha256(dispatched.stderr || ''),
        },
      }, env);
    } catch (error) {
      updatePending(options.repoRoot, lane.laneId, operation, { state: 'unknown' }, env);
      updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
      throw new ClaudeTransmogrifyError('RECOVERY_UNCERTAIN', error.message);
    }
    try {
      const observed = await observeRecovery(options, env, surface, runtime, lane, operation);
      if (!observed) throw new ClaudeTransmogrifyError('RECOVERY_UNCERTAIN', 'same-session Claude recovery was not verified');
      return laneResult('recover', observed.lane, {
        operationId: operation.operationId,
        receipt: {
          sameSessionId: true, sameJobId: true, sameBridgeId: true,
          executionEpoch: observed.lane.providerIdentity.executionEpochs.length,
          presentation: observed.presentation.state,
        },
      });
    } catch (error) {
      const current = requireOwnedLane(options.repoRoot, lane.laneId, env);
      if (current.pendingOperationId === operation.operationId) {
        updatePending(options.repoRoot, lane.laneId, operation, { state: 'unknown' }, env);
        if (current.state === 'recoverRequested') {
          updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
        }
      }
      throw new ClaudeTransmogrifyError('RECOVERY_UNCERTAIN', error.message, {
        ...(error.details || {}),
        ...(error.code ? { causeCode: error.code } : {}),
      });
    }
  }, env);
}

function exactLocalAgentOrAbsent(surface, agents, lane) {
  const matches = agents.filter((agent) => agent?.sessionId === lane.providerId);
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new ClaudeTransmogrifyError('OWNERSHIP_MISMATCH', 'exact owned Claude session is not uniquely listed');
  }
  return surface.exactOwnedAgent(agents, lane.providerIdentity, {
    name: lane.displayName, cwd: lane.seat.path,
  });
}
async function verifyRetirementStopped(options, env, surface, runtime, lane, operation) {
  let agents = await surface.agents(runtime);
  let agent = exactLocalAgentOrAbsent(surface, agents, lane);
  if (agent?.pid) {
    const execution = surface.executionReceipt(runtime, lane, agent);
    ensureLatestEpoch(lane, execution);
    agents = await surface.agents(runtime);
    agent = exactLocalAgentOrAbsent(surface, agents, lane);
    if (!agent || !agent.pid || agent.pid !== execution.pid) {
      throw new ClaudeTransmogrifyError('STOP_UNCERTAIN', 'Claude worker changed before retirement stop');
    }
    throw new ClaudeTransmogrifyError(
      'STOP_UNCERTAIN',
      'Claude session is running after its retirement stop; refusing another stop mutation',
    );
  }
  if (operation.details.stopVerified !== true) {
    operation = updatePending(options.repoRoot, lane.laneId, operation, {
      state: operation.state,
      details: { ...operation.details, stopVerified: true },
    }, env);
  }
  return operation;
}
function exactLocalRecordAfterSeatRemoval(agents, lane, expected = null) {
  const matches = agents.filter((agent) => agent?.sessionId === lane.providerId);
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new ClaudeTransmogrifyError('OWNERSHIP_MISMATCH', 'exact owned Claude session is not uniquely listed');
  }
  const agent = matches[0];
  if (agent.pid !== null || agent.name !== lane.displayName ||
      typeof agent.cwd !== 'string' || path.resolve(agent.cwd) !== lane.seat.path ||
      (agent.id !== undefined &&
        (typeof agent.id !== 'string' || agent.id.toLowerCase() !== lane.providerIdentity.jobId.toLowerCase()))) {
    throw new ClaudeTransmogrifyError(
      'OWNERSHIP_MISMATCH',
      'Claude local record no longer matches the archived owned lane',
    );
  }
  assertUniqueShortJobId(agents, lane.providerIdentity);
  if (expected && (expected.sessionId !== agent.sessionId ||
      expected.jobId !== lane.providerIdentity.jobId || expected.name !== agent.name ||
      expected.cwd !== path.resolve(agent.cwd))) {
    throw new ClaudeTransmogrifyError('OWNERSHIP_MISMATCH', 'Claude local removal target changed');
  }
  return agent;
}
function localRemovalTarget(lane, agent) {
  return {
    sessionId: agent.sessionId,
    jobId: lane.providerIdentity.jobId,
    name: agent.name,
    cwd: path.resolve(agent.cwd),
  };
}
function localRemovalIdentityFailure(error, lane) {
  return new ClaudeTransmogrifyError(error.code || 'OWNERSHIP_MISMATCH', error.message, {
    providerMutation: 'verified',
    providerRetired: true,
    laneId: lane.laneId,
    stop: 'verified',
    archive: 'verified',
    cleanup: 'verified',
    localRemoval: 'notAttempted',
  });
}
function localRemovalStageFailure(error, lane, localRemoval) {
  return new ClaudeTransmogrifyError(error.code || 'OPERATOR_ERROR', error.message, {
    ...(error.details || {}),
    ...(typeof error.code === 'string' ? { causeCode: error.code } : {}),
    providerMutation: localRemoval === 'unknown' ? 'unknown' : 'verified',
    providerRetired: true,
    laneId: lane.laneId,
    stop: 'verified',
    archive: 'verified',
    cleanup: 'verified',
    localRemoval,
  });
}
async function retire(options, env = process.env) {
  let lane = ownedLane(options, env, false);
  const existingRetirement = pendingOperationForLane(options.repoRoot, lane.laneId, env);
  if (lane.state === 'worktreeRemoved' && !existingRetirement) {
    return laneResult('retire', lane, { receipt: { retired: true, alreadyRetired: true } });
  }
  const recoveringAbsentManagedSeat = lane.seat?.managed === true &&
    existingRetirement?.type === 'retire' && RETIRED_STATES.has(lane.state) &&
    !fs.existsSync(lane.seat.path);
  if (!recoveringAbsentManagedSeat) assertSeat(options, lane);
  const surface = surfaceFor(options);
  return withLaneLease(options.repoRoot, lane.laneId, async () => {
    lane = ownedLane({ ...options, laneId: lane.laneId }, env, false);
    let pending = pendingOperationForLane(options.repoRoot, lane.laneId, env);
    if (pending && pending.type !== 'retire') {
      throw new ClaudeTransmogrifyError('PENDING_OPERATION', `lane ${lane.laneId} has unresolved ${pending.type} operation`);
    }
    if (!pending) {
      if (!SHA256_PATTERN.test(options.harvestedOutputSha256 || '')) {
        throw new ClaudeTransmogrifyError(
          'HARVEST_REQUIRED', 'Claude retirement requires a durable lowercase harvestedOutputSha256',
        );
      }
      const harvestReceipt = captureHarvestReceipt(
        options.repoRoot, lane.seat, options.harvestedOutputSha256,
      );
      pending = beginLaneOperation(options.repoRoot, lane.laneId, {
        type: 'retire', providerId: lane.providerId,
        details: {
          target: 'claude', ordering: 'harvest-stop-remoteArchive-worktree-localRemove',
          harvestReceipt,
          ...(RETIRED_STATES.has(lane.state) ? { remoteArchived: true } : {}),
        },
      }, env);
    } else if (options.harvestedOutputSha256 !== undefined &&
        pending.details.harvestReceipt?.outputSha256 !== options.harvestedOutputSha256) {
      throw new ClaudeTransmogrifyError('HARVEST_MISMATCH', 'retirement harvest digest does not match its durable receipt');
    }
    const harvestReceipt = pending.details.harvestReceipt;
    if (!harvestReceipt || !SHA256_PATTERN.test(harvestReceipt.outputSha256 || '')) {
      throw new ClaudeTransmogrifyError('HARVEST_REQUIRED', 'pending Claude retirement has no valid harvest receipt');
    }
    if (pending.details.cleanupBlocked === true) {
      throw new ClaudeTransmogrifyError(
        'CLEANUP_BLOCKED',
        'Claude managed worktree has a permanent cleanup block and requires manual review',
        { providerRetired: true, laneId: lane.laneId },
      );
    }
    let runtime = null;
    let privateApi = null;
    if (pending.details.remoteArchived !== true) {
      runtime = runtimeForLane(options, lane, env, surface);
      if (lane.state !== 'localRemovalPending') {
        if (options.privateArchive !== true) {
          throw new ClaudeTransmogrifyError(
            'PRIVATE_API_DISABLED', 'Claude retirement requires explicit private archive authorization',
          );
        }
        privateApi = options.privateApi || require('./claude-private-api').createClaudePrivateApi();
        privateApi.preflight(runtime);
      }
      if (!RETIRING_STATES.has(lane.state)) {
        const stopped = await stopOwnedLane(options, env, surface, runtime, lane, pending, true);
        lane = stopped.lane;
        pending = pendingOperationForLane(options.repoRoot, lane.laneId, env);
        lane = updateLane(options.repoRoot, lane.laneId, { state: 'retireRequested' }, env);
      }
      if (lane.state !== 'localRemovalPending') {
        try {
          pending = await verifyRetirementStopped(
            options, env, surface, runtime, lane, pending,
          );
          const priorArchiveDispatchUnknown = lane.state === 'archiveUnknown' ||
            pending.state === 'unknown';
          const archiveMethod = priorArchiveDispatchUnknown ? 'verifyArchived' : 'ensureArchived';
          if (typeof privateApi[archiveMethod] !== 'function') {
            throw new ClaudeTransmogrifyError(
              'REMOTE_ARCHIVE_UNCERTAIN',
              'prior Claude archive dispatch requires read-only verification',
              { archiveDispatched: priorArchiveDispatchUnknown },
            );
          }
          const archive = await privateApi[archiveMethod]({
            bridgeId: lane.providerIdentity.bridgeId, runtime,
            attempts: options.archiveVerifyAttempts, delayMs: options.archiveVerifyDelayMs,
            timeoutMs: options.archiveTimeoutMs,
          });
          pending = updatePending(options.repoRoot, lane.laneId, pending, {
            state: 'remoteArchived',
            details: {
              ...pending.details, remoteArchived: true,
              remoteArchiveAlreadySet: archive.alreadyArchived,
            },
          }, env);
        } catch (error) {
          const archiveDispatched = lane.state === 'archiveUnknown' ||
            pending.state === 'unknown' || error.details?.archiveDispatched === true;
          const current = requireOwnedLane(options.repoRoot, lane.laneId, env);
          const latestPending = pendingOperationForLane(options.repoRoot, lane.laneId, env) || pending;
          const stopVerified = latestPending.details.stopVerified === true;
          if (archiveDispatched && current.state === 'retireRequested') {
            lane = updateLane(options.repoRoot, lane.laneId, { state: 'archiveUnknown' }, env);
          }
          pending = updatePending(options.repoRoot, lane.laneId, latestPending, {
            state: archiveDispatched ? 'unknown' : 'archiveNotDispatched',
            details: {
              ...latestPending.details,
              ...(archiveDispatched ? {} : { archiveNotDispatched: true }),
            },
          }, env);
          throw new ClaudeTransmogrifyError(
            error.code || 'REMOTE_ARCHIVE_UNCERTAIN',
            error.message,
            {
              ...(error.details || {}),
              ...(typeof error.code === 'string' ? { causeCode: error.code } : {}),
              ...(stopVerified ? {
                providerMutation: archiveDispatched ? 'unknown' : 'verified',
                stop: 'verified',
                archive: archiveDispatched ? 'unknown' : 'notAttempted',
              } : {}),
            },
          );
        }
      } else {
        pending = updatePending(options.repoRoot, lane.laneId, pending, {
          state: 'remoteArchived', details: { ...pending.details, remoteArchived: true },
        }, env);
      }
    }
    if (lane.state !== 'archivedVerified' && lane.state !== 'worktreeRemoved') {
      lane = updateLane(options.repoRoot, lane.laneId, {
        state: 'archivedVerified', lastVerifiedAt: new Date().toISOString(),
      }, env);
    }

    if (lane.seat.managed !== true) {
      const cleanup = { attempted: false, removed: false, external: true };
      completePending(options.repoRoot, lane.laneId, pending, {
        state: 'complete',
        details: {
          ...pending.details, remoteArchived: true, localRemovalDeferred: true, cleanup,
        },
      }, env);
      return laneResult('retire', lane, {
        operationId: pending.operationId,
        receipt: {
          remoteArchived: true, localJobRemoved: false, localRemovalDeferred: true,
          harvestedOutputSha256: harvestReceipt.outputSha256, worktree: cleanup,
        },
      });
    }
    if (options.cleanupWorktree === false && lane.state !== 'worktreeRemoved') {
      pending = updatePending(options.repoRoot, lane.laneId, pending, {
        state: 'cleanupDeferred',
        details: {
          ...pending.details, cleanupDeferred: true, localRemovalDeferred: true,
          remoteArchived: true,
        },
      }, env);
      return laneResult('retire', lane, {
        operationId: pending.operationId,
        receipt: {
          remoteArchived: true, localJobRemoved: false, localRemovalDeferred: true,
          harvestedOutputSha256: harvestReceipt.outputSha256,
          worktree: { attempted: false, removed: false, deferred: true },
        },
      });
    }

    let cleanup;
    if (lane.state === 'worktreeRemoved') {
      cleanup = pending.details.cleanup ||
        { attempted: true, removed: true, recoveredAfterRemoval: true };
    } else {
      cleanup = { attempted: true, removed: false };
      try {
        const result = removeManagedSeat(options.repoRoot, lane.laneId, harvestReceipt, env);
        lane = result.lane;
        cleanup.removed = true;
      } catch (error) {
        if (!isPermanentCleanupError(error)) {
          updatePending(options.repoRoot, lane.laneId, pending, {
            state: 'providerRetiredCleanupDeferred',
            details: { ...pending.details, cleanupRetryable: true },
          }, env);
          throw new ClaudeTransmogrifyError(
            'CLEANUP_RETRYABLE',
            'Claude provider is retired; managed worktree cleanup failed locally and is safe to retry',
            { providerRetired: true, laneId: lane.laneId },
          );
        }
        updatePending(options.repoRoot, lane.laneId, pending, {
          state: 'providerRetiredCleanupBlocked',
          details: { ...pending.details, cleanupBlocked: true },
        }, env);
        throw new ClaudeTransmogrifyError('CLEANUP_BLOCKED', error.message, {
          providerRetired: true, laneId: lane.laneId,
        });
      }
      pending = updatePending(options.repoRoot, lane.laneId, pending, {
        state: 'worktreeRemoved', details: { ...pending.details, cleanup },
      }, env);
    }
    if (fs.existsSync(lane.seat.path)) {
      throw new ClaudeTransmogrifyError(
        'CLEANUP_BLOCKED', 'Claude local record removal requires the managed worktree to be absent',
        { providerRetired: true, laneId: lane.laneId },
      );
    }

    if (pending.details.localRemoved !== true) {
      let agents;
      try {
        runtime ||= runtimeForLane(options, lane, env, surface);
        agents = await surface.agents(runtime);
      } catch (error) {
        throw localRemovalStageFailure(error, lane, 'notAttempted');
      }
      let local;
      try {
        local = exactLocalRecordAfterSeatRemoval(
          agents, lane, pending.details.localRemovalTarget || null,
        );
      } catch (error) {
        throw localRemovalIdentityFailure(error, lane);
      }
      if (!local) {
        pending = updatePending(options.repoRoot, lane.laneId, pending, {
          state: 'localRemoved',
          details: { ...pending.details, localRemoved: true, localRemovalObservedAbsent: true },
        }, env);
      } else {
        if (['localRemovalDispatching', 'localRemovalDispatched', 'localRemovalUnknown']
          .includes(pending.state)) {
          throw localRemovalStageFailure(new ClaudeTransmogrifyError(
            'LOCAL_REMOVAL_UNCERTAIN',
            'prior Claude local removal remains unresolved; refusing to replay it',
          ), lane, 'unknown');
        }
        const target = pending.details.localRemovalTarget || localRemovalTarget(lane, local);
        let dispatchAgents;
        try {
          dispatchAgents = await surface.agents(runtime);
        } catch (error) {
          throw localRemovalStageFailure(error, lane, 'notAttempted');
        }
        let dispatchLocal;
        try {
          dispatchLocal = exactLocalRecordAfterSeatRemoval(dispatchAgents, lane, target);
        } catch (error) {
          throw localRemovalIdentityFailure(error, lane);
        }
        if (!dispatchLocal) {
          pending = updatePending(options.repoRoot, lane.laneId, pending, {
            state: 'localRemoved',
            details: { ...pending.details, localRemoved: true, localRemovalObservedAbsent: true },
          }, env);
        } else {
          pending = updatePending(options.repoRoot, lane.laneId, pending, {
            state: 'localRemovalDispatching',
            details: {
              ...pending.details, localRemovalTarget: target,
              localRemovalDispatchStartedAt: Date.now(),
            },
          }, env);
          try {
            await surface.run(runtime, ['rm', lane.providerIdentity.jobId], {
              cwd: options.repoRoot, timeoutMs: options.commandTimeoutMs,
            });
            pending = updatePending(options.repoRoot, lane.laneId, pending, {
              state: 'localRemovalDispatched',
              details: { ...pending.details, localRemovalDispatchFinishedAt: Date.now() },
            }, env);
          } catch (error) {
            try {
              updatePending(options.repoRoot, lane.laneId, pending, { state: 'localRemovalUnknown' }, env);
            } catch {}
            throw localRemovalStageFailure(new ClaudeTransmogrifyError(
              'LOCAL_REMOVAL_UNCERTAIN',
              'Claude local job removal outcome is unknown',
              { ...(typeof error?.code === 'string' ? { causeCode: error.code } : {}) },
            ), lane, 'unknown');
          }
          let removed;
          try {
            removed = await pollAgents(surface, runtime, (listed) =>
              listed.some((agent) => agent?.sessionId === lane.providerId) ? null : true,
            { attempts: options.removeVerifyAttempts, delayMs: options.removeVerifyDelayMs });
          } catch (error) {
            try {
              updatePending(options.repoRoot, lane.laneId, pending, { state: 'localRemovalUnknown' }, env);
            } catch {}
            throw localRemovalStageFailure(error, lane, 'unknown');
          }
          if (!removed) {
            updatePending(options.repoRoot, lane.laneId, pending, { state: 'localRemovalUnknown' }, env);
            throw localRemovalStageFailure(new ClaudeTransmogrifyError(
              'LOCAL_REMOVAL_UNCERTAIN', 'Claude local job removal was not verified',
            ), lane, 'unknown');
          }
          pending = updatePending(options.repoRoot, lane.laneId, pending, {
            state: 'localRemoved', details: { ...pending.details, localRemoved: true },
          }, env);
        }
      }
    }
    completePending(options.repoRoot, lane.laneId, pending, {
      state: 'complete',
      details: {
        ...pending.details, remoteArchived: true, localRemoved: true, cleanup,
      },
    }, env);
    return laneResult('retire', lane, {
      operationId: pending.operationId,
      receipt: {
        remoteArchived: true, localJobRemoved: true, localRemovalDeferred: false,
        harvestedOutputSha256: harvestReceipt.outputSha256, worktree: cleanup,
      },
    });
  }, env);
}

async function reconcilePendingSpawn(options, env, surface, runtime, lane, operation) {
  assertSpawnSelection(lane, operation);
  if (!lane.seat && lane.seatIntent) {
    const seat = materializeManagedSeat(options.repoRoot, lane.seatIntent);
    lane = bindLaneSeat(options.repoRoot, lane.laneId, operation.operationId, seat, env);
    operation = pendingOperationForLane(options.repoRoot, lane.laneId, env);
  }
  if (operation.state === 'notDeliveredCaptureCleanup') {
    removeDurableSpawnReceipts(options.repoRoot, lane, env);
    if (lane.state !== 'failed') lane = updateLane(options.repoRoot, lane.laneId, { state: 'failed' }, env);
    completePending(options.repoRoot, lane.laneId, operation, { state: 'notDelivered' }, env);
    return { lane, outcome: 'spawnNotDelivered' };
  }
  if (lane.providerId) {
    const agent = await exactAgent(surface, runtime, lane);
    if (agent.pid === null) lane = observedStop(options.repoRoot, lane, operation, env);
    else {
      const execution = surface.executionReceipt(runtime, lane, agent);
      ensureLatestEpoch(lane, execution);
      lane = updateRunningLane(options.repoRoot, lane, agent, env);
    }
    const presented = await presentLane(options, env, surface, runtime, lane);
    removeDurableSpawnReceipts(options.repoRoot, lane, env);
    completePending(options.repoRoot, lane.laneId, operation, {
      state: 'complete', details: { ...operation.details, presentation: presented.presentation.state },
    }, env);
    return { lane: presented.lane, outcome: 'spawnVerified', presentation: presented.presentation.state };
  }
  const receipt = readDurableSpawnReceipt(options.repoRoot, lane, env);
  if (!receipt) {
    if (['planned', 'seatReady'].includes(operation.state)) {
      completePending(options.repoRoot, lane.laneId, operation, { state: 'notDelivered' }, env);
      lane = updateLane(options.repoRoot, lane.laneId, { state: 'failed' }, env);
      return { lane, outcome: 'spawnNotDelivered' };
    }
    return { lane, outcome: 'spawnUnknown' };
  }
  let jobId;
  try { jobId = parseJobId(receipt.stdout); } catch { return { lane, outcome: 'spawnUnknown' }; }
  if (!Number.isFinite(operation.details.dispatchStartedAt)) return { lane, outcome: 'spawnUnknown' };
  const normalized = operation.details.dispatchFinishedAt ? operation : updatePending(
    options.repoRoot, lane.laneId, operation,
    { state: operation.state, details: { ...operation.details, dispatchFinishedAt: receipt.modifiedAt } }, env,
  );
  const finalized = await finalizeSpawn(
    options, env, surface, runtime, lane, normalized, jobId, receipt.stdout,
  );
  return {
    lane: finalized.lane, outcome: 'spawnBoundFromDurableReceipt',
    presentation: finalized.presentation.state,
  };
}
async function reconcilePendingStop(options, env, surface, runtime, lane, operation) {
  const result = await stopOwnedLane(options, env, surface, runtime, lane, operation, false);
  if (result.pending) return { lane, outcome: 'stopPending' };
  completePending(options.repoRoot, lane.laneId, operation, { state: 'complete' }, env);
  return { lane: result.lane, outcome: 'stoppedObserved' };
}
async function bindRuntimeTransition(options, env, surface, runtime, initial) {
  let lane = requireOwnedLane(options.repoRoot, initial.laneId, env);
  const previousRuntime = effectiveRuntime(lane);
  if (!sameRuntimeIdentity(previousRuntime, publicRuntime(runtime))) {
    throw new ClaudeTransmogrifyError(
      'RUNTIME_MISMATCH',
      'Claude runtime transition changes the account, config, platform, or protocol identity',
    );
  }
  assertSeat(options, lane);
  const agents = await surface.agents(runtime);
  const agent = surface.exactOwnedAgent(agents, lane.providerIdentity, {
    name: lane.displayName, cwd: lane.seat.path,
  });
  if (agent.pid === null) {
    throw new ClaudeTransmogrifyError(
      'RUNTIME_MISMATCH',
      'a stopped Claude lane cannot prove a worker runtime transition',
    );
  }
  const discovery = surface.discoverExecution(runtime, {
    sessionId: lane.providerId, jobId: lane.providerIdentity.jobId,
    name: lane.displayName, cwd: lane.seat.path,
  }, agent);
  if (discovery.bridgeId !== lane.providerIdentity.bridgeId) {
    throw new ClaudeTransmogrifyError('OWNERSHIP_MISMATCH', 'Claude runtime transition found a different bridge id');
  }
  const transitionId = crypto.randomUUID();
  const observedAt = new Date().toISOString();
  lane = rebindClaudeRuntime(options.repoRoot, lane.laneId, {
    transitionId,
    fromCliSha256: previousRuntime.cliSha256,
    runtime: publicRuntime(runtime),
    worker: discovery.worker,
    epoch: epochFromDiscovery(discovery, transitionId),
    observedAt,
  }, env);
  lane = updateRunningLane(options.repoRoot, lane, agent, env, { lastVerifiedAt: observedAt });
  return lane;
}
async function reconcileBoundLane(options, env, surface, runtime, initial) {
  let lane = requireOwnedLane(options.repoRoot, initial.laneId, env);
  assertSeat(options, lane);
  const agents = await surface.agents(runtime);
  const agent = surface.exactOwnedAgent(agents, lane.providerIdentity, {
    name: lane.displayName, cwd: lane.seat.path,
  });
  if (agent.pid === null) {
    lane = observedStop(options.repoRoot, lane, null, env);
    return { laneId: lane.laneId, providerId: lane.providerId, state: lane.state, outcome: 'stoppedObserved' };
  }
  const discovery = surface.discoverExecution(runtime, {
    sessionId: lane.providerId, jobId: lane.providerIdentity.jobId,
    name: lane.displayName, cwd: lane.seat.path,
  }, agent);
  if (discovery.bridgeId !== lane.providerIdentity.bridgeId) {
    throw new ClaudeTransmogrifyError('OWNERSHIP_MISMATCH', 'Claude reconciliation found a different bridge id');
  }
  const repaired = [];
  if (!sameExecutionEpoch(latestEpoch(lane), discovery)) {
    lane = appendLaneExecutionEpoch(options.repoRoot, lane.laneId, epochFromDiscovery(discovery), env);
    repaired.push('executionEpoch');
  }
  lane = updateRunningLane(options.repoRoot, lane, agent, env, {
    lastVerifiedAt: new Date().toISOString(),
  });
  if (lane.visibility?.state !== 'deepLinkDispatched') {
    const presented = await presentLane(options, env, surface, runtime, lane);
    lane = presented.lane;
    repaired.push('presentation');
  }
  return {
    laneId: lane.laneId, providerId: lane.providerId, state: lane.state,
    outcome: repaired.length ? 'repaired' : 'verified', repaired,
  };
}
async function reconcile(options, env = process.env) {
  if (!options.repoRoot || !path.isAbsolute(options.repoRoot)) {
    throw new ClaudeTransmogrifyError('USAGE_ERROR', 'reconcile requires absolute repoRoot');
  }
  let lanes;
  if (options.laneId) {
    let exact;
    try {
      exact = requireOwnedLane(options.repoRoot, options.laneId, env);
    } catch (error) {
      if (/^NOT_OWNED:/.test(error.message)) {
        throw new ClaudeTransmogrifyError('NOT_OWNED', `lane ${options.laneId} is not owned`);
      }
      throw error;
    }
    if (exact.backend !== BACKEND) {
      throw new ClaudeTransmogrifyError('ADAPTER_MISMATCH', `lane ${exact.laneId} uses ${exact.backend}`);
    }
    lanes = [exact];
  } else {
    lanes = listLanes(options.repoRoot, env).filter((lane) => lane.backend === BACKEND);
  }
  if (lanes.length === 0) {
    return { version: 1, ok: true, operation: 'reconcile', adapter: BACKEND, results: [] };
  }
  const surface = surfaceFor(options);
  let runtime = null;
  const results = [];
  for (const initial of lanes) {
    try {
      const settledTerminal = await withLaneLease(options.repoRoot, initial.laneId, async () =>
        settleTerminalLaneOperationPointer(options.repoRoot, initial.laneId, env), env);
      if (settledTerminal) {
        const lane = requireOwnedLane(options.repoRoot, initial.laneId, env);
        results.push({
          laneId: lane.laneId,
          providerId: lane.providerId || null,
          state: lane.state,
          outcome: 'terminalOperationPointerCleared',
          delivery: settledTerminal.state === 'complete' ? 'confirmed' : 'notDelivered',
        });
        continue;
      }
      const outerPending = pendingOperationForLane(options.repoRoot, initial.laneId, env);
      const cleanupOnlyRetirement = outerPending?.type === 'retire' &&
        RETIRED_STATES.has(initial.state);
      if (cleanupOnlyRetirement) {
        if (options.finishRetirements !== true) {
          results.push({
            laneId: initial.laneId, providerId: initial.providerId,
            state: initial.state, outcome: 'retirementPending',
          });
        } else {
          const retired = await retire({ ...options, laneId: initial.laneId }, env);
          results.push({
            laneId: retired.laneId, providerId: retired.providerId,
            state: retired.state, outcome: 'retirementFinished',
          });
        }
        continue;
      }
      if (!runtime) runtime = preflight(options, env, surface);
      const expectedRuntime = effectiveRuntime(initial);
      const needsRuntimeTransition = !sameRuntime(expectedRuntime, runtime);
      if (needsRuntimeTransition && !sameRuntimeIdentity(expectedRuntime, publicRuntime(runtime))) {
        results.push({ laneId: initial.laneId, state: initial.state, outcome: 'differentRuntime' });
        continue;
      }
      if (outerPending?.type === 'retire') {
        if (options.finishRetirements !== true) {
          results.push({
            laneId: initial.laneId, providerId: initial.providerId,
            state: initial.state, outcome: 'retirementPending',
          });
        } else {
          const retired = await retire({ ...options, laneId: initial.laneId }, env);
          results.push({
            laneId: retired.laneId, providerId: retired.providerId,
            state: retired.state, outcome: 'retirementFinished',
          });
        }
        continue;
      }
      let runtimeRebound = false;
      const result = await withLaneLease(options.repoRoot, initial.laneId, async () => {
        let lane = requireOwnedLane(options.repoRoot, initial.laneId, env);
        if (!sameRuntime(effectiveRuntime(lane), runtime)) {
          lane = await bindRuntimeTransition(options, env, surface, runtime, lane);
          runtimeRebound = true;
        }
        const operation = pendingOperationForLane(options.repoRoot, lane.laneId, env);
        if (operation?.type === 'spawn') {
          const repaired = await reconcilePendingSpawn(options, env, surface, runtime, lane, operation);
          return {
            laneId: repaired.lane.laneId, providerId: repaired.lane.providerId,
            state: repaired.lane.state, outcome: repaired.outcome,
            ...(repaired.presentation ? { presentation: repaired.presentation } : {}),
          };
        }
        if (operation?.type === 'steer') {
          const observed = await reconcileSteer(options, env, surface, runtime, lane, operation);
          return {
            laneId: lane.laneId, providerId: lane.providerId,
            state: observed.lane.state,
            outcome: observed.complete ? 'steerDeliveredObserved' : 'steerUnknown',
          };
        }
        if (operation?.type === 'stop') {
          const stopped = await reconcilePendingStop(options, env, surface, runtime, lane, operation);
          return {
            laneId: stopped.lane.laneId, providerId: stopped.lane.providerId,
            state: stopped.lane.state, outcome: stopped.outcome,
          };
        }
        if (operation?.type === 'recover') {
          const recovered = await observeRecovery(options, env, surface, runtime, lane, operation);
          return {
            laneId: lane.laneId, providerId: lane.providerId,
            state: recovered ? recovered.lane.state : lane.state,
            outcome: recovered ? 'recoveryVerified' : 'recoveryUnknown',
          };
        }
        if (operation) {
          throw new ClaudeTransmogrifyError('RECONCILIATION_UNCERTAIN', `unsupported pending operation ${operation.type}`);
        }
        if (RETIRED_STATES.has(lane.state)) {
          return {
            laneId: lane.laneId, providerId: lane.providerId,
            state: lane.state, outcome: 'alreadyRetired',
          };
        }
        return reconcileBoundLane(options, env, surface, runtime, lane);
      }, env);
      results.push(runtimeRebound ? {
        ...result,
        outcome: result.outcome === 'verified' ? 'runtimeRebound' : result.outcome,
        runtimeTransition: 'verified',
      } : result);
    } catch (error) {
      if (error.code === 'CLEANUP_RETRYABLE') {
        results.push({
          laneId: initial.laneId,
          state: initial.state,
          outcome: 'cleanupRetryable',
          code: error.code,
          providerRetired: true,
          cleanup: 'retryable',
        });
        continue;
      }
      results.push({
        laneId: initial.laneId, providerId: initial.providerId, state: initial.state,
        outcome: 'uncertain', code: error.code || 'RECONCILIATION_UNCERTAIN', error: error.message,
      });
    }
  }
  return {
    version: 1,
    ok: results.every((result) => ![
      'spawnUnknown', 'steerUnknown', 'stopPending', 'recoveryUnknown',
      'cleanupRetryable', 'retirementPending', 'differentRuntime', 'uncertain',
    ].includes(result.outcome)),
    operation: 'reconcile', adapter: BACKEND, results,
  };
}

module.exports = {
  BACKEND, ClaudeTransmogrifyError, capabilities, reconcile, recover, retire,
  spawn: spawnLane, status, steer, stop,
};
