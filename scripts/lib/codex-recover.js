'use strict';

// Codex lane recovery and fleet reconciliation: local crash repair, the
// identity-checked endpoint move, and observation of every pending journal
// against the runtime without replaying any mutation.

const {
  TERMINAL_OPERATION_STATES, bindLaneSeat, bindLaneProvider, completeLaneOperation,
  listLanes, listOperations, pendingOperationForLane, repairUnstartedSpawn, rebindCodexRuntimeEndpoint,
  requireOwnedLane, updateLane, updateOperation, updatePendingLaneOperation, withLaneLease,
} = require('./state');
const { validateUrl } = require('./app-server');
const { nowMs, reconcileOk } = require('./adapter-kit');
const { phaseFields } = require('./output-schema');
const { materializeManagedSeat } = require('./worktree');
const {
  SPAWN_ABSENCE_JOURNAL_STATES, TransmogrifyError, UNDISPATCHED_RESUME_STATES, assertProviderSeat,
  assertRuntimeIdentity, assertSeatIdentity, findTurnByClientMessage, inspectThread,
  observedLaneState, runtimeUrl, spawnAbsenceGraceMs, updateLaneFromInspection, withClient,
} = require('./codex-runtime');
const {
  finishRetiredCleanup, retirementHarvestReceipt, verifyArchived,
} = require('./codex-retire');

// A lane bound on another endpoint is moved to the connected one only when
// the runtime identifies itself as the same Codex home on the same platform
// and the lane's thread is readable there at the reserved seat; the registry
// then records the new endpoint (state.js rebindCodexRuntimeEndpoint). Any
// other runtime, or an unreadable thread, is reported as a different runtime
// and nothing is written.
async function rebindEndpointMove(options, initial, client, env) {
  const lane = requireOwnedLane(options.repoRoot, initial.laneId, env);
  const entry = {
    laneId: lane.laneId,
    providerId: lane.providerId,
    state: lane.state,
    outcome: 'differentRuntime',
    delivery: 'unknown',
    repaired: [],
    pendingOperation: pendingOperationForLane(options.repoRoot, lane.laneId, env)?.type ?? null,
  };
  const identity = client.runtimeIdentity;
  const sameIdentity = ['codexHome', 'platformFamily', 'platformOs'].every((key) =>
    lane.runtime?.[key] !== undefined && lane.runtime[key] === identity?.[key]
  );
  if (!sameIdentity || !lane.providerId || lane.state === 'worktreeRemoved') return entry;
  let inspected;
  try {
    inspected = await inspectThread(client, lane);
  } catch (error) {
    // The runtime answered but does not hold this thread at the reserved
    // seat: not a move. Transport failures propagate as they do elsewhere.
    if (['RPC_ERROR', 'PROTOCOL_ERROR', 'OWNERSHIP_MISMATCH'].includes(error?.code)) {
      return { ...entry, causeCode: error.code };
    }
    throw error;
  }
  const rebound = rebindCodexRuntimeEndpoint(options.repoRoot, lane.laneId, identity, env);
  return {
    ...entry,
    state: rebound.state,
    phase: inspected.phase,
    providerPhase: inspected.thread.status?.type ?? null,
    outcome: 'runtimeRebound',
    delivery: 'confirmed',
    repaired: ['runtimeEndpoint'],
  };
}

// Local-only recovery for a lane that needs no provider call: settle an
// undispatched spawn journal, align a lane still marked planned behind a
// terminal journal, and clear a terminal pending pointer. Returns null when the
// lane genuinely requires provider observation.
async function repairLocalRecoveryState(options, initial, operations, env) {
  return withLaneLease(options.repoRoot, initial.laneId, async () => {
    const repair = repairUnstartedSpawn(
      options.repoRoot, initial.laneId, operations.get(initial.operationId), env,
    );
    if (repair) {
      return {
        laneId: repair.lane.laneId,
        providerId: repair.lane.providerId || null,
        state: repair.lane.state,
        outcome: repair.unstartedSpawn ? 'unstartedSpawnSettled' : 'terminalPointerCleared',
        delivery: repair.delivery,
        repaired: repair.repaired,
        pendingOperation: null,
      };
    }
    const lane = requireOwnedLane(options.repoRoot, initial.laneId, env);
    if (lane.state === 'worktreeRemoved') {
      return {
        laneId: lane.laneId,
        providerId: lane.providerId,
        state: lane.state,
        outcome: 'retirementFinished',
        delivery: 'confirmed',
        repaired: [],
        pendingOperation: null,
      };
    }
    return null;
  }, env);
}

// Time left in the aggregate recovery deadline. Exhaustion is TIMEOUT, so a
// fleet recovery cannot spend an unbounded budget on one call.
function remainingRecoveryMs(deadline) {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < 1) {
    throw new TransmogrifyError('TIMEOUT', 'Codex recovery exceeded its aggregate deadline');
  }
  return remaining;
}

// The one reconcile ok rule shared with Claude (ROADMAP.md priority 2): an
// entry counts against ok when its journal is still open (delivery unknown),
// when it was skipped rather than observed (differentRuntime), when its own
// error could not be classified further (uncertain), or when it carries a
// surfaced provider or local code at all -- a settled receipt never does.
// Reconcile one lane or the whole Codex fleet against the runtime. It repairs
// what local state alone proves, then observes the provider for the rest,
// never replaying an unknown mutation and never inferring creation from a title.
// Each entry names one outcome and carries the shape claude-adapter.reconcile
// shares: state, outcome, delivery, repaired[], and the pending journal type.
async function recover(options, env = process.env) {
  const recoveryDeadline = Number.isInteger(options.timeoutMs)
    ? Date.now() + options.timeoutMs : null;
  const endpoint = validateUrl(runtimeUrl(options, env));
  let lanes;
  if (options.laneId) {
    let exact;
    try {
      exact = requireOwnedLane(options.repoRoot, options.laneId, env);
    } catch (error) {
      if (/^NOT_OWNED:/.test(error.message)) {
        throw new TransmogrifyError('NOT_OWNED', `lane ${options.laneId} is not owned`);
      }
      throw error;
    }
    if (exact.backend !== 'codex-app-server') {
      throw new TransmogrifyError('ADAPTER_MISMATCH', `lane ${exact.laneId} uses ${exact.backend}`);
    }
    // A reservation that never bound a runtime has no endpoint to compare; its
    // local crash repair below needs no provider at all. A lane bound on
    // another endpoint is checked against the connected runtime's identity
    // below: the same Codex home and platform is a repairable endpoint move,
    // anything else stays RUNTIME_MISMATCH.
    lanes = [exact];
  } else {
    lanes = listLanes(options.repoRoot, env).filter((lane) =>
      lane.backend === 'codex-app-server'
    );
  }
  const operations = new Map(listOperations(options.repoRoot, env).map((entry) => [entry.operationId, entry]));
  const localResults = [];
  const providerLanes = [];
  const endpointMoves = [];
  for (const initial of lanes) {
    if (initial.runtime?.endpoint && initial.runtime.endpoint !== endpoint) {
      // Decided once the client is connected, from the runtime's own identity.
      endpointMoves.push(initial);
      continue;
    }
    const repaired = await repairLocalRecoveryState(options, initial, operations, env);
    if (repaired) localResults.push(repaired);
    else providerLanes.push(initial);
  }
  if (providerLanes.length === 0 && endpointMoves.length === 0) {
    return {
      version: 1,
      ok: reconcileOk(localResults),
      operation: 'recover',
      adapter: 'codex-app-server',
      results: localResults,
      receipt: { providerConnection: 'notRequired' },
    };
  }
  return withClient(recoveryDeadline === null ? options : {
    ...options,
    timeoutMs: remainingRecoveryMs(recoveryDeadline),
  }, async (client, initialized) => {
    if (recoveryDeadline !== null) {
      const call = client.call.bind(client);
      client.call = (method, params = {}) => call(
        method,
        params,
        remainingRecoveryMs(recoveryDeadline),
      );
    }
    const recovered = [...localResults];
    for (const initial of endpointMoves) {
      const moved = await withLaneLease(options.repoRoot, initial.laneId, () =>
        rebindEndpointMove(options, initial, client, env)
      );
      if (moved.outcome === 'differentRuntime' && options.laneId) {
        throw new TransmogrifyError('RUNTIME_MISMATCH', `lane ${initial.laneId} is owned on another runtime endpoint`);
      }
      recovered.push(moved);
    }
    for (const initial of providerLanes) {
      try {
        const result = await withLaneLease(options.repoRoot, initial.laneId, async () => {
          let lane = requireOwnedLane(options.repoRoot, initial.laneId, env);
          let pending = pendingOperationForLane(options.repoRoot, lane.laneId, env);
          let operation = pending || operations.get(lane.operationId);
          if (!lane.seat && lane.seatIntent && operation?.type === 'spawn') {
            const seat = materializeManagedSeat(options.repoRoot, lane.seatIntent);
            lane = bindLaneSeat(
              options.repoRoot,
              lane.laneId,
              operation.operationId,
              seat,
              env,
            );
            pending = pendingOperationForLane(options.repoRoot, lane.laneId, env);
            operation = pending;
          }
          assertSeatIdentity(options, lane, env);

          if (!lane.providerId) {
            if (!operation?.providerId) {
              return {
                laneId: lane.laneId,
                providerId: null,
                state: lane.state,
                outcome: 'spawnUnknown',
                delivery: 'unknown',
                repaired: [],
                pendingOperation: 'spawn',
              };
            }
            const candidate = { ...lane, providerId: operation.providerId };
            const inspected = await inspectThread(client, candidate);
            if (inspected.thread.cwd !== lane.seat.path) {
              throw new TransmogrifyError('OWNERSHIP_MISMATCH', 'journaled provider cwd does not match reserved seat');
            }
            lane = bindLaneProvider(options.repoRoot, lane.laneId, operation.providerId, {
              state: 'created',
              runtime: client.runtimeIdentity,
              ownership: {
                creationReceipt: {
                  providerId: operation.providerId,
                  requestedCwd: lane.seat.path,
                  responseCwd: null,
                  cwd: inspected.thread.cwd,
                  initializedUserAgent: initialized.userAgent,
                  recoveredAt: new Date().toISOString(),
                },
              },
            }, env);
          } else {
            assertRuntimeIdentity(lane, client);
          }

          if (lane.state === 'archivedVerified') {
            const repaired = [];
            if (lane.seat?.managed === true && options.cleanupWorktree !== false) {
              if (operation?.type !== 'retire') {
                throw new TransmogrifyError(
                  'HARVEST_REQUIRED',
                  'refusing recovered cleanup without a pending retirement harvest receipt',
                );
              }
              lane = finishRetiredCleanup(
                options,
                lane,
                operation,
                retirementHarvestReceipt(operation),
                env,
              );
              repaired.push('worktreeRemoved');
            } else if (operation?.type === 'retire') {
              completeLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
                state: 'complete',
              }, env);
            }
            return {
              laneId: lane.laneId,
              providerId: lane.providerId,
              state: lane.state,
              outcome: 'retirementFinished',
              delivery: 'confirmed',
              repaired,
              pendingOperation: null,
            };
          }
          if (lane.state === 'retireRequested' || lane.state === 'archiveUnknown') {
            if (operation?.type !== 'retire') {
              throw new TransmogrifyError(
                'HARVEST_REQUIRED',
                'refusing retirement recovery without a pending harvest receipt',
              );
            }
            const archived = await verifyArchived(client, lane, options);
            if (!archived) {
              return {
                laneId: lane.laneId,
                providerId: lane.providerId,
                state: lane.state,
                outcome: 'retirementPending',
                delivery: 'unknown',
                repaired: [],
                pendingOperation: 'retire',
              };
            }
            lane = updateLane(options.repoRoot, lane.laneId, {
              state: 'archivedVerified',
              lastVerifiedAt: new Date().toISOString(),
            }, env);
            operation = updatePendingLaneOperation(
              options.repoRoot,
              lane.laneId,
              operation.operationId,
              { state: 'providerRetired' },
              env,
            );
            const repaired = ['archiveVerified'];
            if (lane.seat?.managed === true && options.cleanupWorktree !== false) {
              lane = finishRetiredCleanup(
                options,
                lane,
                operation,
                retirementHarvestReceipt(operation),
                env,
              );
              repaired.push('worktreeRemoved');
            } else {
              completeLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
                state: 'complete',
              }, env);
            }
            return {
              laneId: lane.laneId,
              providerId: lane.providerId,
              state: lane.state,
              outcome: 'archiveVerified',
              delivery: 'confirmed',
              repaired,
              pendingOperation: null,
            };
          }
          if (operation?.type === 'retire') {
            return {
              laneId: lane.laneId,
              providerId: lane.providerId,
              state: lane.state,
              outcome: 'retirementPending',
              delivery: 'unknown',
              pendingOperation: 'retire',
              repaired: [],
            };
          }

          if (pending && ['steer', 'interrupt', 'resume'].includes(pending.type)) {
            // A journal that never reached its provider request is proven
            // undelivered. For a resume, thread/resume only loads the thread;
            // the input goes out with turn/start, which is journaled as
            // turnDispatching before it is sent, so every earlier resume state
            // is undispatched input as well.
            const undispatched = pending.type === 'resume'
              ? UNDISPATCHED_RESUME_STATES.has(pending.state)
              : pending.state === 'planned';
            if (undispatched) {
              completeLaneOperation(options.repoRoot, lane.laneId, pending.operationId, {
                state: 'notDelivered',
                details: {
                  ...pending.details,
                  recoveredBeforeDispatchAt: new Date().toISOString(),
                },
              }, env);
              return {
                laneId: lane.laneId,
                providerId: lane.providerId,
                state: lane.state,
                outcome: `${pending.type}NotDelivered`,
                delivery: 'notDelivered',
                repaired: [`clearedUndispatched${pending.type[0].toUpperCase()}${pending.type.slice(1)}`],
                pendingOperation: null,
              };
            }
            const pendingInspection = await inspectThread(client, lane);
            if (pending.type === 'steer') {
              // turn/steer's response carries only { turnId }, no item body to
              // verify inline the way turn/start's response can. The exact
              // receipt is the same clientId marker turn/start uses, searched
              // the same way; its absence only proves non-delivery once the
              // target turn can no longer accept more steered input.
              const recoveredTurnId = await findTurnByClientMessage(
                client,
                lane.providerId,
                pending.operationId,
                pending.details.messageSha256,
              );
              if (recoveredTurnId) {
                if (recoveredTurnId !== pending.details.expectedTurnId) {
                  throw new TransmogrifyError(
                    'PROTOCOL_ERROR',
                    'persisted steer input receipt named a different turn than the steer target',
                  );
                }
                lane = updateLaneFromInspection(options, lane, pendingInspection, env);
                completeLaneOperation(options.repoRoot, lane.laneId, pending.operationId, {
                  state: 'complete',
                  details: {
                    ...pending.details,
                    recoveredTurnId,
                    postconditionObservedAt: new Date().toISOString(),
                  },
                }, env);
                return {
                  laneId: lane.laneId,
                  providerId: lane.providerId,
                  state: lane.state,
                  ...phaseFields('codex', pendingInspection.phase),
                  outcome: 'steerInputReceipt',
                  delivery: 'confirmed',
                  repaired: ['steerInputReceipt'],
                  pendingOperation: null,
                };
              }
              const targetIsActive = pendingInspection.turn?.id === pending.details.expectedTurnId &&
                pendingInspection.turn.status === 'inProgress';
              if (targetIsActive) {
                return {
                  laneId: lane.laneId,
                  providerId: lane.providerId,
                  state: lane.state,
                  outcome: 'steerUnknown',
                  delivery: 'unknown',
                  pendingOperation: 'steer',
                  repaired: [],
                };
              }
              lane = updateLaneFromInspection(options, lane, pendingInspection, env);
              completeLaneOperation(options.repoRoot, lane.laneId, pending.operationId, {
                state: 'notDelivered',
                details: {
                  ...pending.details,
                  notDeliveredObservedAt: new Date().toISOString(),
                },
              }, env);
              return {
                laneId: lane.laneId,
                providerId: lane.providerId,
                state: lane.state,
                ...phaseFields('codex', pendingInspection.phase),
                outcome: 'steerInputAbsent',
                delivery: 'notDelivered',
                repaired: ['steerInputAbsent'],
                pendingOperation: null,
              };
            }
            if (pending.type === 'interrupt') {
              const targetIsActive = pendingInspection.turn?.id === pending.details.turnId &&
                pendingInspection.turn.status === 'inProgress';
              if (targetIsActive) {
                return {
                  laneId: lane.laneId,
                  providerId: lane.providerId,
                  state: lane.state,
                  outcome: 'interruptUnknown',
                  delivery: 'unknown',
                  pendingOperation: 'interrupt',
                  repaired: [],
                };
              }
              lane = updateLaneFromInspection(options, lane, pendingInspection, env);
              completeLaneOperation(options.repoRoot, lane.laneId, pending.operationId, {
                state: 'complete',
                details: {
                  ...pending.details,
                  postconditionObservedAt: new Date().toISOString(),
                  observedTurnId: pendingInspection.turn?.id || null,
                  observedTurnStatus: pendingInspection.turn?.status || null,
                },
              }, env);
              return {
                laneId: lane.laneId,
                providerId: lane.providerId,
                state: lane.state,
                ...phaseFields('codex', pendingInspection.phase),
                outcome: 'interruptSettled',
                delivery: 'confirmed',
                repaired: ['interruptPostcondition'],
                pendingOperation: null,
              };
            }

            const recoveredTurnId = await findTurnByClientMessage(
              client,
              lane.providerId,
              pending.operationId,
              pending.details.messageSha256,
            );
            if (recoveredTurnId) {
              lane = updateLaneFromInspection(options, lane, pendingInspection, env);
              completeLaneOperation(options.repoRoot, lane.laneId, pending.operationId, {
                state: 'complete',
                details: {
                  ...pending.details,
                  recoveredTurnId,
                  postconditionObservedAt: new Date().toISOString(),
                },
              }, env);
              return {
                laneId: lane.laneId,
                providerId: lane.providerId,
                state: lane.state,
                ...phaseFields('codex', pendingInspection.phase),
                outcome: 'resumeInputReceipt',
                delivery: 'confirmed',
                repaired: ['resumeInputReceipt'],
                pendingOperation: null,
              };
            }
            return {
              laneId: lane.laneId,
              providerId: lane.providerId,
              state: lane.state,
              outcome: 'resumeUnknown',
              delivery: 'unknown',
              pendingOperation: 'resume',
              repaired: [],
            };
          }

          let inspected = await inspectThread(client, lane);
          const repaired = [];
          const spawnPending = operation?.type === 'spawn' &&
            !TERMINAL_OPERATION_STATES.has(operation.state);
          const recoveredSpawnTurnId = spawnPending
            ? await findTurnByClientMessage(
              client,
              lane.providerId,
              operation.operationId,
              operation.details.inputSha256,
            )
            : null;
          if (spawnPending && !recoveredSpawnTurnId &&
              SPAWN_ABSENCE_JOURNAL_STATES.has(operation.state) &&
              inspected.turn?.status !== 'inProgress' &&
              typeof operation.details.turnDispatchStartedAt === 'string') {
            const dispatchedAtMs = Date.parse(operation.details.turnDispatchStartedAt);
            if (Number.isFinite(dispatchedAtMs) &&
                nowMs(options) - dispatchedAtMs >= spawnAbsenceGraceMs(options)) {
              const observedAbsentAt = new Date(nowMs(options)).toISOString();
              completeLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
                state: 'notDelivered',
                details: {
                  ...operation.details,
                  outcome: 'spawnInputAbsent',
                  observedAbsentAt,
                },
              }, env);
              // A spawn only reaches these journal states once its provider id
              // is bound, so the lane here is one of created, deliveryUnknown,
              // idle, or active (an earlier observation in this same call can
              // advance it that far). LANE_TRANSITIONS gives every one of
              // those a direct edge to failed, so no intermediate hop is
              // needed.
              lane = updateLane(options.repoRoot, lane.laneId, {
                state: 'failed',
                providerState: inspected.thread.status,
                turnId: inspected.turn?.id || lane.turnId,
                lastVerifiedAt: observedAbsentAt,
              }, env);
              return {
                laneId: lane.laneId,
                providerId: lane.providerId,
                state: lane.state,
                outcome: 'spawnInputAbsent',
                delivery: 'notDelivered',
                repaired: ['spawnInputAbsent'],
                pendingOperation: null,
              };
            }
          }
          if (['created', 'materialized', 'deliveryUnknown'].includes(lane.state) &&
              inspected.turn && (!spawnPending || recoveredSpawnTurnId)) {
            if (inspected.thread.name !== lane.displayName) {
              await client.call('thread/name/set', {
                threadId: lane.providerId,
                name: lane.displayName,
              });
              const readBack = await client.call('thread/read', {
                threadId: lane.providerId,
                includeTurns: false,
              });
              assertProviderSeat(lane, readBack?.thread, undefined, 'thread/read');
              if (readBack.thread.name !== lane.displayName) {
                throw new TransmogrifyError('PROTOCOL_ERROR', 'recovered thread name read-back did not match');
              }
              repaired.push('name');
              inspected = { ...inspected, thread: readBack.thread };
            }
            repaired.push(spawnPending ? 'spawnInputReceipt' : 'turnReceipt');
          }
          lane = updateLane(options.repoRoot, lane.laneId, {
            state: observedLaneState(lane, inspected.phase),
            providerState: inspected.thread.status,
            turnId: inspected.turn?.id || lane.turnId,
            lastVerifiedAt: new Date().toISOString(),
          }, env);
          if (spawnPending && recoveredSpawnTurnId) {
            const patch = {
              state: 'complete',
              details: {
                ...operation.details,
                recoveredTurnId: recoveredSpawnTurnId,
                postconditionObservedAt: new Date().toISOString(),
              },
            };
            const currentLane = requireOwnedLane(options.repoRoot, lane.laneId, env);
            if (currentLane.pendingOperationId === operation.operationId) {
              completeLaneOperation(options.repoRoot, lane.laneId, operation.operationId, patch, env);
            } else {
              updateOperation(options.repoRoot, operation.operationId, patch, env);
            }
          }
          // A turn found for a still-pending spawn is that spawn's own input
          // receipt; found with nothing pending, it is just this call's normal
          // re-observation of an already-materialized lane.
          const outcome = spawnPending
            ? (recoveredSpawnTurnId ? 'spawnInputReceipt' : 'spawnUnknown')
            : inspected.turn
              ? (repaired.includes('turnReceipt') ? 'turnObserved' : 'verified')
              : 'spawnUnknown';
          return {
            laneId: lane.laneId,
            providerId: lane.providerId,
            state: lane.state,
            ...phaseFields('codex', inspected.phase),
            outcome,
            delivery: spawnPending
              ? recoveredSpawnTurnId ? 'confirmed' : 'unknown'
              : inspected.turn ? 'confirmed' : 'unknown',
            pendingOperation: spawnPending && !recoveredSpawnTurnId ? 'spawn' : null,
            repaired,
          };
        }, env);
        recovered.push(result);
      } catch (error) {
        if (error.code === 'CLEANUP_RETRYABLE') {
          recovered.push({
            laneId: initial.laneId,
            state: initial.state,
            outcome: 'cleanupRetryable',
            code: error.code,
            providerRetired: true,
            cleanup: 'retryable',
            delivery: 'unknown',
            repaired: [],
            pendingOperation: 'retire',
          });
          continue;
        }
        const causeCode = error.details?.causeCode;
        recovered.push({
          laneId: initial.laneId,
          providerId: initial.providerId,
          state: initial.state,
          outcome: 'uncertain',
          error: error.message,
          code: error.code || 'RECOVERY_ERROR',
          delivery: 'unknown',
          repaired: [],
          pendingOperation: null,
          ...(causeCode ? { causeCode } : {}),
          ...(error.details?.ownerAction ? { ownerAction: error.details.ownerAction } : {}),
        });
      }
    }
    return {
      version: 1,
      ok: reconcileOk(recovered),
      operation: 'recover',
      adapter: 'codex-app-server',
      results: recovered,
      receipt: { providerConnection: 'verified' },
    };
  }, env);
}

// Fleet reconciliation as the lane CLI's `reconcile` operation names it: the
// same observation recover() performs, labeled and schema-projected for
// `reconcile` rather than for the owner-facing no-input `recover` command
// that also calls recover() directly through recoverLane above.
async function reconcile(options, env = process.env) {
  const result = await recover(options, env);
  return { ...result, operation: 'reconcile' };
}

module.exports = {
  rebindEndpointMove,
  repairLocalRecoveryState,
  remainingRecoveryMs,
  recover,
  reconcile,
};
