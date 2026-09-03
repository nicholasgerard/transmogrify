'use strict';

// Codex app-server lane adapter: spawn, status, steer, interrupt, boundary
// resume, retire, and recovery for exact-owned Codex threads. Every provider
// mutation is journaled before dispatch and confirmed by an exact receipt: the
// client message id, the provider cwd, or the archived listing row. An
// unconfirmed outcome is projected as unknown. It never replays an input whose
// delivery is unknown and never widens a thread's sandbox or approval policy.

const crypto = require('node:crypto');
const path = require('node:path');
const {
  beginLaneOperation, bindLaneSeat, bindLaneProvider, completeLaneOperation, ensureRegistry,
  pendingOperationForLane, reserveSpawn, updateLane, updatePendingLaneOperation, withLaneLease,
} = require('./state');
const { validateUrl } = require('./app-server');
const { executionRequest, laneResult, profileFailure, worktreesRoot } = require('./adapter-kit');
const { phaseFields } = require('./output-schema');
const { check: desktopAttachCheck } = require('./desktop-attach');
const {
  failDispatch, markDispatchJournaled, recordEvent, recordObservation, reserveDispatch, setObservedProfile,
} = require('./dispatch');
const {
  ExecutionProfileError,
  catalogFromCodexModelList,
  requestFromProfile,
  resolveCodexExecutionProfile,
  stableStringify,
  validateUnobservedProfile,
  withObservedExecution,
} = require('./execution-profile');
const {
  CODEX_GUIDANCE, CODEX_SELECTION_GUIDE, INTENT_DESCRIPTORS,
} = require('./execution-guidance');
const { materializeManagedSeat, planManagedSeat, verifySeat } = require('./worktree');
const {
  canonicalLaneName, laneNameError, normalizeThreadStatus, ownedLaneNameError,
} = require('./validation');
const {
  TransmogrifyError, assertPendingMutation, assertProviderSeat, assertRuntimeIdentity,
  assertSeatIdentity, findTurnByClientMessage, inspectThread, markLaneDeliveryUnknown,
  messageDigest, observedLaneState, ownedLane, readModelCatalog, runtimeUrl, turnReceiptVerificationBounds,
  updateLaneFromInspection, verifiedUserMessageTurnReceipt, withClient,
} = require('./codex-runtime');
const { reconcile, recover } = require('./codex-recover');
const { retire } = require('./codex-retire');

// What the lane CLI needs to know about this adapter without reading its
// code: the lifecycle operations it implements, the provider flags it accepts,
// and whether recovery takes input. --finish-retirements is accepted for
// symmetry; Codex finishes every eligible retirement during recovery anyway.
const descriptor = Object.freeze({
  target: 'codex',
  backend: 'codex-app-server',
  operations: new Set(['spawn', 'status', 'steer', 'interrupt', 'recover', 'retire', 'reconcile']),
  options: new Set(['url', 'finish-retirements', 'allow-protocol-only']),
  recoverAcceptsInput: true,
});

// Resolve the immutable execution profile against the live model catalog. A
// supplied profile must resolve identically or it is refused as stale. This
// runs before any reservation, so a refusal here mutated nothing.
async function resolveSpawnProfile(options, env) {
  let supplied = null;
  if (options.executionProfile !== undefined) {
    try {
      supplied = validateUnobservedProfile(options.executionProfile);
      if (supplied.provider !== 'codex') {
        throw new ExecutionProfileError('INVALID_PROFILE', 'execution profile provider is not codex');
      }
    } catch (error) { return profileFailure(error); }
  }
  return withClient(options, async (client, initialized) => {
    const modelList = await readModelCatalog(client);
    const catalogSha256 = crypto.createHash('sha256')
      .update(stableStringify(modelList)).digest('hex');
    try {
      const resolved = resolveCodexExecutionProfile({
        request: supplied ? requestFromProfile(supplied) : executionRequest(options),
        modelList,
        guidance: CODEX_GUIDANCE,
        source: {
          kind: 'app-server:model/list',
          userAgent: initialized.userAgent,
          catalogSha256,
          verifiedAt: '2026-09-02',
        },
      });
      if (supplied && stableStringify(supplied) !== stableStringify(resolved)) {
        throw new ExecutionProfileError(
          'STALE_PROFILE', 'supplied Codex execution profile does not match current capabilities',
        );
      }
      return resolved;
    } catch (error) { return profileFailure(error); }
  }, env);
}

// Public capability report for Codex: intents, selection guide, guidance, and
// the catalog derived from a fully paginated live model/list.
async function executionCapabilities(options = {}, env = process.env) {
  return withClient(options, async (client, initialized) => {
    const modelList = await readModelCatalog(client);
    let catalog;
    try {
      catalog = catalogFromCodexModelList(modelList, {
        source: {
          kind: 'app-server:model/list',
          userAgent: initialized.userAgent,
          verifiedAt: '2026-09-02',
        },
      });
    } catch (error) { return profileFailure(error); }
    return {
      version: 1,
      ok: true,
      operation: 'capabilities',
      target: 'codex',
      intents: INTENT_DESCRIPTORS,
      selectionGuide: CODEX_SELECTION_GUIDE,
      availability: {
        kind: 'runtime-advertised',
        observed: true,
        note: 'Selectable models and native tiers come from the fully paginated live model/list response.',
      },
      guidance: CODEX_GUIDANCE,
      catalog,
    };
  }, env);
}

// Operator-readable phrasing for each non-attached Desktop state, so a refusal
// names the state that was actually observed.
const ATTACHMENT_DESCRIPTIONS = new Map([
  ['unattached', 'running without a connection to the selected runtime'],
  ['notRunning', 'not running'],
  ['notInstalled', 'not installed'],
  ['attachedElsewhere', 'attached to a different runtime'],
  ['unsupportedPlatform', 'unavailable on this platform'],
  ['disabled', 'disabled by TRANSMOGRIFY_DESKTOP_ATTACH=off'],
  ['toolUnavailable', 'not inspectable because a system tool is unavailable'],
]);

// Native visibility is a measured receipt: Codex Desktop holding a live
// connection to the runtime this lane is created on. Without it a lane is
// recorded protocol-only, and only with the owner's explicit flag.
async function resolveSpawnVisibility(options, endpoint, env) {
  const inspect = options.desktopAttachment || desktopAttachCheck;
  let receipt;
  try {
    receipt = await inspect({ url: endpoint }, env);
  } catch {
    receipt = { attachment: { state: 'toolUnavailable' }, desktop: null };
  }
  const attachment = receipt?.attachment || { state: 'unknown' };
  if (attachment.state === 'attached') {
    return {
      surface: 'codex',
      state: 'desktopAttached',
      receipt: {
        runtimeUrl: endpoint,
        evidence: attachment.evidence,
        clientPid: attachment.clientPid,
        connection: attachment.connection,
        observedAt: attachment.observedAt,
        bundleId: receipt.desktop?.bundleId ?? null,
        desktopVersion: receipt.desktop?.version ?? null,
        desktopBuild: receipt.desktop?.build ?? null,
        buildTested: receipt.desktop?.buildTested === true,
      },
    };
  }
  if (options.allowProtocolOnly === true) {
    return { surface: 'codex', state: 'protocolOnlyByOwnerOverride', attachment: attachment.state };
  }
  const described = ATTACHMENT_DESCRIPTIONS.get(attachment.state) || 'in an unknown state';
  throw new TransmogrifyError(
    'NATIVE_VISIBILITY_REQUIRED',
    `Codex spawn requires a native-visibility receipt and Codex Desktop is ${described}; run desktop-attach.js ensure (ask the owner before a relaunch), or pass --allow-protocol-only for a deliberately non-native lane`,
  );
}

// Create an exact-owned Codex lane: resolve visibility and profile, reserve the
// lane, seat, and spawn journal, then start the thread, dispatch the first turn,
// and verify its input receipt and thread name. A failure before the provider
// request is failed or notDelivered; any failure after thread/start keeps the
// returned provider id, marks the lane delivery-unknown, and replays nothing.
async function spawn(options, env = process.env) {
  if (!options.repoRoot || !path.isAbsolute(options.repoRoot) ||
      typeof options.input !== 'string' || !options.input) {
    throw new TransmogrifyError('USAGE_ERROR', 'spawn requires absolute repoRoot, name, and input');
  }
  const nameProblem = laneNameError(options.name, 'Codex lane name');
  if (nameProblem) throw new TransmogrifyError('USAGE_ERROR', nameProblem);
  options = { ...options, name: canonicalLaneName(options.name) };
  const canonicalNameProblem = ownedLaneNameError(options.name, 'Codex lane name');
  if (canonicalNameProblem) {
    throw new TransmogrifyError('USAGE_ERROR', canonicalNameProblem);
  }
  const receiptVerification = turnReceiptVerificationBounds(options);
  const endpoint = validateUrl(runtimeUrl(options, env));
  const visibility = await resolveSpawnVisibility(options, endpoint, env);
  if (options.parentContext || options.executionProfile !== undefined) {
    options = { ...options, executionProfile: await resolveSpawnProfile(options, env) };
  }
  const laneId = options.laneId || crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const dispatchEnvelope = options.parentContext ? reserveDispatch({
    parentContext: options.parentContext,
    repoRoot: options.repoRoot,
    laneId,
    targetProvider: 'codex',
    backend: 'codex-app-server',
    displayName: options.name,
    profile: options.executionProfile,
    prompt: options.input,
  }, env) : null;
  if (dispatchEnvelope) {
    options = {
      ...options,
      input: dispatchEnvelope.renderedPrompt,
      dispatch: dispatchEnvelope.dispatch,
      lineage: dispatchEnvelope.lineage,
    };
  }
  ensureRegistry(options.repoRoot, env);
  let lane;
  let seat;
  let operation;
  let providerRequestDispatched = false;
  let spawnVerified = false;
  let providerId = null;

  try {
    const seatIntent = options.cwd
      ? null
      : planManagedSeat(options.repoRoot, worktreesRoot(options, env), laneId, {
        branchName: options.branchName,
        baseRef: options.baseRef,
      });
    seat = options.cwd
      ? verifySeat(options.repoRoot, options.cwd, worktreesRoot(options, env))
      : null;
    const operationDetails = {
      target: 'codex',
      name: options.name,
      inputSha256: crypto.createHash('sha256').update(options.input).digest('hex'),
      ...(dispatchEnvelope ? {
        dispatchId: dispatchEnvelope.dispatch.dispatchId,
        promptReceipts: dispatchEnvelope.receipts,
      } : {}),
      ...(options.executionProfile ? { executionProfile: options.executionProfile } : {}),
      ...(seat ? { seat } : {}),
    };
    ({ operation, lane } = reserveSpawn(options.repoRoot, {
      operation: {
        operationId,
        type: 'spawn',
        laneId,
        details: operationDetails,
      },
      lane: {
        laneId,
        backend: 'codex-app-server',
        target: 'codex',
        displayName: options.name,
        state: 'planned',
        operationId,
        ...(options.lineage ? { lineage: options.lineage } : {}),
        ...(options.executionProfile ? { executionProfile: options.executionProfile } : {}),
        seat,
        ...(seatIntent ? { seatIntent } : {}),
        runtime: { endpoint },
        capabilities: {
          midTurnSteer: true,
          interrupt: true,
          retirement: 'archive',
          recovery: 'reconcile',
          approvalRelay: false,
        },
        visibility,
      },
    }, env));
    if (options.dispatch) markDispatchJournaled(options.dispatch.dispatchId, env);
    if (seatIntent) {
      seat = materializeManagedSeat(options.repoRoot, seatIntent);
      lane = bindLaneSeat(options.repoRoot, laneId, operationId, seat, env);
      operation = pendingOperationForLane(options.repoRoot, laneId, env);
    }
    return await withClient(options, async (client, initialized) => {
      if (options.onNotification) client.on('notification', options.onNotification);
      if (options.executionProfile) {
        const currentModelList = await readModelCatalog(client);
        const currentCatalogSha256 = crypto.createHash('sha256')
          .update(stableStringify(currentModelList)).digest('hex');
        if (currentCatalogSha256 !== options.executionProfile.resolved.catalogSource.catalogSha256 ||
            initialized.userAgent !== options.executionProfile.resolved.catalogSource.userAgent) {
          throw new TransmogrifyError(
            'EXECUTION_PROFILE_UNSUPPORTED',
            'Codex model capabilities changed between resolution and launch',
          );
        }
      }
      operation = updatePendingLaneOperation(options.repoRoot, laneId, operationId, {
        state: 'providerRequestDispatched',
        details: {
          ...operation.details,
          providerDispatchStartedAt: new Date().toISOString(),
        },
      }, env);
      providerRequestDispatched = true;
      const resolvedModel = options.executionProfile?.resolved.model.selector;
      const resolvedEffort = options.executionProfile?.resolved.effort.level;
      const resolvedControl = options.executionProfile?.resolved.speed.nativeControl;
      if (resolvedControl && (resolvedControl.kind !== 'service-tier' ||
          !['default', 'priority'].includes(resolvedControl.value))) {
        throw new TransmogrifyError(
          'EXECUTION_PROFILE_UNSUPPORTED', 'Codex profile has an invalid service-tier control',
        );
      }
      const resolvedTier = resolvedControl?.value;
      const started = await client.call('thread/start', {
        cwd: seat.path,
        approvalPolicy: options.approvalPolicy || 'never',
        sandbox: options.sandbox || 'workspace-write',
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(resolvedTier ? { serviceTier: resolvedTier } : {}),
      });
      const threadId = started?.thread?.id;
      if (!threadId) {
        throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/start response did not include thread.id');
      }
      providerId = threadId;
      operation = updatePendingLaneOperation(options.repoRoot, laneId, operationId, {
        state: 'providerCreated',
        providerId: threadId,
        details: {
          ...operation.details,
          providerObservedAt: new Date().toISOString(),
        },
      }, env);
      lane = bindLaneProvider(options.repoRoot, laneId, threadId, {
        state: 'created',
        runtime: client.runtimeIdentity,
        ownership: {
          creationReceipt: {
            providerId: threadId,
            requestedCwd: seat.path,
            responseCwd: typeof started.cwd === 'string' ? started.cwd : null,
            cwd: typeof started.thread.cwd === 'string' ? started.thread.cwd : null,
            initializedUserAgent: initialized.userAgent,
            createdAt: new Date().toISOString(),
          },
        },
      }, env);

      try {
        assertProviderSeat(lane, started.thread, started.cwd, 'thread/start', true);
        if (resolvedTier && started.serviceTier !== null && started.serviceTier !== undefined &&
            started.serviceTier !== resolvedTier) {
          throw new TransmogrifyError(
            'EXECUTION_PROFILE_UNSUPPORTED',
            'thread/start reported a service tier that contradicts the resolved profile',
          );
        }
      } catch (error) {
        updatePendingLaneOperation(options.repoRoot, laneId, operationId, {
          state: 'partial',
          details: {
            ...operation.details,
            seatVerificationFailedAt: new Date().toISOString(),
            causeCode: error.code || 'PROTOCOL_ERROR',
          },
        }, env);
        lane = updateLane(options.repoRoot, laneId, { state: 'deliveryUnknown' }, env);
        throw new TransmogrifyError(
          'PARTIAL_SUCCESS',
          'thread was created but a provider postcondition failed',
          {
            laneId,
            providerId: threadId,
            providerMutation: 'createdNoTurn',
            causeCode: error.code || 'PROTOCOL_ERROR',
          },
        );
      }

      let observedExecutionProfile = null;
      if (options.executionProfile) {
        const observedTier = ['default', 'priority'].includes(started.serviceTier)
          ? started.serviceTier : null;
        observedExecutionProfile = withObservedExecution(options.executionProfile, {
          model: typeof started.model === 'string' ? started.model : null,
          effort: null,
          speed: observedTier === 'priority' ? 'fast' : observedTier === 'default' ? 'standard' : null,
          nativeControl: observedTier === null ? null : {
            kind: 'service-tier', value: observedTier,
          },
          receipt: { method: 'thread/start', userAgent: initialized.userAgent },
        });
        if (options.dispatch) {
          setObservedProfile(options.dispatch.dispatchId, observedExecutionProfile.observed, env);
        }
      }

      const completion = options.waitForCompletion
        ? client.waitForNotification(
          'turn/completed',
          (params) => params.threadId === threadId,
          options.maxExecutionMs ?? 2_147_483_647,
        )
        : null;
      // A later fail-closed receipt or naming error closes the client before this
      // promise is awaited. Attach a rejection handler immediately so that close
      // cannot become an unhandled rejection; awaiting the original promise below
      // still preserves the same error when this path reaches completion.
      if (completion) completion.catch(() => {});
      operation = updatePendingLaneOperation(options.repoRoot, laneId, operationId, {
        state: 'turnRequestDispatched',
        details: {
          ...operation.details,
          turnDispatchStartedAt: new Date().toISOString(),
        },
      }, env);
      const turnStarted = await client.call('turn/start', {
        threadId,
        cwd: seat.path,
        input: [{ type: 'text', text: options.input }],
        clientUserMessageId: operationId,
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(resolvedEffort ? { effort: resolvedEffort } : {}),
        ...(resolvedTier ? { serviceTier: resolvedTier } : {}),
        ...(resolvedTier ? { serviceTierForTurn: resolvedTier } : {}),
      }, options.turnStartTimeoutMs ?? 30000);
      const turn = turnStarted?.turn;
      const inputReceiptSource = await verifiedUserMessageTurnReceipt(
        client,
        threadId,
        turn,
        operationId,
        operation.details.inputSha256,
        receiptVerification,
      );
      lane = updateLane(options.repoRoot, laneId, {
        state: 'materialized',
        turnId: turn.id,
        lastVerifiedAt: new Date().toISOString(),
      }, env);
      operation = updatePendingLaneOperation(options.repoRoot, laneId, operationId, {
        state: 'materialized',
        details: { ...operation.details, turnId: turn.id },
      }, env);

      let observedStatus;
      try {
        await client.call('thread/name/set', { threadId, name: options.name });
        const read = await client.call('thread/read', { threadId, includeTurns: false });
        assertProviderSeat(lane, read?.thread, undefined, 'thread/read');
        if (read.thread.id !== threadId || read.thread.name !== options.name ||
            !['active', 'idle', 'notLoaded', 'systemError'].includes(read.thread.status?.type)) {
          throw new TransmogrifyError('PROTOCOL_ERROR', 'thread name read-back did not match', {
            expected: options.name,
            actual: read?.thread?.name,
          });
        }
        try { observedStatus = normalizeThreadStatus(read.thread.status); } catch {
          throw new TransmogrifyError('PROTOCOL_ERROR', 'thread name read-back returned invalid status');
        }
      } catch (error) {
        updatePendingLaneOperation(options.repoRoot, laneId, operationId, {
          state: 'partial',
          details: {
            ...operation.details,
            verificationFailedAt: new Date().toISOString(),
            causeCode: error.code || 'PROTOCOL_ERROR',
          },
        }, env);
        if (error.details?.providerSeatVerification) {
          lane = updateLane(options.repoRoot, laneId, { state: 'deliveryUnknown' }, env);
        }
        throw new TransmogrifyError('PARTIAL_SUCCESS', `turn started but postcondition verification failed: ${error.message}`, {
          laneId,
          providerId: threadId,
          turnId: turn.id,
          causeCode: error.code || 'PROTOCOL_ERROR',
        });
      }

      lane = updateLane(options.repoRoot, laneId, {
        state: observedStatus.type === 'active'
          ? 'active'
          : observedStatus.type === 'systemError' ? 'failed' : 'idle',
        providerState: observedStatus,
        lastVerifiedAt: new Date().toISOString(),
      }, env);
      completeLaneOperation(options.repoRoot, laneId, operationId, { state: 'complete' }, env);
      spawnVerified = true;
      if (options.dispatch) {
        try {
          recordEvent({
            dispatchId: options.dispatch.dispatchId,
            type: 'child.spawned',
            fingerprint: `spawn-complete:${operationId}:${threadId}`,
            data: { state: 'spawned' },
          }, env);
        } catch (error) {
          // The provider effect is verified and journaled; only the durable
          // parent notification failed. Never project this as not attempted.
          throw new TransmogrifyError(
            'PARENT_EVENT_UNRECORDED',
            'lane launch is verified but the durable parent event could not be recorded',
            {
              laneId,
              providerId: threadId,
              providerMutation: 'verified',
              phase: 'parentEvent',
              code: error.code || 'INVALID_LOCAL_STATE',
            },
          );
        }
      }
      const launched = laneResult('spawn', lane, {
        receipt: {
          providerId: threadId,
          turnId: turn.id,
          name: options.name,
          userAgent: initialized.userAgent,
          acknowledgedBy: 'response',
          inputReceiptSource,
          ...(observedExecutionProfile ? { executionProfile: observedExecutionProfile } : {}),
        },
      });
      if (options.onLaunch) {
        try {
          await options.onLaunch(launched);
        } catch {
          throw new TransmogrifyError(
            'HOST_CALLBACK_FAILED',
            'lane launch is verified but the host launch callback failed',
            { laneId, providerMutation: 'verified', phase: 'launchCallback' },
          );
        }
      }
      if (!completion) return launched;
      let completed;
      try {
        completed = await completion;
        if (completed?.threadId !== threadId || completed.turn?.id !== turn.id ||
            !['completed', 'interrupted', 'failed'].includes(completed.turn?.status)) {
          throw new Error('mismatched completion notification');
        }
      } catch {
        throw new TransmogrifyError(
          'COMPLETION_UNKNOWN',
          'lane launch is verified but completion observation is unknown',
          { laneId, providerMutation: 'verified', phase: 'completionObservation' },
        );
      }
      lane = updateLane(options.repoRoot, laneId, {
        state: completed.turn.status === 'failed' ? 'failed' : 'idle',
        providerState: { type: completed.turn.status === 'failed' ? 'systemError' : 'idle' },
        lastVerifiedAt: new Date().toISOString(),
      }, env);
      if (options.dispatch) {
        recordObservation({
          dispatchId: options.dispatch.dispatchId,
          phase: completed.turn.status === 'failed' ? 'failed' : 'idle',
          providerFingerprint: `turn:${completed.turn.id}:${completed.turn.status}`,
          eventType: completed.turn.status === 'failed'
            ? 'child.failed' : 'child.turn-completed',
          data: { state: lane.state, status: completed.turn.status },
        }, env);
      }
      return laneResult('spawn', lane, {
        operationId: operation.operationId,
        receipt: {
          ...launched.receipt,
          completedTurnId: completed.turn.id,
          completedStatus: completed.turn.status,
        },
      });
    }, env);
  } catch (error) {
    // A partial success already journaled its exact phase. Every other failure is
    // settled here: notDelivered while the provider request was never sent, unknown
    // once it was, with the lane following the same split.
    if (error.code !== 'PARTIAL_SUCCESS') {
      try {
        if (operation && !spawnVerified) {
          const current = pendingOperationForLane(options.repoRoot, laneId, env);
          if (current) {
            if (providerRequestDispatched) {
              updatePendingLaneOperation(options.repoRoot, laneId, operationId, {
                state: 'unknown',
                ...(providerId ? { providerId } : {}),
                details: {
                  ...current.details,
                  deliveryBecameUnknownAt: new Date().toISOString(),
                },
              }, env);
            } else {
              completeLaneOperation(options.repoRoot, laneId, operationId, {
                state: 'failed',
                details: {
                  ...current.details,
                  failedBeforeProviderDispatchAt: new Date().toISOString(),
                },
              }, env);
            }
          }
        }
        if (lane && !spawnVerified) {
          lane = updateLane(options.repoRoot, laneId, {
            state: providerRequestDispatched ? 'deliveryUnknown' : 'failed',
          }, env);
        }
        // No lane was reserved: the parent's dispatch would otherwise dangle
        // with nothing to observe. Settle it so the parent is told once.
        if (!lane && dispatchEnvelope) {
          failDispatch(dispatchEnvelope.dispatch.dispatchId, 'spawn-not-registered', env);
        }
      } catch {}
    }
    throw error;
  }
}

// Seat- and runtime-verified read of one lane. It records the observed phase and
// provider status and performs no provider mutation.
async function status(options, env = process.env) {
  const lane = ownedLane(options, env, 'read');
  assertSeatIdentity(options, lane, env);
  return withClient(options, async (client, initialized) => {
    assertRuntimeIdentity(lane, client);
    const { thread, turn, phase } = await inspectThread(client, lane);
    const updated = updateLane(options.repoRoot, lane.laneId, {
      state: observedLaneState(lane, phase),
      providerState: thread.status,
      turnId: turn?.id || lane.turnId,
      lastVerifiedAt: new Date().toISOString(),
    }, env);
    return laneResult('status', updated, {
      ...phaseFields('codex', phase),
      turn: turn ? { id: turn.id, status: turn.status } : null,
      rawState: thread.status,
      receipt: { userAgent: initialized.userAgent },
    });
  }, env);
}

// Deliver a mid-turn steer against the newest turn under the lane lease. A
// newest turn that is not inProgress is NO_ACTIVE_TURN and proven not delivered.
// A transport failure journals the operation unknown, marks the lane
// delivery-unknown, and returns DELIVERY_UNCERTAIN without resending anything.
// The steer carries the operation UUID as clientUserMessageId, the same marker
// turn/start uses, so an unknown outcome can later be settled by the exact
// persisted receipt instead of staying unknown until abandoned.
async function steer(options, env = process.env) {
  if (!options.message) throw new TransmogrifyError('USAGE_ERROR', 'steer requires message');
  let lane = ownedLane(options, env, 'mutate');
  assertSeatIdentity(options, lane, env);
  const laneId = lane.laneId;
  const digest = messageDigest(options.message);
  return withLaneLease(options.repoRoot, laneId, async () => {
    lane = ownedLane({ ...options, laneId }, env, 'mutate');
    assertSeatIdentity(options, lane, env);
    let operation = pendingOperationForLane(options.repoRoot, laneId, env);
    if (operation) {
      assertPendingMutation(operation, 'steer', lane, { messageSha256: digest });
      if (operation.state !== 'planned') {
        throw new TransmogrifyError(
          'DELIVERY_UNCERTAIN',
          'prior steer delivery cannot be observed safely; refusing to replay it',
          { laneId, operationId: operation.operationId },
        );
      }
    }

    return withClient(options, async (client) => {
      assertRuntimeIdentity(lane, client);
      const { turn } = await inspectThread(client, lane);
      if (!turn || turn.status !== 'inProgress' ||
          (operation && operation.details.expectedTurnId !== turn.id)) {
        if (operation) {
          completeLaneOperation(options.repoRoot, laneId, operation.operationId, {
            state: 'notDelivered',
            details: {
              ...operation.details,
              notDeliveredObservedAt: new Date().toISOString(),
            },
          }, env);
        }
        throw new TransmogrifyError('NO_ACTIVE_TURN', 'no active turn on this lane');
      }
      if (!operation) {
        operation = beginLaneOperation(options.repoRoot, laneId, {
          type: 'steer',
          providerId: lane.providerId,
          details: {
            target: 'codex',
            expectedTurnId: turn.id,
            messageSha256: digest,
          },
        }, env);
      }
      operation = updatePendingLaneOperation(options.repoRoot, laneId, operation.operationId, {
        state: 'dispatching',
        details: { ...operation.details, dispatchStartedAt: new Date().toISOString() },
      }, env);
      let result;
      try {
        result = await client.call('turn/steer', {
          threadId: lane.providerId,
          expectedTurnId: turn.id,
          clientUserMessageId: operation.operationId,
          input: [{ type: 'text', text: options.message }],
        });
        if (!result || result.turnId !== turn.id) {
          throw new TransmogrifyError(
            'DELIVERY_UNCERTAIN',
            'turn/steer response did not match expectedTurnId',
          );
        }
      } catch (error) {
        if (error.method === 'turn/steer' && error.rpc?.code === -32600 &&
            error.rpc?.message === 'no active turn to steer') {
          completeLaneOperation(options.repoRoot, laneId, operation.operationId, {
            state: 'notDelivered',
            details: { ...operation.details, notDeliveredObservedAt: new Date().toISOString() },
          }, env);
          throw new TransmogrifyError('NO_ACTIVE_TURN', error.rpc.message);
        }
        updatePendingLaneOperation(options.repoRoot, laneId, operation.operationId, {
          state: 'unknown',
          details: { ...operation.details, deliveryBecameUnknownAt: new Date().toISOString() },
        }, env);
        markLaneDeliveryUnknown(options, lane, env);
        if (error.code === 'DELIVERY_UNCERTAIN') throw error;
        throw new TransmogrifyError(
          'DELIVERY_UNCERTAIN',
          'steer delivery outcome is unknown; reconcile before further mutation',
          { laneId, operationId: operation.operationId },
        );
      }
      completeLaneOperation(options.repoRoot, laneId, operation.operationId, { state: 'complete' }, env);
      return laneResult('steer', lane, {
        operationId: operation.operationId,
        receipt: { expectedTurnId: turn.id, turnId: result.turnId },
      });
    }, env);
  }, env);
}

// Interrupt the newest turn under the lane lease. A pending interrupt whose
// target turn is no longer active reconciles to complete from that observation;
// while the target is still active the outcome stays DELIVERY_UNCERTAIN. A
// dispatch failure is journaled unknown and never replayed.
async function interrupt(options, env = process.env) {
  let lane = ownedLane(options, env, 'mutate');
  assertSeatIdentity(options, lane, env);
  const laneId = lane.laneId;
  return withLaneLease(options.repoRoot, laneId, async () => {
    lane = ownedLane({ ...options, laneId }, env, 'mutate');
    assertSeatIdentity(options, lane, env);
    let operation = pendingOperationForLane(options.repoRoot, laneId, env);
    if (operation) assertPendingMutation(operation, 'interrupt', lane);

    return withClient(options, async (client) => {
      assertRuntimeIdentity(lane, client);
      const { turn } = await inspectThread(client, lane);
      const targetTurnId = operation?.details.turnId || turn?.id;
      const targetIsActive = Boolean(
        targetTurnId && turn?.id === targetTurnId && turn.status === 'inProgress'
      );
      if (operation && operation.state !== 'planned' && !targetIsActive) {
        const inspected = await inspectThread(client, lane);
        if (inspected.turn?.id === targetTurnId && inspected.turn.status === 'inProgress') {
          throw new TransmogrifyError(
            'DELIVERY_UNCERTAIN',
            'prior interrupt delivery remains unobservable while the target turn is active',
            { laneId, operationId: operation.operationId },
          );
        }
        lane = updateLaneFromInspection(options, lane, inspected, env);
        completeLaneOperation(options.repoRoot, laneId, operation.operationId, {
          state: 'complete',
          details: {
            ...operation.details,
            postconditionObservedAt: new Date().toISOString(),
            observedTurnId: inspected.turn?.id || null,
            observedTurnStatus: inspected.turn?.status || null,
          },
        }, env);
        return laneResult('interrupt', lane, {
          operationId: operation.operationId,
          receipt: { turnId: targetTurnId, reconciled: true },
        });
      }
      if (operation && operation.state !== 'planned') {
        throw new TransmogrifyError(
          'DELIVERY_UNCERTAIN',
          'prior interrupt delivery remains unobservable while the target turn is active',
          { laneId, operationId: operation.operationId },
        );
      }
      if (!targetIsActive) {
        if (operation) {
          completeLaneOperation(options.repoRoot, laneId, operation.operationId, {
            state: 'notDelivered',
            details: { ...operation.details, notDeliveredObservedAt: new Date().toISOString() },
          }, env);
        }
        throw new TransmogrifyError('NO_ACTIVE_TURN', 'no active turn on this lane');
      }
      if (!operation) {
        operation = beginLaneOperation(options.repoRoot, laneId, {
          type: 'interrupt',
          providerId: lane.providerId,
          details: { target: 'codex', turnId: targetTurnId },
        }, env);
      }
      operation = updatePendingLaneOperation(options.repoRoot, laneId, operation.operationId, {
        state: 'dispatching',
        details: { ...operation.details, dispatchStartedAt: new Date().toISOString() },
      }, env);
      try {
        await client.call('turn/interrupt', { threadId: lane.providerId, turnId: targetTurnId });
      } catch (error) {
        updatePendingLaneOperation(options.repoRoot, laneId, operation.operationId, {
          state: 'unknown',
          details: { ...operation.details, deliveryBecameUnknownAt: new Date().toISOString() },
        }, env);
        markLaneDeliveryUnknown(options, lane, env);
        throw new TransmogrifyError(
          'DELIVERY_UNCERTAIN',
          'interrupt delivery outcome is unknown; reconcile before further mutation',
          { laneId, operationId: operation.operationId },
        );
      }
      lane = updateLane(options.repoRoot, laneId, { state: 'interruptRequested' }, env);
      completeLaneOperation(options.repoRoot, laneId, operation.operationId, { state: 'complete' }, env);
      return laneResult('interrupt', lane, {
        operationId: operation.operationId,
        receipt: { turnId: targetTurnId },
      });
    }, env);
  }, env);
}

// Send a boundary input to an idle lane: thread/resume with the owned seat and
// resolved profile, then turn/start with a durable client message id. The resume
// and turn phases journal separately so recovery can prove which one landed.
// Anything unobservable is RECOVERY_UNCERTAIN and the input is never replayed.
async function resume(options, env = process.env) {
  if (!options.message) throw new TransmogrifyError('USAGE_ERROR', 'resume requires message');
  const receiptVerification = turnReceiptVerificationBounds(options);
  let lane = ownedLane(options, env, 'mutate');
  assertSeatIdentity(options, lane, env);
  const laneId = lane.laneId;
  const digest = messageDigest(options.message);
  return withLaneLease(options.repoRoot, laneId, async () => {
    lane = ownedLane({ ...options, laneId }, env, 'mutate');
    assertSeatIdentity(options, lane, env);
    const resolvedModel = lane.executionProfile?.resolved.model.selector;
    const resolvedEffort = lane.executionProfile?.resolved.effort.level;
    const resolvedControl = lane.executionProfile?.resolved.speed.nativeControl;
    if (resolvedControl && (resolvedControl.kind !== 'service-tier' ||
        !['default', 'priority'].includes(resolvedControl.value))) {
      throw new TransmogrifyError(
        'EXECUTION_PROFILE_UNSUPPORTED', 'Codex profile has an invalid service-tier control',
      );
    }
    const resolvedTier = resolvedControl?.value;
    let operation = pendingOperationForLane(options.repoRoot, laneId, env);
    if (operation) {
      assertPendingMutation(operation, 'resume', lane, { messageSha256: digest });
    } else if (lane.state !== 'idle') {
      throw new TransmogrifyError('INVALID_STATE', `boundary resume requires an idle lane, got ${lane.state}`);
    }

    return withClient(options, async (client) => {
      assertRuntimeIdentity(lane, client);
      const currentInspection = await inspectThread(client, lane);
      const current = currentInspection.turn;
      if (operation) {
        const baselineTurnId = operation.details.baselineTurnId;
        if (['turnDispatching', 'unknownTurn'].includes(operation.state)) {
          const recoveredTurnId = await findTurnByClientMessage(
            client,
            lane.providerId,
            operation.operationId,
            operation.details.messageSha256,
          );
          if (recoveredTurnId) {
            const inspected = await inspectThread(client, lane);
            lane = updateLaneFromInspection(options, lane, inspected, env);
            completeLaneOperation(options.repoRoot, laneId, operation.operationId, {
              state: 'complete',
              details: {
                ...operation.details,
                recoveredTurnId,
                postconditionObservedAt: new Date().toISOString(),
              },
            }, env);
            return laneResult('resume', lane, {
              operationId: operation.operationId,
              receipt: { turnId: recoveredTurnId, reconciled: true },
            });
          }
          throw new TransmogrifyError(
            'RECOVERY_UNCERTAIN',
            'prior resume input has no exact client-message receipt; refusing to replay it',
            { laneId, operationId: operation.operationId },
          );
        }
        if (operation.state === 'planned' && (current?.id || null) !== baselineTurnId) {
          completeLaneOperation(options.repoRoot, laneId, operation.operationId, {
            state: 'notDelivered',
            details: { ...operation.details, notDeliveredObservedAt: new Date().toISOString() },
          }, env);
          throw new TransmogrifyError('INVALID_STATE', 'lane history changed before resume dispatch');
        }
        if (current?.id && current.id !== baselineTurnId) {
          throw new TransmogrifyError(
            'RECOVERY_UNCERTAIN',
            'a new turn exists but cannot be attributed to the pending resume input',
            { laneId, operationId: operation.operationId },
          );
        }
        if (!['planned', 'resumeAcknowledged'].includes(operation.state)) {
          throw new TransmogrifyError(
            'RECOVERY_UNCERTAIN',
            'prior resume delivery remains unobservable; refusing to replay it',
            { laneId, operationId: operation.operationId },
          );
        }
      }
      if (current?.status === 'inProgress') {
        if (operation?.state === 'planned') {
          completeLaneOperation(options.repoRoot, laneId, operation.operationId, {
            state: 'notDelivered',
            details: { ...operation.details, notDeliveredObservedAt: new Date().toISOString() },
          }, env);
        }
        throw new TransmogrifyError('TARGET_ACTIVE', 'boundary resume requires no active newest turn');
      }
      if (!operation) {
        operation = beginLaneOperation(options.repoRoot, laneId, {
          type: 'resume',
          providerId: lane.providerId,
          details: {
            target: 'codex',
            messageSha256: digest,
            baselineTurnId: current?.id || null,
          },
        }, env);
      }

      if (operation.state === 'planned') {
        operation = updatePendingLaneOperation(options.repoRoot, laneId, operation.operationId, {
          state: 'resumeDispatching',
          details: { ...operation.details, resumeDispatchStartedAt: new Date().toISOString() },
        }, env);
        try {
          const resumed = await client.call('thread/resume', {
            threadId: lane.providerId,
            cwd: lane.seat.path,
            excludeTurns: true,
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...(resolvedTier ? { serviceTier: resolvedTier } : {}),
          });
          if (resumed?.thread?.id !== lane.providerId) {
            throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/resume response did not match lane provider id');
          }
          assertProviderSeat(lane, resumed.thread, resumed.cwd, 'thread/resume', true);
          if (resolvedTier && resumed.serviceTier !== null && resumed.serviceTier !== undefined &&
              resumed.serviceTier !== resolvedTier) {
            throw new TransmogrifyError(
              'EXECUTION_PROFILE_UNSUPPORTED',
              'thread/resume reported a service tier that contradicts the resolved profile',
            );
          }
        } catch (error) {
          updatePendingLaneOperation(options.repoRoot, laneId, operation.operationId, {
            state: 'unknownResume',
            details: {
              ...operation.details,
              deliveryBecameUnknownAt: new Date().toISOString(),
              causeCode: error.code || 'TRANSPORT_UNKNOWN',
              ...(error.details?.providerSeatVerification
                ? { providerSeatVerification: error.details.providerSeatVerification }
                : {}),
            },
          }, env);
          markLaneDeliveryUnknown(options, lane, env);
          throw new TransmogrifyError(
            'RECOVERY_UNCERTAIN',
            'thread resume outcome is unknown; refusing to replay it',
            { laneId, operationId: operation.operationId },
          );
        }
        operation = updatePendingLaneOperation(options.repoRoot, laneId, operation.operationId, {
          state: 'resumeAcknowledged',
          details: { ...operation.details, resumeAcknowledgedAt: new Date().toISOString() },
        }, env);
      }

      operation = updatePendingLaneOperation(options.repoRoot, laneId, operation.operationId, {
        state: 'turnDispatching',
        details: { ...operation.details, turnDispatchStartedAt: new Date().toISOString() },
      }, env);
      try {
        const started = await client.call('turn/start', {
          threadId: lane.providerId,
          cwd: lane.seat.path,
          input: [{ type: 'text', text: options.message }],
          clientUserMessageId: operation.operationId,
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(resolvedEffort ? { effort: resolvedEffort } : {}),
          ...(resolvedTier ? { serviceTier: resolvedTier } : {}),
          ...(resolvedTier ? { serviceTierForTurn: resolvedTier } : {}),
        }, options.turnStartTimeoutMs ?? 30000);
        const turn = started?.turn;
        const inputReceiptSource = await verifiedUserMessageTurnReceipt(
          client,
          lane.providerId,
          turn,
          operation.operationId,
          operation.details.messageSha256,
          receiptVerification,
        );
        lane = updateLane(options.repoRoot, laneId, {
          state: 'active',
          turnId: turn.id,
          lastVerifiedAt: new Date().toISOString(),
        }, env);
        completeLaneOperation(options.repoRoot, laneId, operation.operationId, {
          state: 'complete',
          details: { ...operation.details, turnId: turn.id },
        }, env);
        return laneResult('resume', lane, {
          operationId: operation.operationId,
          receipt: { turnId: turn.id, acknowledgedBy: 'response', inputReceiptSource },
        });
      } catch (error) {
        updatePendingLaneOperation(options.repoRoot, laneId, operation.operationId, {
          state: 'unknownTurn',
          details: { ...operation.details, turnDeliveryBecameUnknownAt: new Date().toISOString() },
        }, env);
        markLaneDeliveryUnknown(options, lane, env);
        throw new TransmogrifyError(
          'RECOVERY_UNCERTAIN',
          'resumed turn delivery outcome is unknown; refusing to replay it',
          { laneId, operationId: operation.operationId },
        );
      }
    }, env);
  }, env);
}

// Recovery as the lane CLI invokes it: with input it resumes the exact thread
// at a turn boundary; without input it observes and reconciles.
async function recoverLane(options, env = process.env) {
  if (options.message !== undefined) {
    const result = await resume(options, env);
    return { ...result, operation: 'recover' };
  }
  return recover(options, env);
}

module.exports = {
  TransmogrifyError,
  descriptor,
  executionCapabilities,
  interrupt,
  reconcile,
  recover: recoverLane,
  resume,
  retire,
  spawn,
  status,
  steer,
};
