'use strict';

// Child observation: derive at most one durable parent event per child from
// local state and, when local state cannot decide, from one bounded provider
// read. Used by `lane.js wait`, `lane.js children --observe`, and the watcher,
// so every path that tells a parent about a child records the same events
// with the same fingerprints.

const {
  EVENT_KINDS, failDispatch, kindForEvent, kindSatisfies, listDispatches, recordEvent, recordObservation,
} = require('./dispatch');
const {
  listOperations, pendingOperationForLane, processMatches, requireOwnedLane, settleTerminalLaneOperationPointer,
  withLaneLease,
} = require('./state');

// Spawn journal states before the provider request has gone out. Only these
// are settled by the crash repair, so only these can be raced by a launcher
// that is still running; once the request is out, reconciliation settles from
// provider evidence and is safe to run beside the launcher.
const PRE_DISPATCH_SPAWN_STATES = new Set([
  'planned', 'seatReady', 'dispatching', 'providerRequestDispatched', 'providerCreated',
]);
// A pre-dispatch journal younger than this, with no recorded spawner process
// to check, is assumed to be in flight.
const SPAWN_IN_FLIGHT_GRACE_MS = 5 * 60 * 1000;
// Retirement journal states that a running retire command passes through on
// its way to completion. They raise attention only once they have stood
// still for this long, which is what a crashed retirement looks like.
const TRANSIENT_RETIRE_STATES = new Set([
  'providerRetired', 'remoteArchived', 'worktreeRemoved', 'localRemovalDispatching', 'localRemovalDispatched',
  'localRemoved',
]);
const RETIRE_IN_FLIGHT_GRACE_MS = 2 * 60 * 1000;
// A reserved dispatch with no lane this long after its creation was abandoned
// by a spawn that died before reserving one (the same bound spawnInFlight
// gives an unrecorded launcher).
const UNREGISTERED_SPAWN_GRACE_MS = SPAWN_IN_FLIGHT_GRACE_MS;

function retireInFlight(pending) {
  if (!pending || pending.type !== 'retire' || !TRANSIENT_RETIRE_STATES.has(pending.state)) return false;
  const updatedAtMs = Date.parse(pending.updatedAt || '');
  return Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs < RETIRE_IN_FLIGHT_GRACE_MS;
}

// True while the process that reserved a spawn may still be driving it
// through its pre-dispatch states. A continuous observer (the watcher, a
// background wait) must leave such a journal alone: the crash repair exists
// for a spawner that died, never for one that is still running.
function spawnInFlight(pending, dependencies = {}) {
  if (!pending || pending.type !== 'spawn' || !PRE_DISPATCH_SPAWN_STATES.has(pending.state)) return false;
  const spawner = pending.details?.spawner;
  if (spawner && Number.isInteger(spawner.pid)) return processMatches(spawner, dependencies);
  const createdAtMs = Date.parse(pending.createdAt || '');
  return Number.isFinite(createdAtMs) && Date.now() - createdAtMs < SPAWN_IN_FLIGHT_GRACE_MS;
}
const { providerForBackend, providerForTarget } = require('./providers');

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
    if (retireInFlight(pending)) return null;
    if (['providerRetiredCleanupDeferred', 'cleanupDeferred', 'localRemovalUnknown',
      'providerRetired', 'remoteArchived', 'worktreeRemoved',
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
  if (!terminal && !pending && ['archivedVerified', 'worktreeRemoved'].includes(lane.state)) {
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
  if (pending?.type !== 'spawn' || spawnInFlight(pending, values.processDependencies)) return lane;
  const options = {
    repoRoot: dispatch.child.repoRoot,
    laneId: lane.laneId,
    url: values.url || lane.runtime?.endpoint,
    claudeBin: values['claude-bin'],
    timeoutMs,
    commandTimeoutMs: timeoutMs,
  };
  try {
    await providerForBackend(lane.backend).adapter.reconcile(options, env);
  } catch (error) {
    // Exhausting this child's share of the wait budget is not an observation
    // failure: the journal is unchanged and the next round retries.
    if (error.code !== 'TIMEOUT') throw error;
  }
  return requireOwnedLane(dispatch.child.repoRoot, lane.laneId, env);
}

// The parent-facing phase and event for one live provider observation. Both
// providers report a completed assignment the same way: a turn that ended, or
// a lane that went from working to idle, is `child.turn-completed`; a lane
// first seen idle with no prior working phase is `child.idle-observed`.
function classifyObservation(provider, lane, result, priorPhase) {
  // Observations and parent events keep the pre-0.3 vocabulary: working,
  // waiting, idle, stopped, failed.
  let phase = result.phase === 'executing' ? 'working' : result.phase;
  let eventType = null;
  let providerFingerprint;
  let status;
  if (provider.target === 'codex') {
    const turn = result.turn;
    providerFingerprint = `turn:${turn?.id || 'none'}:${turn?.status || phase}`;
    if (turn && ['completed', 'interrupted', 'failed'].includes(turn.status)) {
      eventType = turn.status === 'failed' ? 'child.failed' : 'child.turn-completed';
      phase = turn.status === 'failed' ? 'failed' : 'idle';
      status = turn.status;
    } else if (phase === 'idle') {
      eventType = priorPhase === 'working' ? 'child.turn-completed' : 'child.idle-observed';
    }
  } else {
    const epoch = lane.providerIdentity?.executionEpochs?.at(-1);
    providerFingerprint = `epoch:${epoch?.epochId || 'none'}:${phase}`;
    if (phase === 'waiting') eventType = 'child.needs-attention';
    else if (phase === 'idle') eventType = priorPhase === 'working' ? 'child.turn-completed' : 'child.idle-observed';
    else if (phase === 'stopped') eventType = 'child.stopped';
    else if (phase === 'failed') eventType = 'child.failed';
  }
  return { phase, eventType, providerFingerprint, status };
}

// Observe one child and record at most one event for it. A dispatch whose lane
// stays unresolvable past a grace period becomes an attention event rather than
// a failure of the whole parent. `values` carries the optional provider flags
// (`url`, `claude-bin`); `deadline` and `remainingChildren` bound the provider
// reads so one busy child cannot consume the whole round.
async function observeDispatch(dispatch, values, env, deadline, remainingChildren) {
  // A dispatch settled as failed (its spawn never registered a lane) has
  // already produced its terminal event; there is nothing left to observe.
  if (dispatch.state === 'failed') return { lane: null, event: null, phase: 'failed' };
  const resolved = resolveDispatchLane(dispatch, env);
  let lane = resolved.lane;
  if (!lane) {
    const ageMs = Date.now() - Date.parse(dispatch.createdAt);
    if (resolved.reason === 'missing' && dispatch.state === 'reserved' &&
        Number.isFinite(ageMs) && ageMs >= UNREGISTERED_SPAWN_GRACE_MS) {
      // The spawning command reserved this dispatch but never reserved a
      // lane, and it has been gone long enough that no launcher can still be
      // driving it: settle the dispatch so the parent is told once.
      const failed = failDispatch(dispatch.dispatchId, 'spawn-not-registered', env);
      return { lane: null, event: failed.event, phase: 'failed' };
    }
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
      return { lane: null, event: observation.event, phase: null };
    }
    return { lane: null, event: null, phase: null };
  }
  const terminalPending = pendingOperationForLane(dispatch.child.repoRoot, lane.laneId, env);
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
  if (localEvent) return { lane, event: localEvent, phase: localEvent.data?.state ?? null };
  let pending = pendingOperationForLane(dispatch.child.repoRoot, lane.laneId, env);
  if (pending?.type === 'spawn' && spawnInFlight(pending, values.processDependencies)) {
    // The launching command is still writing this journal; report nothing
    // until it finishes or dies. Its own spawn event arrives through the
    // completed journal, and a dead spawner is repaired on the next pass.
    return { lane, event: null, phase: 'spawning' };
  }
  if (pending?.type === 'spawn') {
    const spawnRemainingMs = deadline - Date.now();
    if (spawnRemainingMs < 100) return { lane, event: null, phase: null };
    const spawnBudget = Math.max(
      100,
      Math.floor(spawnRemainingMs / Math.max(1, remainingChildren * 4)),
    );
    lane = await reconcilePendingSpawnDispatch(dispatch, lane, values, env, spawnBudget);
    localEvent = localEventForLane(dispatch, lane, env);
    if (localEvent) return { lane, event: localEvent, phase: localEvent.data?.state ?? null };
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
      return { lane, event: observation.event, phase: 'needs-attention' };
    }
  }
  if (['deliveryUnknown', 'archiveUnknown'].includes(lane.state) ||
      (!pendingOperationForLane(dispatch.child.repoRoot, lane.laneId, env) &&
       ['archivedVerified', 'worktreeRemoved'].includes(lane.state))) {
    return { lane, event: localEvent, phase: null };
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs < 100) return { lane, event: null, phase: null };
  const requestBudget = Math.max(100, Math.floor(remainingMs / Math.max(1, remainingChildren * 4)));
  if (!lane.providerId) return { lane, event: null, phase: null };
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
  const priorPhase = lane.providerState?.phase ?? values.priorPhase ?? null;
  const classified = classifyObservation(provider, lane, result, priorPhase);
  const observation = recordObservation({
    dispatchId: dispatch.dispatchId,
    phase: classified.phase,
    providerFingerprint: classified.providerFingerprint,
    eventType: classified.eventType,
    data: classified.eventType ? {
      state: classified.phase,
      ...(classified.status ? { status: classified.status } : {}),
    } : {},
  }, env);
  return { lane, event: observation.event, phase: classified.phase };
}

// One observation round over every outstanding child, collecting per-child
// errors instead of aborting the round. Every child is observed each round;
// the durable event store is read afterwards, so one busy child cannot starve
// a later child's event.
async function observeParentChildren(context, values, env, deadline) {
  const dispatches = listDispatches(context, env)
    .filter((dispatch) => !values['repo-root'] || dispatch.child.repoRoot === values['repo-root']);
  const errors = [];
  const observed = [];
  for (let index = 0; index < dispatches.length; index += 1) {
    if (Date.now() >= deadline) break;
    const dispatch = dispatches[index];
    try {
      const result = await observeDispatch(dispatch, values, env, deadline, dispatches.length - index);
      observed.push({
        dispatchId: dispatch.dispatchId,
        laneId: dispatch.child.laneId,
        phase: result.phase,
        eventType: result.event?.type ?? null,
      });
    } catch (error) {
      errors.push({ dispatchId: dispatch.dispatchId, code: error.code || 'OBSERVATION_FAILED' });
    }
  }
  return { dispatches, errors, observed };
}

module.exports = {
  EVENT_KINDS,
  RETIRE_IN_FLIGHT_GRACE_MS,
  SPAWN_IN_FLIGHT_GRACE_MS,
  classifyObservation,
  retireInFlight,
  spawnInFlight,
  kindForEvent,
  kindSatisfies,
  localEventForLane,
  observeDispatch,
  observeParentChildren,
  reconcilePendingSpawnDispatch,
  repositoryUnavailable,
  resolveDispatchLane,
};
