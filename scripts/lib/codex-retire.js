'use strict';

// Codex lane retirement: the harvest receipt, the archive and its verification
// against the archived-thread census, managed seat cleanup, and the settlement
// of an unresolved first turn that only exact retirement may close.

const {
  beginLaneOperation, completeLaneOperation, pendingOperationForLane, updateLane, updatePendingLaneOperation,
  withLaneLease,
} = require('./state');
const { laneResult } = require('./adapter-kit');
const { sleep } = require('./async');
const {
  captureHarvestReceipt, isPermanentCleanupError, pathEntryExists, removeManagedSeat,
} = require('./worktree');
const { boundedCursor } = require('./validation');
const {
  MAX_PAGINATION_PAGES, MAX_PAGINATION_ROWS, SOURCE_KINDS, TransmogrifyError, UNRESOLVED_SPAWN_STATES,
  assertProviderSeat, assertRuntimeIdentity, assertSeatIdentity, findTurnByClientMessage,
  inspectThread, observedLaneState, ownedLane, withClient,
} = require('./codex-runtime');

// One complete bounded scan of the archived listing for this exact provider id.
// Duplicate rows or a cursor cycle is PROTOCOL_ERROR, and a match must still
// pass the seat check before it counts as a retirement receipt.
async function listArchived(client, lane) {
  let cursor = null;
  const seen = new Set();
  let match = null;
  let pages = 0;
  let rows = 0;
  do {
    pages += 1;
    if (pages > MAX_PAGINATION_PAGES) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/list exceeded the page bound');
    }
    const page = await client.call('thread/list', {
      archived: true,
      cursor,
      limit: 100,
      sourceKinds: SOURCE_KINDS,
      useStateDbOnly: true,
    });
    if (!page || !Array.isArray(page.data)) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/list response did not include data[]');
    }
    rows += page.data.length;
    if (rows > MAX_PAGINATION_ROWS) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/list exceeded the row bound');
    }
    for (const thread of page.data) {
      if (thread?.id !== lane.providerId) continue;
      if (match) {
        throw new TransmogrifyError(
          'PROTOCOL_ERROR',
          'thread/list returned duplicate rows for the exact archived lane',
        );
      }
      match = thread;
    }
    const next = boundedCursor(page.nextCursor, 'thread/list nextCursor');
    if (next !== null && seen.has(next)) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/list cursor cycle');
    }
    if (next !== null) seen.add(next);
    cursor = next;
  } while (cursor !== null);
  if (!match) return false;
  assertProviderSeat(lane, match, undefined, 'thread/list');
  return true;
}

// Retry the archived-listing census within bounded attempts. Returns false when
// the row never appears; the caller decides whether that is unknown.
async function verifyArchived(client, lane, options) {
  const attempts = options.archiveVerifyAttempts ?? 5;
  const delayMs = options.archiveVerifyDelayMs ?? 100;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 100) {
    throw new TransmogrifyError('USAGE_ERROR', 'archiveVerifyAttempts must be 1..100');
  }
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new TransmogrifyError('USAGE_ERROR', 'archiveVerifyDelayMs must be 0..60000');
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await listArchived(client, lane)) return true;
    if (attempt < attempts && delayMs) {
      await sleep(delayMs);
    }
  }
  return false;
}

// Retirement requires a lowercase SHA-256 harvest receipt before any provider
// mutation. A missing or malformed digest is USAGE_ERROR.
function requireHarvestedOutputSha256(options) {
  if (!/^[0-9a-f]{64}$/.test(options.harvestedOutputSha256 || '')) {
    throw new TransmogrifyError(
      'USAGE_ERROR',
      'retire requires --harvested-output-sha256 as a lowercase SHA-256 receipt',
    );
  }
  return options.harvestedOutputSha256;
}

// The harvest receipt already journaled on a pending retirement. Its absence is
// HARVEST_REQUIRED; recovery never invents one.
function retirementHarvestReceipt(operation) {
  const receipt = operation?.details?.harvestReceipt;
  if (!receipt || !/^[0-9a-f]{64}$/.test(receipt.outputSha256 || '')) {
    throw new TransmogrifyError('HARVEST_REQUIRED', 'retirement operation has no durable harvest receipt');
  }
  return receipt;
}

// Resume the pending retirement journal, or open one after capturing the harvest
// receipt for the current seat. A supplied digest that contradicts the journaled
// receipt is HARVEST_MISMATCH.
function prepareRetirementOperation(options, lane, env) {
  const pending = pendingOperationForLane(options.repoRoot, lane.laneId, env);
  if (pending) {
    if (pending.type !== 'retire') {
      throw new TransmogrifyError(
        'PENDING_OPERATION',
        `lane ${lane.laneId} already has pending ${pending.type} operation ${pending.operationId}`,
      );
    }
    const harvestReceipt = retirementHarvestReceipt(pending);
    if (options.harvestedOutputSha256 &&
        options.harvestedOutputSha256 !== harvestReceipt.outputSha256) {
      throw new TransmogrifyError('HARVEST_MISMATCH', 'harvested output digest does not match pending retirement');
    }
    return { operation: pending, harvestReceipt };
  }
  const outputSha256 = requireHarvestedOutputSha256(options);
  const harvestReceipt = captureHarvestReceipt(options.repoRoot, lane.seat, outputSha256);
  const operation = beginLaneOperation(options.repoRoot, lane.laneId, {
    type: 'retire',
    providerId: lane.providerId,
    details: { target: 'codex', harvestReceipt },
  }, env);
  return { operation, harvestReceipt };
}

// Local cleanup once provider retirement is verified. An unmanaged or deferred
// seat only closes the journal. A permanent block is CLEANUP_BLOCKED and stays
// blocked until the owner acknowledges manual removal; a transient local failure
// is CLEANUP_RETRYABLE, and neither performs a further provider mutation.
function finishRetiredCleanup(options, lane, operation, harvestReceipt, env) {
  if (lane.seat?.managed !== true) {
    completeLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
      state: 'complete',
    }, env);
    return lane;
  }
  if (options.cleanupWorktree === false) {
    updatePendingLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
      state: 'providerRetiredCleanupDeferred',
    }, env);
    return lane;
  }
  const blocked = operation.details.cleanupBlocked === true ||
    operation.state === 'providerRetiredCleanupBlocked';
  const manuallyRemoved = operation.details.manualSeatRemoval?.acknowledged === true &&
    !pathEntryExists(lane.seat.path);
  if (blocked && !manuallyRemoved) {
    throw new TransmogrifyError(
      'CLEANUP_BLOCKED',
      'Codex managed worktree has a permanent cleanup block and requires manual review',
      { laneId: lane.laneId, providerRetired: true },
    );
  }
  try {
    const removed = removeManagedSeat(options.repoRoot, lane.laneId, harvestReceipt, env).lane;
    completeLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
      state: 'complete',
    }, env);
    return removed;
  } catch (error) {
    if (!isPermanentCleanupError(error)) {
      updatePendingLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
        state: 'providerRetiredCleanupDeferred',
        details: { ...operation.details, cleanupRetryable: true },
      }, env);
      throw new TransmogrifyError(
        'CLEANUP_RETRYABLE',
        'Codex provider is retired; managed worktree cleanup failed locally and is safe to retry',
        { laneId: lane.laneId, providerRetired: true },
      );
    }
    updatePendingLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
      state: 'providerRetiredCleanupBlocked',
      details: { ...operation.details, cleanupBlocked: true },
    }, env);
    throw new TransmogrifyError('CLEANUP_BLOCKED', error.message, {
      laneId: lane.laneId,
      providerRetired: true,
    });
  }
}

// Close a spawn journal whose thread exists but whose first turn never
// receipted. It refuses while a turn is active, pages once more for the exact
// input receipt, then completes with the recovered turn or marks the journal
// superseded by retirement. The first input is never replayed.
async function settleUnresolvedSpawnForRetirement(options, lane, pending, env) {
  if (!lane.providerId || pending.providerId !== lane.providerId ||
      !UNRESOLVED_SPAWN_STATES.has(pending.state) ||
      !/^[0-9a-f]{64}$/.test(pending.details?.inputSha256 || '')) {
    throw new TransmogrifyError(
      'PENDING_OPERATION',
      `lane ${lane.laneId} already has pending spawn operation ${pending.operationId}`,
    );
  }
  return withClient(options, async (client) => {
    assertRuntimeIdentity(lane, client);
    const inspected = await inspectThread(client, lane);
    if (inspected.turn?.status === 'inProgress') {
      throw new TransmogrifyError('TARGET_ACTIVE', 'refusing to retire a lane with an active newest turn');
    }
    const recoveredTurnId = await findTurnByClientMessage(
      client,
      lane.providerId,
      pending.operationId,
      pending.details.inputSha256,
    );
    const observedAt = new Date().toISOString();
    if (recoveredTurnId) {
      completeLaneOperation(options.repoRoot, lane.laneId, pending.operationId, {
        state: 'complete',
        details: { ...pending.details, recoveredTurnId, postconditionObservedAt: observedAt },
      }, env);
    } else {
      completeLaneOperation(options.repoRoot, lane.laneId, pending.operationId, {
        state: 'failed',
        details: {
          ...pending.details,
          supersededBy: 'retire',
          supersededAt: observedAt,
          turnOutcome: 'notObserved',
        },
      }, env);
    }
    return updateLane(options.repoRoot, lane.laneId, {
      state: observedLaneState(lane, inspected.phase),
      providerState: inspected.thread.status,
      turnId: inspected.turn?.id || lane.turnId,
      lastVerifiedAt: observedAt,
    }, env);
  }, env);
}

// Archive an exact-owned thread and then release its managed seat. It requires a
// harvest receipt first, refuses an active newest turn, sends thread/archive
// once, and accepts only an exact archived-listing row whose cwd matches the
// seat. An unverified archive leaves the lane in archiveUnknown for recovery.
async function retire(options, env = process.env) {
  const initial = ownedLane(options, env, 'read');
  const existingRetirement = pendingOperationForLane(options.repoRoot, initial.laneId, env);
  if (initial.state === 'worktreeRemoved' && !existingRetirement) return alreadyRetiredResult(initial);
  if (options.acceptManualSeatRemoval === true && existingRetirement?.details?.cleanupBlocked !== true) {
    throw new TransmogrifyError(
      'USAGE_ERROR',
      '--accept-manual-seat-removal requires an exact pending CLEANUP_BLOCKED retirement',
    );
  }
  return withLaneLease(options.repoRoot, initial.laneId, async () => {
    const ctx = { options, env, lane: ownedLane({ ...options, laneId: initial.laneId }, env, 'read'), pending: null };
    const admitted = await admitCodexRetirement(ctx);
    if (admitted) return admitted;
    const prepared = prepareRetirementOperation(options, ctx.lane, env);
    ctx.operation = prepared.operation;
    ctx.harvestReceipt = prepared.harvestReceipt;
    const settled = settleRetiredLane(ctx);
    if (settled) return settled;
    return withClient(options, async (client) => {
      assertRuntimeIdentity(ctx.lane, client);
      const reconciled = await archiveThread(ctx, client);
      ctx.lane = updateLane(options.repoRoot, ctx.lane.laneId, {
        state: 'archivedVerified',
        lastVerifiedAt: new Date().toISOString(),
      }, env);
      ctx.operation = updatePendingLaneOperation(options.repoRoot, ctx.lane.laneId, ctx.operation.operationId, {
        state: 'providerRetired',
      }, env);
      ctx.lane = finishRetiredCleanup(options, ctx.lane, ctx.operation, ctx.harvestReceipt, env);
      return laneResult('retire', ctx.lane, {
        operationId: ctx.operation.operationId,
        receipt: {
          archived: true,
          reconciled,
          worktreeRemoved: ctx.lane.state === 'worktreeRemoved',
          harvestedOutputSha256: ctx.harvestReceipt.outputSha256,
        },
      });
    }, env);
  }, env);
}

function alreadyRetiredResult(lane, extra = {}) {
  return laneResult('retire', lane, {
    ...extra,
    receipt: { archived: true, alreadyRetired: true, worktreeRemoved: true, ...(extra.receipt || {}) },
  });
}

// Under the lease: settle an unresolved first turn, refuse a permanently
// blocked cleanup without exact acknowledgement, verify the seat unless it is
// already gone as part of this retirement, and journal an acknowledged
// manual seat removal. Returns a result only when nothing remains to do.
async function admitCodexRetirement(ctx) {
  const { options, env } = ctx;
  let pending = pendingOperationForLane(options.repoRoot, ctx.lane.laneId, env);
  if (pending?.type === 'spawn') {
    assertSeatIdentity(options, ctx.lane, env);
    ctx.lane = await settleUnresolvedSpawnForRetirement(options, ctx.lane, pending, env);
    pending = pendingOperationForLane(options.repoRoot, ctx.lane.laneId, env);
  }
  if (ctx.lane.state === 'worktreeRemoved' && !pending) return alreadyRetiredResult(ctx.lane);
  const seatEntryPresent = ctx.lane.seat?.managed === true && pathEntryExists(ctx.lane.seat.path);
  const manualRemovalAcknowledged = options.acceptManualSeatRemoval === true ||
    pending?.details?.manualSeatRemoval?.acknowledged === true;
  if (pending?.type === 'retire' && pending.details.cleanupBlocked === true &&
      (seatEntryPresent || !manualRemovalAcknowledged)) {
    throw new TransmogrifyError(
      'CLEANUP_BLOCKED',
      'Codex managed worktree has a permanent cleanup block and requires exact manual-removal acknowledgement',
      { laneId: ctx.lane.laneId, providerRetired: true },
    );
  }
  const recoveringRemovedSeat = ctx.lane.state === 'worktreeRemoved' &&
    pending?.type === 'retire' && ctx.lane.seat?.managed === true;
  const manuallyRemovedBlockedSeat = pending?.type === 'retire' &&
    pending.details.cleanupBlocked === true && ctx.lane.seat?.managed === true &&
    !seatEntryPresent && manualRemovalAcknowledged;
  if (!recoveringRemovedSeat && !manuallyRemovedBlockedSeat) assertSeatIdentity(options, ctx.lane, env);
  if (manuallyRemovedBlockedSeat && pending.details.manualSeatRemoval?.acknowledged !== true) {
    pending = updatePendingLaneOperation(options.repoRoot, ctx.lane.laneId, pending.operationId, {
      state: pending.state,
      details: {
        ...pending.details,
        manualSeatRemoval: { acknowledged: true, observedAbsentAt: new Date().toISOString() },
      },
    }, env);
  }
  ctx.pending = pending;
  return null;
}

// A lane whose provider side is already retired needs no runtime: a removed
// seat closes the journal, an archived one finishes its cleanup.
function settleRetiredLane(ctx) {
  const { options, env, harvestReceipt } = ctx;
  if (ctx.lane.state === 'worktreeRemoved') {
    completeLaneOperation(options.repoRoot, ctx.lane.laneId, ctx.operation.operationId, { state: 'complete' }, env);
    return alreadyRetiredResult(ctx.lane, {
      operationId: ctx.operation.operationId,
      receipt: { harvestedOutputSha256: harvestReceipt.outputSha256 },
    });
  }
  if (ctx.lane.state === 'archivedVerified') {
    ctx.lane = finishRetiredCleanup(options, ctx.lane, ctx.operation, harvestReceipt, env);
    return laneResult('retire', ctx.lane, {
      operationId: ctx.operation.operationId,
      receipt: {
        archived: true,
        alreadyRetired: true,
        worktreeRemoved: ctx.lane.state === 'worktreeRemoved',
        harvestedOutputSha256: harvestReceipt.outputSha256,
      },
    });
  }
  return null;
}

function archiveUnknown(ctx, phase, error) {
  const { options, env } = ctx;
  ctx.lane = updateLane(options.repoRoot, ctx.lane.laneId, { state: 'archiveUnknown' }, env);
  updatePendingLaneOperation(options.repoRoot, ctx.lane.laneId, ctx.operation.operationId, {
    state: 'unknown',
    details: {
      ...ctx.operation.details,
      archiveFailurePhase: phase,
      causeCode: error?.code || 'TRANSPORT_UNKNOWN',
      archiveDeliveryBecameUnknownAt: new Date().toISOString(),
    },
  }, env);
}

// Archive the thread once and verify it in the archived listing. A prior
// archive whose delivery is unknown is only verified; a refused pre-dispatch
// check settles the journal notDelivered; anything after the dispatch that
// cannot be verified leaves the lane archiveUnknown. Returns whether the
// archive was verified by reconciliation of a prior dispatch.
async function archiveThread(ctx, client) {
  const { options, env } = ctx;
  if (ctx.lane.state === 'retireRequested' || ctx.lane.state === 'archiveUnknown') {
    const reconciled = await verifyArchived(client, ctx.lane, options);
    if (!reconciled) {
      updatePendingLaneOperation(options.repoRoot, ctx.lane.laneId, ctx.operation.operationId, { state: 'unknown' }, env);
      throw new TransmogrifyError('DELIVERY_UNKNOWN', 'prior archive delivery remains unverified');
    }
    return reconciled;
  }
  let turn;
  try {
    ({ turn } = await inspectThread(client, ctx.lane));
  } catch (error) {
    completeLaneOperation(options.repoRoot, ctx.lane.laneId, ctx.operation.operationId, {
      state: 'notDelivered',
      details: { ...ctx.operation.details, failedBeforeProviderDispatchAt: new Date().toISOString() },
    }, env);
    throw error;
  }
  if (turn?.status === 'inProgress') {
    completeLaneOperation(options.repoRoot, ctx.lane.laneId, ctx.operation.operationId, { state: 'notDelivered' }, env);
    throw new TransmogrifyError('TARGET_ACTIVE', 'refusing to retire a lane with an active newest turn');
  }
  ctx.lane = updateLane(options.repoRoot, ctx.lane.laneId, { state: 'retireRequested' }, env);
  ctx.operation = updatePendingLaneOperation(options.repoRoot, ctx.lane.laneId, ctx.operation.operationId, {
    state: 'providerRequestDispatched',
  }, env);
  try {
    await client.call('thread/archive', { threadId: ctx.lane.providerId });
    ctx.operation = updatePendingLaneOperation(options.repoRoot, ctx.lane.laneId, ctx.operation.operationId, {
      state: 'providerAcknowledged',
    }, env);
  } catch (error) {
    archiveUnknown(ctx, 'dispatch', error);
    throw error;
  }
  let reconciled;
  try {
    reconciled = await verifyArchived(client, ctx.lane, options);
  } catch (error) {
    archiveUnknown(ctx, 'verification', error);
    throw error;
  }
  if (!reconciled) {
    archiveUnknown(ctx, 'not-observed', null);
    throw new TransmogrifyError(
      'TRANSPORT_UNKNOWN',
      'archive was acknowledged but not verified in archived listing',
      { laneId: ctx.lane.laneId, providerId: ctx.lane.providerId },
    );
  }
  return reconciled;
}

module.exports = {
  listArchived,
  verifyArchived,
  requireHarvestedOutputSha256,
  retirementHarvestReceipt,
  prepareRetirementOperation,
  finishRetiredCleanup,
  settleUnresolvedSpawnForRetirement,
  retire,
};
