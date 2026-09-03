'use strict';

// Claude Code lane stop and retirement: the verified whole-session stop, the
// private archive, local record removal, managed seat cleanup, and the
// settlement of a pending stop by observation.

const path = require('node:path');
const {
  beginLaneOperation, beginOperation, listOperations, pendingOperationForLane, requireOwnedLane,
  updateLane, withLaneLease,
} = require('./state');
const { assertUniqueShortJobId } = require('./claude-surface');
const { laneResult, nowMs } = require('./adapter-kit');
const {
  captureHarvestReceipt, isPermanentCleanupError, pathEntryExists, removeManagedSeat,
} = require('./worktree');
const {
  BACKEND, ClaudeTransmogrifyError, RETIRED_STATES, RETIRING_STATES, SHA256_PATTERN,
  UNBOUND_PROVIDER_RECEIPT, assertSeat, completeOperationJournal, completePending, ensureLatestEpoch,
  exactAgent, observedStop, operationForType, ownedLane, pollAgents, remainingCommandMs,
  removeChildHooksSettings, runtimeForLane, surfaceFor, updateOperationJournal, updatePending,
} = require('./claude-runtime');

// Stop the whole owned session and verify its worker is gone. The exact agent is
// re-read immediately before dispatch, so a changed worker is STOP_UNCERTAIN
// rather than a stop aimed at a stranger. A non-planned operation is never
// replayed, and an unverified stop leaves the lane delivery-unknown.
async function stopOwnedLane(options, env, surface, runtime, lane, operation, allowMutation = true) {
  let agent = await exactAgent(surface, runtime, lane, options);
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

// The one unresolved emergency stop journal for a lane, if any. More than one is
// STOP_UNCERTAIN and blocks any further mutation.
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

// Operator stop. When another operation type is already pending it opens a
// separate emergency stop journal beside the preserved pointer, so stopping a
// lane never destroys the record of what was in flight.
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

// The one local row for the owned session, or null when it is absent. A
// duplicated session id is OWNERSHIP_MISMATCH.
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

// Retirement requires the owned session to be already stopped. A still-running
// worker is STOP_UNCERTAIN, and this path never issues a second stop.
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

// The exact stopped local record to remove once the seat is gone: matching
// session, job, name, and recorded seat path, a unique short job id, and stable
// across the confirm and remove pair. Any drift is OWNERSHIP_MISMATCH.
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

// The identity check failed before local removal was attempted. Stop, archive,
// and cleanup stay reported as verified; localRemoval is notAttempted.
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

// Local removal failed after it began. The earlier verified phases are still
// reported honestly and providerMutation follows the removal's own certainty.
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

// Retire a Claude lane in a fixed order: harvest receipt, stop, remote archive,
// managed worktree removal, then local record removal. Remote archive uses the
// pinned private API and requires explicit owner authorization. Each phase is
// reported separately on failure, and a permanent cleanup block stays blocked
// until an owner acknowledges the manual seat removal.
// A lane whose spawn never bound a provider identity has nothing to stop,
// archive, or remove on the provider side. Retirement of such a lane only
// records the harvest and cleans its managed seat. A still-open spawn journal
// must be settled by reconcile first.
function unboundFailedLane(options, env) {
  if (!options.repoRoot || !path.isAbsolute(options.repoRoot)) return null;
  const lane = requireOwnedLane(options.repoRoot, options.laneId, env);
  if (lane.backend !== BACKEND || lane.providerId) return null;
  const pending = pendingOperationForLane(options.repoRoot, lane.laneId, env);
  if (pending?.type === 'spawn') {
    throw new ClaudeTransmogrifyError(
      'PENDING_OPERATION',
      `lane ${lane.laneId} has an unresolved spawn; run reconcile first`,
    );
  }
  if (!['failed', 'cleanupEligible', 'worktreeRemoved'].includes(lane.state)) return null;
  return lane;
}

async function retireUnboundLane(options, env, initial) {
  return withLaneLease(options.repoRoot, initial.laneId, async () => {
    let lane = requireOwnedLane(options.repoRoot, initial.laneId, env);
    let pending = pendingOperationForLane(options.repoRoot, lane.laneId, env);
    if (pending && pending.type !== 'retire') {
      throw new ClaudeTransmogrifyError('PENDING_OPERATION', `lane ${lane.laneId} has unresolved ${pending.type} operation`);
    }
    if (lane.state === 'worktreeRemoved' && !pending) {
      return laneResult('retire', lane, { receipt: { retired: true, alreadyRetired: true } });
    }
    if (!pending) {
      if (!SHA256_PATTERN.test(options.harvestedOutputSha256 || '')) {
        throw new ClaudeTransmogrifyError(
          'HARVEST_REQUIRED', 'Claude retirement requires a durable lowercase harvestedOutputSha256',
        );
      }
      const harvestReceipt = lane.seat
        ? captureHarvestReceipt(options.repoRoot, lane.seat, options.harvestedOutputSha256)
        : { version: 1, outputSha256: options.harvestedOutputSha256, seat: null };
      pending = beginLaneOperation(options.repoRoot, lane.laneId, {
        type: 'retire', providerId: null,
        details: {
          target: 'claude', ordering: 'harvest-worktree', unbound: true, harvestReceipt,
          provider: { ...UNBOUND_PROVIDER_RECEIPT },
        },
      }, env);
    } else if (options.harvestedOutputSha256 !== undefined &&
        pending.details.harvestReceipt?.outputSha256 !== options.harvestedOutputSha256) {
      throw new ClaudeTransmogrifyError('HARVEST_MISMATCH', 'retirement harvest digest does not match its durable receipt');
    }
    const harvestReceipt = pending.details.harvestReceipt;
    const finish = (cleanup) => {
      completePending(options.repoRoot, lane.laneId, pending, {
        state: 'complete', details: { ...pending.details, cleanup },
      }, env);
      lane = requireOwnedLane(options.repoRoot, lane.laneId, env);
      return laneResult('retire', lane, {
        operationId: pending.operationId,
        receipt: {
          provider: { ...UNBOUND_PROVIDER_RECEIPT },
          harvestedOutputSha256: harvestReceipt.outputSha256, worktree: cleanup,
        },
      });
    };
    if (!lane.seat || lane.seat.managed !== true) {
      if (lane.state !== 'worktreeRemoved') {
        lane = updateLane(options.repoRoot, lane.laneId, { state: 'worktreeRemoved' }, env);
      }
      return finish({ attempted: false, removed: false, external: true });
    }
    if (lane.state === 'worktreeRemoved') {
      return finish(pending.details.cleanup || { attempted: true, removed: true, recoveredAfterRemoval: true });
    }
    if (options.cleanupWorktree === false) {
      pending = updatePending(options.repoRoot, lane.laneId, pending, {
        state: 'cleanupDeferred', details: { ...pending.details, cleanupDeferred: true },
      }, env);
      return laneResult('retire', lane, {
        operationId: pending.operationId,
        receipt: {
          provider: { ...UNBOUND_PROVIDER_RECEIPT },
          harvestedOutputSha256: harvestReceipt.outputSha256,
          worktree: { attempted: false, removed: false, deferred: true },
        },
      });
    }
    if (lane.state === 'failed') {
      lane = updateLane(options.repoRoot, lane.laneId, { state: 'cleanupEligible' }, env);
    }
    const cleanup = { attempted: true, removed: false };
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
          'the unbound Claude lane has no provider state; managed worktree cleanup failed locally and is safe to retry',
          { laneId: lane.laneId },
        );
      }
      updatePending(options.repoRoot, lane.laneId, pending, {
        state: 'providerRetiredCleanupBlocked',
        details: { ...pending.details, cleanupBlocked: true },
      }, env);
      throw new ClaudeTransmogrifyError('CLEANUP_BLOCKED', error.message, { laneId: lane.laneId });
    }
    pending = updatePending(options.repoRoot, lane.laneId, pending, {
      state: 'worktreeRemoved', details: { ...pending.details, cleanup },
    }, env);
    return finish(cleanup);
  }, env);
}

async function retire(options, env = process.env) {
  const unbound = unboundFailedLane(options, env);
  if (unbound) return retireUnboundLane(options, env, unbound);
  let lane = ownedLane(options, env, false);
  const existingRetirement = pendingOperationForLane(options.repoRoot, lane.laneId, env);
  if (lane.state === 'worktreeRemoved' && !existingRetirement) {
    return laneResult('retire', lane, { receipt: { retired: true, alreadyRetired: true } });
  }
  if (options.acceptManualSeatRemoval === true &&
      existingRetirement?.details?.cleanupBlocked !== true) {
    throw new ClaudeTransmogrifyError(
      'USAGE_ERROR',
      '--accept-manual-seat-removal requires an exact pending CLEANUP_BLOCKED retirement',
    );
  }
  const initialSeatEntryPresent = lane.seat?.managed === true &&
    pathEntryExists(lane.seat.path);
  const initialManualRemovalAcknowledged = options.acceptManualSeatRemoval === true ||
    existingRetirement?.details?.manualSeatRemoval?.acknowledged === true;
  if (existingRetirement?.details?.cleanupBlocked === true &&
      (initialSeatEntryPresent || !initialManualRemovalAcknowledged)) {
    throw new ClaudeTransmogrifyError(
      'CLEANUP_BLOCKED',
      'Claude managed worktree has a permanent cleanup block and requires exact manual-removal acknowledgement',
      { providerRetired: true, laneId: lane.laneId },
    );
  }
  const recoveringAbsentManagedSeat = lane.seat?.managed === true &&
    existingRetirement?.type === 'retire' && RETIRED_STATES.has(lane.state) &&
    !initialSeatEntryPresent &&
    (existingRetirement.details.cleanupBlocked !== true ||
      options.acceptManualSeatRemoval === true ||
      existingRetirement.details.manualSeatRemoval?.acknowledged === true);
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
    const blockedSeatAbsent = pending.details.cleanupBlocked === true &&
      lane.seat?.managed === true && !pathEntryExists(lane.seat.path);
    const manuallyRemovedBlockedSeat = blockedSeatAbsent &&
      (options.acceptManualSeatRemoval === true ||
        pending.details.manualSeatRemoval?.acknowledged === true);
    if (pending.details.cleanupBlocked === true && !manuallyRemovedBlockedSeat) {
      throw new ClaudeTransmogrifyError(
        'CLEANUP_BLOCKED',
        'Claude managed worktree has a permanent cleanup block and requires manual review',
        { providerRetired: true, laneId: lane.laneId },
      );
    }
    if (blockedSeatAbsent && pending.details.manualSeatRemoval?.acknowledged !== true) {
      pending = updatePending(options.repoRoot, lane.laneId, pending, {
        state: pending.state,
        details: {
          ...pending.details,
          manualSeatRemoval: {
            acknowledged: true,
            observedAbsentAt: new Date().toISOString(),
          },
        },
      }, env);
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
      removeChildHooksSettings(lane.laneId, env);
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
    if (pathEntryExists(lane.seat.path)) {
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
              localRemovalDispatchStartedAt: nowMs(options),
            },
          }, env);
          try {
            await surface.run(runtime, ['rm', lane.providerIdentity.jobId], {
              cwd: options.repoRoot, timeoutMs: options.commandTimeoutMs,
            });
            pending = updatePending(options.repoRoot, lane.laneId, pending, {
              state: 'localRemovalDispatched',
              details: { ...pending.details, localRemovalDispatchFinishedAt: nowMs(options) },
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

// Settle a pending stop by observation only. stopOwnedLane runs with mutation
// disabled, so a still-running lane stays pending rather than being stopped again.
async function reconcilePendingStop(options, env, surface, runtime, lane, operation, deadline = null) {
  const result = await stopOwnedLane(deadline === null ? options : {
    ...options,
    commandTimeoutMs: remainingCommandMs(deadline, 100),
  }, env, surface, runtime, lane, operation, false);
  if (result.pending) return { lane, outcome: 'stopPending' };
  completePending(options.repoRoot, lane.laneId, operation, { state: 'complete' }, env);
  return { lane: result.lane, outcome: 'stoppedObserved' };
}

module.exports = {
  stopOwnedLane,
  unresolvedEmergencyStop,
  stop,
  exactLocalAgentOrAbsent,
  verifyRetirementStopped,
  exactLocalRecordAfterSeatRemoval,
  localRemovalTarget,
  localRemovalIdentityFailure,
  localRemovalStageFailure,
  unboundFailedLane,
  retireUnboundLane,
  retire,
  reconcilePendingStop,
};
