'use strict';

// Claude Code lane recovery and fleet reconciliation: the exact-session
// resume with fork containment, verified runtime transitions, and the
// observation of every pending journal without replaying a mutation.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  appendLaneExecutionEpoch, beginLaneOperation, listLanes, listOperations, pendingOperationForLane,
  rebindClaudeRuntime, repairUnstartedSpawn, requireOwnedLane, updateLane, withLaneLease,
} = require('./state');
const { claudeResumeArgs, sha256 } = require('./claude-surface');
const { laneResult, nowMs, reconcileOk } = require('./adapter-kit');
const {
  BACKEND, ClaudeTransmogrifyError, OWNER_ACTIONS, RETIRED_STATES, SPAWN_OUTCOME_DELIVERY,
  assertSeat, commandDeadline, completePending, effectiveRuntime, epochFromDiscovery,
  executionArgs, existingChildHooksSettings, latestEpoch, observedStop, ownedLane, ownerActionFor,
  pollAgents, preflight, publicRuntime, reconcileSteer, remainingCommandMs, runtimeForLane,
  sameExecutionEpoch, sameRuntime, sameRuntimeIdentity, surfaceFor, updatePending, updateRunningLane,
} = require('./claude-runtime');
const { presentLane, reconcilePendingSpawn } = require('./claude-spawn');
const { reconcilePendingStop, retire } = require('./claude-retire');

// Sessions a recovery dispatch may have forked: the lane's display name and
// seat, started inside the dispatch window, absent from the baseline census, and
// not the owned session. Their existence stops recovery; none is ever touched.
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

// Verify that recovery resumed the exact same session: no correlated fork, an
// unchanged bridge id, and a live worker whose new execution epoch is appended
// before the lane is marked running. A correlated fork is FORKED_COPY and a
// different bridge is RECOVERY_UNCERTAIN.
async function observeRecovery(options, env, surface, runtime, lane, operation, deadline = null) {
  const located = await pollAgents(surface, runtime, (agents) => {
    const copies = correlatedRecoveryCopies(agents, lane, operation);
    if (copies.length) return { forked: copies };
    try {
      const agent = surface.exactOwnedAgent(agents, lane.providerIdentity, {
        name: lane.displayName, cwd: lane.seat.path,
      });
      return agent.pid ? { agent } : null;
    } catch { return null; }
  }, {
    attempts: options.recoveryVerifyAttempts,
    delayMs: options.recoveryVerifyDelayMs,
    deadline,
  });
  if (!located) {
    // The dispatch window has passed with no running exact session and no
    // correlated copy: the resume did not happen. Close the journal so the
    // lane can be retired or replaced instead of staying uncertain forever.
    const notAfter = operation.details.dispatchNotAfter;
    if (Number.isFinite(notAfter) && nowMs(options) > notAfter) {
      const settled = settleFailedRecovery(options, env, lane, operation, { outcome: 'recoveryNotAchieved' });
      return { settled: 'recoveryNotAchieved', lane: settled };
    }
    return null;
  }
  if (located.result.forked) {
    // The pinned CLI resumes a stopped background job as a new session. The
    // copies are ours: they were created by this recovery's own command, in
    // this seat, inside the recorded window. Stop them (never remove them),
    // close the journal, and leave the lane stopped with its original session.
    const stopped = await stopCorrelatedCopies(options, surface, runtime, located.result.forked);
    settleFailedRecovery(options, env, lane, operation, {
      outcome: 'forkedCopyStopped', correlatedCopies: located.result.forked.length,
      copiesStopped: stopped.stopped, copiesStopFailed: stopped.failed,
    });
    throw new ClaudeTransmogrifyError(
      'FORKED_COPY',
      'Claude recovery forked into a separate session; the fork this recovery created was stopped and the lane remains stopped',
      {
        correlatedCopies: located.result.forked.length, copiesStopped: stopped.stopped,
        ownerAction: OWNER_ACTIONS.get('FORKED_COPY'),
      },
    );
  }
  const discovery = surface.discoverExecution(runtime, {
    sessionId: lane.providerId, jobId: lane.providerIdentity.jobId,
    name: lane.displayName, cwd: lane.seat.path,
  }, located.result.agent, deadline === null ? {} : {
    timeoutMs: remainingCommandMs(deadline),
  });
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
  const presented = await presentLane(deadline === null ? options : {
    ...options,
    commandTimeoutMs: remainingCommandMs(deadline),
  }, env, surface, runtime, lane);
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

async function stopCorrelatedCopies(options, surface, runtime, copies) {
  let stopped = 0;
  let failed = 0;
  for (const copy of copies) {
    if (typeof copy?.id !== 'string' || !/^[0-9a-f]{8}$/iu.test(copy.id)) { failed += 1; continue; }
    try {
      await surface.run(runtime, ['stop', copy.id], {
        cwd: options.repoRoot, timeoutMs: options.commandTimeoutMs,
      });
      stopped += 1;
    } catch { failed += 1; }
  }
  return { stopped, failed };
}

// Close a recovery journal as failed and return the lane to stopped, which is
// a valid transition from both recoverRequested and deliveryUnknown.
function settleFailedRecovery(options, env, lane, operation, details) {
  completePending(options.repoRoot, lane.laneId, operation, {
    state: 'failed',
    details: { ...operation.details, ...details, settledAt: new Date().toISOString() },
  }, env);
  const current = requireOwnedLane(options.repoRoot, lane.laneId, env);
  return current.state === 'stopped'
    ? current : updateLane(options.repoRoot, lane.laneId, { state: 'stopped' }, env);
}

// Resume a stopped lane as the same session with its pinned execution profile.
// It refuses a lane that is already running, journals the baseline session census
// and dispatch window before dispatch, and treats any unverified outcome as
// RECOVERY_UNCERTAIN rather than launching again.
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
        // A settled fork keeps its own code so the public message names what
        // happened; every other cause stays a recovery uncertainty.
        throw new ClaudeTransmogrifyError(error.code === 'FORKED_COPY' ? 'FORKED_COPY' : 'RECOVERY_UNCERTAIN', error.message, {
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
    const dispatchStartedAt = nowMs(options);
    const commandWindowMs = options.commandTimeoutMs ?? 30_000;
    let operation = beginLaneOperation(options.repoRoot, lane.laneId, {
      type: 'recover', providerId: lane.providerId,
      details: {
        target: 'claude', argvContract: 'resume-full-session-bg-pinned-execution-profile',
        baselineSessionIds: before
          .filter((agent) => typeof agent.sessionId === 'string')
          .map((agent) => agent.sessionId.toLowerCase()).sort(),
        dispatchStartedAt,
        dispatchNotAfter: dispatchStartedAt + commandWindowMs + (options.recoveryWindowSlackMs ?? 5000),
      },
    }, env);
    lane = updateLane(options.repoRoot, lane.laneId, { state: 'recoverRequested' }, env);
    operation = updatePending(options.repoRoot, lane.laneId, operation, {
      state: 'dispatching',
    }, env);
    try {
      const resumeSettings = existingChildHooksSettings(lane.laneId, env);
      const dispatched = await surface.run(runtime, claudeResumeArgs(
        lane.providerId,
        { ...executionArgs(lane.executionProfile), ...(resumeSettings ? { fastMode: undefined, settingsFile: resumeSettings } : {}) },
      ), {
        cwd: lane.seat.path, timeoutMs: options.commandTimeoutMs,
      });
      operation = updatePending(options.repoRoot, lane.laneId, operation, {
        state: 'dispatched',
        details: {
          ...operation.details, dispatchFinishedAt: nowMs(options),
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
      if (observed.settled) {
        throw new ClaudeTransmogrifyError(
          'RECOVERY_UNCERTAIN', 'Claude recovery did not produce a running session; the lane remains stopped',
          { causeCode: 'RECOVERY_NOT_ACHIEVED' },
        );
      }
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
      throw new ClaudeTransmogrifyError(error.code === 'FORKED_COPY' ? 'FORKED_COPY' : 'RECOVERY_UNCERTAIN', error.message, {
        ...(error.details || {}),
        ...(error.code ? { causeCode: error.code } : {}),
      });
    }
  }, env);
}

// Record a verified CLI upgrade on a running lane: the account, config, and
// platform identity must be unchanged, the bridge id must match, and a live
// worker must supply the new execution epoch. A stopped lane cannot prove a
// transition and is RUNTIME_MISMATCH.
async function bindRuntimeTransition(options, env, surface, runtime, initial, deadline = null) {
  let lane = requireOwnedLane(options.repoRoot, initial.laneId, env);
  const previousRuntime = effectiveRuntime(lane);
  if (!sameRuntimeIdentity(previousRuntime, publicRuntime(runtime))) {
    throw new ClaudeTransmogrifyError(
      'RUNTIME_MISMATCH',
      'Claude runtime transition changes the account, config, platform, or protocol identity',
    );
  }
  assertSeat(options, lane);
  const agents = await surface.agents(runtime, deadline === null ? {} : {
    timeoutMs: remainingCommandMs(deadline, 100),
  });
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
  }, agent, deadline === null ? {} : {
    timeoutMs: remainingCommandMs(deadline),
  });
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

// Observe a fully bound lane: a stopped lane gets a durable stop receipt, and a
// running lane must present the same bridge id, gaining a new execution epoch
// and a deep-link presentation when either is missing.
async function reconcileBoundLane(options, env, surface, runtime, initial, deadline = null) {
  let lane = requireOwnedLane(options.repoRoot, initial.laneId, env);
  assertSeat(options, lane);
  const agents = await surface.agents(runtime, deadline === null ? {} : {
    timeoutMs: remainingCommandMs(deadline, 100),
  });
  const agent = surface.exactOwnedAgent(agents, lane.providerIdentity, {
    name: lane.displayName, cwd: lane.seat.path,
  });
  if (agent.pid === null) {
    lane = observedStop(options.repoRoot, lane, null, env);
    return {
      laneId: lane.laneId, providerId: lane.providerId, state: lane.state, outcome: 'stoppedObserved',
      delivery: 'confirmed', repaired: [], pendingOperation: null,
    };
  }
  const discovery = surface.discoverExecution(runtime, {
    sessionId: lane.providerId, jobId: lane.providerIdentity.jobId,
    name: lane.displayName, cwd: lane.seat.path,
  }, agent, deadline === null ? {} : {
    timeoutMs: remainingCommandMs(deadline),
  });
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
    const presented = await presentLane(deadline === null ? options : {
      ...options,
      commandTimeoutMs: remainingCommandMs(deadline),
    }, env, surface, runtime, lane);
    lane = presented.lane;
    repaired.push('presentation');
  }
  return {
    laneId: lane.laneId, providerId: lane.providerId, state: lane.state,
    outcome: repaired.length ? 'repaired' : 'verified', repaired,
    delivery: 'confirmed', pendingOperation: null,
  };
}

// Fleet reconciliation for one lane or every Claude lane. It settles pending
// journals by observation, records verified runtime transitions, and reports
// each lane's outcome without replaying any provider mutation. The runtime is
// measured once, lazily, for the first lane that needs it.
async function reconcile(options, env = process.env) {
  if (!options.repoRoot || !path.isAbsolute(options.repoRoot)) {
    throw new ClaudeTransmogrifyError('USAGE_ERROR', 'reconcile requires absolute repoRoot');
  }
  const lanes = selectReconcileLanes(options, env);
  if (lanes.length === 0) {
    return {
      version: 1, ok: true, operation: 'reconcile', adapter: BACKEND, results: [],
      receipt: { providerConnection: 'notRequired' },
    };
  }
  const ctx = {
    options, env, surface: surfaceFor(options), deadline: commandDeadline(options), runtime: null,
    operations: new Map(listOperations(options.repoRoot, env).map((operation) => [operation.operationId, operation])),
  };
  const results = [];
  for (const initial of lanes) {
    try {
      results.push(await reconcileLane(ctx, initial));
    } catch (error) {
      results.push(reconcileFailureEntry(initial, error));
    }
  }
  return {
    version: 1,
    ok: reconcileOk(results),
    operation: 'reconcile', adapter: BACKEND, results,
    receipt: { providerConnection: ctx.runtime ? 'verified' : 'notRequired' },
  };
}

function selectReconcileLanes(options, env) {
  if (!options.laneId) return listLanes(options.repoRoot, env).filter((lane) => lane.backend === BACKEND);
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
  return [exact];
}

function reconcileEntry(lane, fields) {
  return { laneId: lane.laneId, providerId: lane.providerId ?? null, state: lane.state, ...fields };
}

// One lane, in the order local evidence allows: a crash-left journal is
// repaired without the provider; a pending retirement is finished only on
// request; a retired lane with nothing pending needs no runtime; then the
// runtime is compared and the lane observed under its lease.
async function reconcileLane(ctx, initial) {
  const { options, env } = ctx;
  const terminalRepair = await withLaneLease(options.repoRoot, initial.laneId, async () => {
    const repair = repairUnstartedSpawn(options.repoRoot, initial.laneId, ctx.operations.get(initial.operationId), env);
    if (!repair) return null;
    return reconcileEntry(repair.lane, {
      outcome: repair.unstartedSpawn ? 'spawnNotDelivered' : 'terminalOperationPointerCleared',
      delivery: repair.delivery, repaired: repair.repaired, pendingOperation: null,
    });
  }, env);
  if (terminalRepair) return terminalRepair;
  const outerPending = pendingOperationForLane(options.repoRoot, initial.laneId, env);
  if (outerPending?.type === 'retire' && RETIRED_STATES.has(initial.state)) {
    return settlePendingRetirement(ctx, initial);
  }
  // A retired lane with nothing pending needs no runtime at all; report it
  // as already retired instead of comparing runtimes it no longer uses.
  if (RETIRED_STATES.has(initial.state) && !outerPending) {
    return reconcileEntry(initial, { outcome: 'alreadyRetired', delivery: 'confirmed', repaired: [], pendingOperation: null });
  }
  if (!ctx.runtime) {
    ctx.runtime = preflight({
      ...options,
      ...(ctx.deadline === null ? {} : { commandTimeoutMs: remainingCommandMs(ctx.deadline, 100) }),
    }, env, ctx.surface);
  }
  const expectedRuntime = effectiveRuntime(initial);
  if (!sameRuntime(expectedRuntime, ctx.runtime) && !sameRuntimeIdentity(expectedRuntime, publicRuntime(ctx.runtime))) {
    return {
      laneId: initial.laneId, state: initial.state, outcome: 'differentRuntime',
      delivery: 'unknown', repaired: [], pendingOperation: outerPending?.type ?? null,
    };
  }
  if (outerPending?.type === 'retire') return settlePendingRetirement(ctx, initial);
  let runtimeRebound = false;
  const result = await withLaneLease(options.repoRoot, initial.laneId, async () => {
    let lane = requireOwnedLane(options.repoRoot, initial.laneId, env);
    if (!sameRuntime(effectiveRuntime(lane), ctx.runtime)) {
      lane = await bindRuntimeTransition(options, env, ctx.surface, ctx.runtime, lane, ctx.deadline);
      runtimeRebound = true;
    }
    return observeLaneUnderLease(ctx, lane);
  }, env);
  return runtimeRebound
    ? { ...result, outcome: result.outcome === 'verified' ? 'runtimeRebound' : result.outcome, runtimeTransition: 'verified' }
    : result;
}

// A pending retirement is reported pending, or finished through the exact
// retire path when the caller asked for it.
async function settlePendingRetirement(ctx, initial) {
  if (ctx.options.finishRetirements !== true) {
    return reconcileEntry(initial, { outcome: 'retirementPending', delivery: 'unknown', repaired: [], pendingOperation: 'retire' });
  }
  const retired = await retire({ ...ctx.options, laneId: initial.laneId }, ctx.env);
  return reconcileEntry(retired, { outcome: 'retirementFinished', delivery: 'confirmed', repaired: [], pendingOperation: null });
}

// Settle the lane's pending journal from observation, by type, or observe
// the bound lane when nothing is pending.
async function observeLaneUnderLease(ctx, lane) {
  const { options, env, surface, runtime, deadline } = ctx;
  const operation = pendingOperationForLane(options.repoRoot, lane.laneId, env);
  if (operation?.type === 'spawn') {
    const repaired = await reconcilePendingSpawn(options, env, surface, runtime, lane, operation, deadline);
    return reconcileEntry(repaired.lane, {
      outcome: repaired.outcome,
      delivery: SPAWN_OUTCOME_DELIVERY.get(repaired.outcome),
      repaired: [],
      pendingOperation: repaired.outcome === 'spawnUnknown' ? 'spawn' : null,
      ...(repaired.presentation ? { presentation: repaired.presentation } : {}),
    });
  }
  if (operation?.type === 'steer') {
    const observed = await reconcileSteer(options, env, surface, runtime, lane, operation, deadline);
    return reconcileEntry({ ...lane, state: observed.lane.state }, {
      outcome: observed.complete ? 'steerDeliveredObserved' : 'steerUnknown',
      delivery: observed.complete ? 'confirmed' : 'unknown',
      repaired: [],
      pendingOperation: observed.complete ? null : 'steer',
    });
  }
  if (operation?.type === 'stop') {
    const stopped = await reconcilePendingStop(options, env, surface, runtime, lane, operation, deadline);
    return reconcileEntry(stopped.lane, {
      outcome: stopped.outcome,
      delivery: stopped.outcome === 'stoppedObserved' ? 'confirmed' : 'unknown',
      repaired: [],
      pendingOperation: stopped.outcome === 'stopPending' ? 'stop' : null,
    });
  }
  if (operation?.type === 'recover') {
    const recovered = await observeRecovery(options, env, surface, runtime, lane, operation, deadline);
    const outcome = recovered ? (recovered.settled || 'recoveryVerified') : 'recoveryUnknown';
    return reconcileEntry({ ...lane, state: recovered ? recovered.lane.state : lane.state }, {
      outcome,
      delivery: outcome === 'recoveryVerified' ? 'confirmed' : outcome === 'recoveryNotAchieved' ? 'notDelivered' : 'unknown',
      repaired: [],
      pendingOperation: outcome === 'recoveryUnknown' ? 'recover' : null,
    });
  }
  if (operation) {
    throw new ClaudeTransmogrifyError('RECONCILIATION_UNCERTAIN', `unsupported pending operation ${operation.type}`);
  }
  if (RETIRED_STATES.has(lane.state)) {
    return reconcileEntry(lane, { outcome: 'alreadyRetired', delivery: 'confirmed', repaired: [], pendingOperation: null });
  }
  return reconcileBoundLane(options, env, surface, runtime, lane, deadline);
}

// The entry for a lane whose reconciliation threw: a retryable cleanup keeps
// its retirement pending, a contained fork is reported as such (the resume
// this call was asked to perform did not happen), and anything else is
// uncertain with its code and owner action.
function reconcileFailureEntry(initial, error) {
  if (error.code === 'CLEANUP_RETRYABLE') {
    return {
      laneId: initial.laneId, state: initial.state, outcome: 'cleanupRetryable', code: error.code,
      providerRetired: true, cleanup: 'retryable', delivery: 'unknown', repaired: [], pendingOperation: 'retire',
    };
  }
  if (error.code === 'FORKED_COPY' && error.details?.copiesStopped !== undefined) {
    return {
      laneId: initial.laneId, providerId: initial.providerId, state: 'stopped',
      outcome: 'forkedCopyStopped', code: error.code,
      copiesStopped: error.details.copiesStopped, ownerAction: error.details.ownerAction,
      delivery: 'notDelivered', repaired: [], pendingOperation: null,
    };
  }
  const causeCode = error.details?.causeCode;
  const ownerAction = error.details?.ownerAction || ownerActionFor(causeCode);
  return {
    laneId: initial.laneId, providerId: initial.providerId, state: initial.state,
    outcome: 'uncertain', code: error.code || 'RECONCILIATION_UNCERTAIN', error: error.message,
    delivery: 'unknown', repaired: [], pendingOperation: null,
    ...(causeCode ? { causeCode } : {}),
    ...(ownerAction ? { ownerAction } : {}),
  };
}

module.exports = {
  correlatedRecoveryCopies,
  observeRecovery,
  stopCorrelatedCopies,
  settleFailedRecovery,
  recover,
  bindRuntimeTransition,
  reconcileBoundLane,
  reconcile,
};
