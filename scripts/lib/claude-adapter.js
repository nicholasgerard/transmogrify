'use strict';

// Claude Code lane adapter: spawn, status, steer, stop, recover, retire, and
// fleet reconciliation over the public CLI, the Remote Control bridge, and one
// pinned private archival call. A lane's session, job, bridge, and worker
// execution epoch form a single immutable identity, and every mutation is
// journaled before dispatch and confirmed against that exact identity. It never
// touches a session it does not own and never replays an unobserved delivery.

const crypto = require('node:crypto');
const {
  beginLaneOperation, pendingOperationForLane, updateLane, withLaneLease,
} = require('./state');
const { MAX_STEER_BYTES, sha256 } = require('./claude-surface');
const { laneResult, nowMs, profileFailure } = require('./adapter-kit');
const { phaseFields } = require('./output-schema');
const { sleep } = require('./async');
const { createClaudeCliCatalog } = require('./execution-profile');
const {
  CLAUDE_GUIDANCE, CLAUDE_SELECTION_GUIDE, INTENT_DESCRIPTORS,
} = require('./execution-guidance');
const {
  BACKEND, ClaudeTransmogrifyError, RETIRED_STATES, RETIRING_STATES, assertSeat, capabilities,
  claudeCatalogSource, commandDeadline, completePending, ensureLatestEpoch, observedStop,
  ownedLane, phaseForAgent, preflight, reconcileSteer, remainingCommandMs, runtimeForLane,
  surfaceFor, updatePending, updateRunningLane,
} = require('./claude-runtime');
const { reconcile, recover } = require('./claude-recover');
const { retire, stop } = require('./claude-retire');
const { spawnLane } = require('./claude-spawn');

// What the lane CLI needs to know about this adapter without reading its
// code: the lifecycle operations it implements, the provider flags it accepts,
// and whether recovery takes input (Claude recovery never does).
const descriptor = Object.freeze({
  target: 'claude',
  backend: BACKEND,
  operations: new Set(['spawn', 'status', 'steer', 'stop', 'recover', 'retire', 'reconcile']),
  options: new Set(['claude-bin', 'private-archive', 'finish-retirements']),
  recoverAcceptsInput: false,
});

// A queued steer follow-up lands in the owned transcript a few seconds after
// the write returns. Steer verification retries the same transcript check
// reconcile uses inside this window, so the common case observes delivery
// without a second command.
const STEER_VERIFY_TIMEOUT_MS = 20_000;
const STEER_VERIFY_DELAY_MS = 500;

// Public capability report for Claude. Availability is documented rather than
// observed: the account's real access is only proven at launch.
function executionCapabilities(options = {}, env = process.env) {
  const surface = surfaceFor(options);
  const runtime = preflight(options, env, surface);
  let catalog;
  try {
    catalog = createClaudeCliCatalog({
      source: claudeCatalogSource(runtime),
    });
  } catch (error) { return profileFailure(error); }
  return {
    version: 1,
    ok: true,
    operation: 'capabilities',
    target: 'claude',
    intents: INTENT_DESCRIPTORS,
    selectionGuide: CLAUDE_SELECTION_GUIDE,
    availability: {
      kind: 'documented-compatibility',
      observed: false,
      note: 'Account and organization availability is verified by Claude at launch.',
    },
    guidance: CLAUDE_GUIDANCE,
    catalog,
  };
}

// Read one lane. A retiring or retired lane answers from durable state without
// touching the provider; otherwise the exact agent row is required and its
// worker must still be the journaled execution epoch.
async function status(options, env = process.env) {
  const deadline = commandDeadline(options);
  let lane = ownedLane(options, env, false);
  if (RETIRED_STATES.has(lane.state) || RETIRING_STATES.has(lane.state)) {
    const phase = RETIRED_STATES.has(lane.state) ? 'retired' : 'retiring';
    return laneResult('status', lane, {
      ...phaseFields('claude', phase),
      receipt: { durableLifecycle: true, providerInspectionDeferred: true },
    });
  }
  assertSeat(options, lane);
  const surface = surfaceFor(options);
  const runtime = runtimeForLane({
    ...options,
    ...(deadline === null ? {} : { commandTimeoutMs: remainingCommandMs(deadline, 100) }),
  }, lane, env, surface);
  const agents = await surface.agents(runtime, deadline === null
    ? { timeoutMs: options.commandTimeoutMs }
    : { timeoutMs: remainingCommandMs(deadline, 100) });
  const agent = surface.exactOwnedAgent(agents, lane.providerIdentity, {
    name: lane.displayName, cwd: lane.seat.path,
  });
  let execution = null;
  if (agent.pid) {
    execution = surface.executionReceipt(runtime, lane, agent, {
      timeoutMs: deadline === null ? options.commandTimeoutMs : remainingCommandMs(deadline),
    });
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
    ...phaseFields('claude', phase),
    receipt: {
      exactSession: true,
      executionEpoch: execution ? updated.providerIdentity.executionEpochs.length : null,
    },
  });
}

// Poll the same transcript receipt reconcile uses until the marker is
// observed or the verification window (bounded by the aggregate command
// deadline too) runs out. Only "not yet visible" retries; any other failure,
// including the deadline itself, stops immediately so the caller can mark
// the delivery unknown exactly as it does when nothing was ever observed.
async function awaitSteerDelivery(options, surface, runtime, lane, operation, timeoutMs, delayMs, deadline) {
  const windowEnd = nowMs(options) + timeoutMs;
  for (;;) {
    try {
      if (deadline !== null) remainingCommandMs(deadline);
      return surface.verifyDeliveryTranscript(runtime, lane.providerId, {
        messageSha256: operation.details.messageSha256,
        deliveryToken: operation.details.deliveryToken,
      });
    } catch (error) {
      const remaining = Math.min(
        windowEnd - nowMs(options),
        deadline === null ? Infinity : deadline.msLeft() - 100,
      );
      if (error.code !== 'DELIVERY_UNCERTAIN' || remaining <= 0) throw error;
      await sleep(Math.min(delayMs, Math.max(0, remaining)));
    }
  }
}
// Queue a follow-up on an exact-owned running session through Remote Control.
// The message is framed with a delivery token and must be observed in that
// session's transcript before the operation completes. A refused write is
// NOT_DELIVERED; a queued but unobserved write is DELIVERY_UNCERTAIN and is
// never resent, because the provider may already hold it.
async function steer(options, env = process.env) {
  if (typeof options.message !== 'string' || !options.message) {
    throw new ClaudeTransmogrifyError('USAGE_ERROR', 'steer requires a non-empty message');
  }
  if (options.writeTimeoutMs !== undefined &&
      (!Number.isInteger(options.writeTimeoutMs) || options.writeTimeoutMs < 100 ||
        options.writeTimeoutMs > 120_000)) {
    throw new ClaudeTransmogrifyError('USAGE_ERROR', 'invalid Claude follow-up timeout');
  }
  const steerVerifyTimeoutMs = options.steerVerifyTimeoutMs ?? STEER_VERIFY_TIMEOUT_MS;
  const steerVerifyDelayMs = options.steerVerifyDelayMs ?? STEER_VERIFY_DELAY_MS;
  if (!Number.isInteger(steerVerifyTimeoutMs) || steerVerifyTimeoutMs < 0 ||
      !Number.isInteger(steerVerifyDelayMs) || steerVerifyDelayMs < 0) {
    throw new ClaudeTransmogrifyError('USAGE_ERROR', 'steer verification window must be non-negative integers');
  }
  const deadline = commandDeadline(options);
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
        details: { ...operation.details, dispatchStartedAt: nowMs(options) },
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
          dispatchFinishedAt: nowMs(options),
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
      const observed = await awaitSteerDelivery(
        options, surface, runtime, lane, operation, steerVerifyTimeoutMs, steerVerifyDelayMs, deadline,
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

module.exports = {
  BACKEND, ClaudeTransmogrifyError, capabilities, descriptor, reconcile, recover, retire,
  executionCapabilities, spawn: spawnLane, status, steer, stop,
};
