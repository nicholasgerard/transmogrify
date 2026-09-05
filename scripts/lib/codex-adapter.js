'use strict';

const { commandEventResult, verifyCommandParent } = require('./state');

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
const {
  materializeManagedSeat, planManagedSeat, plannedProvisionedEntries, verifySeat,
} = require('./worktree');
const {
  prependExchangePreamble, writePacket,
} = require('./exchange');
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

// Spawn a Codex lane: validate the request, reserve the lane and its seat,
// create the thread, start the first turn, verify the name read-back, and
// journal every phase before the provider call it precedes. The phases below
// share one context so a failure at any point settles the journal and the
// lane from what was actually dispatched.
async function spawn(options, env = process.env) {
  options = validateSpawnRequest(options);
  const packet = options.input;
  const receiptVerification = turnReceiptVerificationBounds(options);
  const endpoint = validateUrl(runtimeUrl(options, env));
  const visibility = await resolveSpawnVisibility(options, endpoint, env);
  if (options.parentContext || options.executionProfile !== undefined) {
    options = { ...options, executionProfile: await resolveSpawnProfile(options, env) };
  }
  const laneId = options.laneId || crypto.randomUUID();
  const operationId = crypto.randomUUID();
  // The child's first message reads, in order: the parent's provenance box,
  // the exchange preamble, then the packet. The seat is planned first because
  // the preamble names it; the plan is reused when the lane is reserved.
  const seatPlan = planSeat(options, env, laneId);
  const exchangeInput = prependExchangePreamble(seatPlan.path, options.input);
  const dispatchEnvelope = options.parentContext ? reserveDispatch({
    parentContext: options.parentContext,
    repoRoot: options.repoRoot,
    laneId,
    targetProvider: 'codex',
    backend: 'codex-app-server',
    displayName: options.name,
    profile: options.executionProfile,
    prompt: exchangeInput,
  }, env) : null;
  options = {
    ...options,
    input: dispatchEnvelope ? dispatchEnvelope.renderedPrompt : exchangeInput,
    ...(dispatchEnvelope ? { dispatch: dispatchEnvelope.dispatch, lineage: dispatchEnvelope.lineage } : {}),
  };
  ensureRegistry(options.repoRoot, env);
  const ctx = {
    options, env, laneId, operationId, endpoint, visibility, dispatchEnvelope, receiptVerification, packet, seatPlan,
    lane: undefined, seat: undefined, operation: undefined,
    providerRequestDispatched: false, spawnVerified: false, providerId: null,
  };
  try {
    reserveSpawnLane(ctx);
    return await withClient(options, async (client, initialized) => {
      if (options.onNotification) client.on('notification', options.onNotification);
      await assertCatalogUnchanged(ctx, client, initialized);
      const controls = resolvedExecutionControls(ctx);
      const started = await startThread(ctx, client, initialized, controls);
      const observedExecutionProfile = recordObservedProfile(ctx, started, initialized);
      const completion = completionWatch(ctx, client, started.threadId);
      const first = await startFirstTurn(ctx, client, controls, started.threadId);
      const observedStatus = await verifyThreadName(ctx, client, started.threadId, first.turn);
      completeSpawn(ctx, observedStatus, started.threadId);
      const launched = laneResult('spawn', ctx.lane, {
        exchange: ctx.exchange,
        receipt: {
          providerId: started.threadId,
          turnId: first.turn.id,
          name: options.name,
          userAgent: initialized.userAgent,
          acknowledgedBy: 'response',
          inputReceiptSource: first.inputReceiptSource,
          ...(observedExecutionProfile ? { executionProfile: observedExecutionProfile } : {}),
        },
      });
      await runLaunchCallback(ctx, launched);
      if (!completion) return launched;
      return awaitFirstTurnCompletion(ctx, completion, started.threadId, first.turn, launched);
    }, env);
  } catch (error) {
    settleFailedSpawn(ctx, error);
    throw error;
  }
}

function validateSpawnRequest(options) {
  if (!options.repoRoot || !path.isAbsolute(options.repoRoot) ||
      typeof options.input !== 'string' || !options.input) {
    throw new TransmogrifyError('USAGE_ERROR', 'spawn requires absolute repoRoot, name, and input');
  }
  const nameProblem = laneNameError(options.name, 'Codex lane name');
  if (nameProblem) throw new TransmogrifyError('USAGE_ERROR', nameProblem);
  const canonical = { ...options, name: canonicalLaneName(options.name) };
  const canonicalNameProblem = ownedLaneNameError(canonical.name, 'Codex lane name');
  if (canonicalNameProblem) throw new TransmogrifyError('USAGE_ERROR', canonicalNameProblem);
  return canonical;
}

// Plan or verify the seat, reserve the lane and its spawn journal atomically,
// mark the parent's dispatch journaled, and materialize a managed seat.
// Plan or verify the seat before anything is reserved: a managed seat's intent
// (path, branch, base commit) or an external seat's verified identity.
function planSeat(options, env, laneId) {
  if (options.cwd) {
    const external = {
      ...verifySeat(options.repoRoot, options.cwd, worktreesRoot(options, env)),
      provisioned: plannedProvisionedEntries(options.repoRoot),
    };
    return { path: external.path, external, intent: null };
  }
  const intent = planManagedSeat(options.repoRoot, worktreesRoot(options, env), laneId, {
    branchName: options.branchName,
    baseRef: options.baseRef,
  });
  return { path: intent.path, external: null, intent };
}

function reserveSpawnLane(ctx) {
  const { options, env, laneId, operationId, dispatchEnvelope, seatPlan } = ctx;
  const seatIntent = seatPlan.intent;
  ctx.seat = seatPlan.external;
  const operationDetails = {
    target: 'codex',
    name: options.name,
    inputSha256: crypto.createHash('sha256').update(options.input).digest('hex'),
    ...(dispatchEnvelope ? {
      dispatchId: dispatchEnvelope.dispatch.dispatchId,
      promptReceipts: dispatchEnvelope.receipts,
    } : {}),
    ...(options.executionProfile ? { executionProfile: options.executionProfile } : {}),
    ...(ctx.seat ? { seat: ctx.seat } : {}),
  };
  ({ operation: ctx.operation, lane: ctx.lane } = reserveSpawn(options.repoRoot, {
    operation: { operationId, type: 'spawn', laneId, details: operationDetails },
    lane: {
      laneId,
      backend: 'codex-app-server',
      target: 'codex',
      displayName: options.name,
      state: 'planned',
      operationId,
      ...(options.lineage ? { lineage: options.lineage } : {}),
      ...(options.executionProfile ? { executionProfile: options.executionProfile } : {}),
      seat: ctx.seat,
      ...(seatIntent ? { seatIntent } : {}),
      runtime: { endpoint: ctx.endpoint },
      capabilities: {
        midTurnSteer: true,
        interrupt: true,
        retirement: 'archive',
        recovery: 'reconcile',
        approvalRelay: false,
      },
      visibility: ctx.visibility,
    },
  }, env));
  if (options.dispatch) markDispatchJournaled(options.dispatch.dispatchId, env);
  if (seatIntent) {
    ctx.seat = materializeManagedSeat(options.repoRoot, seatIntent);
    ctx.lane = bindLaneSeat(options.repoRoot, laneId, operationId, ctx.seat, env);
    ctx.operation = pendingOperationForLane(options.repoRoot, laneId, env);
  }
  const written = writePacket(options.repoRoot, ctx.seat, ctx.packet);
  ctx.exchange = written.exchange;
}

// A resolved execution profile was computed against one catalog; the launch
// refuses to proceed if the runtime's catalog or user agent changed since.
async function assertCatalogUnchanged(ctx, client, initialized) {
  const profile = ctx.options.executionProfile;
  if (!profile) return;
  const currentModelList = await readModelCatalog(client);
  const currentCatalogSha256 = crypto.createHash('sha256')
    .update(stableStringify(currentModelList)).digest('hex');
  if (currentCatalogSha256 !== profile.resolved.catalogSource.catalogSha256 ||
      initialized.userAgent !== profile.resolved.catalogSource.userAgent) {
    throw new TransmogrifyError(
      'EXECUTION_PROFILE_UNSUPPORTED',
      'Codex model capabilities changed between resolution and launch',
    );
  }
}

// The model, effort, and service tier the resolved profile pins, validated
// before the first provider call.
function resolvedExecutionControls(ctx) {
  const resolved = ctx.options.executionProfile?.resolved;
  const control = resolved?.speed.nativeControl;
  if (control && (control.kind !== 'service-tier' || !['default', 'priority'].includes(control.value))) {
    throw new TransmogrifyError('EXECUTION_PROFILE_UNSUPPORTED', 'Codex profile has an invalid service-tier control');
  }
  return { model: resolved?.model.selector, effort: resolved?.effort.level, tier: control?.value };
}

function journalSpawnPhase(ctx, state, details = {}, extra = {}) {
  ctx.operation = updatePendingLaneOperation(ctx.options.repoRoot, ctx.laneId, ctx.operationId, {
    expectedRevision: ctx.operation.revision ?? 0,
    state, ...extra, details: { ...ctx.operation.details, ...details },
  }, ctx.env);
}

// Create the thread at the seat, bind its id with the creation receipt, and
// verify the seat postcondition; a created thread that fails its
// postcondition is PARTIAL_SUCCESS with the lane delivery-unknown.
async function startThread(ctx, client, initialized, controls) {
  const { options, env, laneId } = ctx;
  journalSpawnPhase(ctx, 'providerRequestDispatched', { providerDispatchStartedAt: new Date().toISOString() });
  ctx.providerRequestDispatched = true;
  const started = await client.call('thread/start', {
    cwd: ctx.seat.path,
    approvalPolicy: options.approvalPolicy || 'never',
    sandbox: options.sandbox || 'workspace-write',
    ...(controls.model ? { model: controls.model } : {}),
    ...(controls.tier ? { serviceTier: controls.tier } : {}),
  });
  const threadId = started?.thread?.id;
  if (!threadId) throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/start response did not include thread.id');
  ctx.providerId = threadId;
  journalSpawnPhase(ctx, 'providerCreated', { providerObservedAt: new Date().toISOString() }, { providerId: threadId });
  ctx.lane = bindLaneProvider(options.repoRoot, laneId, threadId, {
    state: 'created',
    runtime: client.runtimeIdentity,
    ownership: {
      creationReceipt: {
        providerId: threadId,
        requestedCwd: ctx.seat.path,
        responseCwd: typeof started.cwd === 'string' ? started.cwd : null,
        cwd: typeof started.thread.cwd === 'string' ? started.thread.cwd : null,
        initializedUserAgent: initialized.userAgent,
        createdAt: new Date().toISOString(),
      },
    },
  }, env);
  try {
    assertProviderSeat(ctx.lane, started.thread, started.cwd, 'thread/start', true);
    if (controls.tier && started.serviceTier !== null && started.serviceTier !== undefined &&
        started.serviceTier !== controls.tier) {
      throw new TransmogrifyError(
        'EXECUTION_PROFILE_UNSUPPORTED',
        'thread/start reported a service tier that contradicts the resolved profile',
      );
    }
  } catch (error) {
    updatePendingLaneOperation(options.repoRoot, laneId, ctx.operationId, {
      expectedRevision: ctx.operation.revision ?? 0,
      state: 'partial',
      details: {
        ...ctx.operation.details,
        seatVerificationFailedAt: new Date().toISOString(),
        causeCode: error.code || 'PROTOCOL_ERROR',
      },
    }, env);
    ctx.lane = updateLane(options.repoRoot, laneId, { state: 'deliveryUnknown' }, env);
    throw new TransmogrifyError('PARTIAL_SUCCESS', 'thread was created but a provider postcondition failed', {
      laneId,
      providerId: threadId,
      providerMutation: 'createdNoTurn',
      causeCode: error.code || 'PROTOCOL_ERROR',
    });
  }
  return { threadId, started };
}

// What the runtime applied of the resolved profile, recorded on the dispatch.
function recordObservedProfile(ctx, { started }, initialized) {
  const { options, env } = ctx;
  if (!options.executionProfile) return null;
  const observedTier = ['default', 'priority'].includes(started.serviceTier) ? started.serviceTier : null;
  const observed = withObservedExecution(options.executionProfile, {
    model: typeof started.model === 'string' ? started.model : null,
    effort: null,
    speed: observedTier === 'priority' ? 'fast' : observedTier === 'default' ? 'standard' : null,
    nativeControl: observedTier === null ? null : { kind: 'service-tier', value: observedTier },
    receipt: { method: 'thread/start', userAgent: initialized.userAgent },
  });
  if (options.dispatch) setObservedProfile(options.dispatch.dispatchId, observed.observed, env);
  return observed;
}

// When the caller waits for the first turn, subscribe before it starts. A
// later fail-closed error closes the client before this promise is awaited;
// the rejection handler keeps that close from becoming an unhandled
// rejection while the awaited promise still carries the same error.
function completionWatch(ctx, client, threadId) {
  if (!ctx.options.waitForCompletion) return null;
  const completion = client.waitForNotification(
    'turn/completed',
    (params) => params.threadId === threadId,
    ctx.options.maxExecutionMs ?? 2_147_483_647,
  );
  completion.catch(() => {});
  return completion;
}

// Start the first turn with the lane's input and verify its input receipt.
async function startFirstTurn(ctx, client, controls, threadId) {
  const { options, env, laneId, operationId } = ctx;
  journalSpawnPhase(ctx, 'turnRequestDispatched', { turnDispatchStartedAt: new Date().toISOString() });
  const turnStarted = await client.call('turn/start', {
    threadId,
    cwd: ctx.seat.path,
    input: [{ type: 'text', text: options.input }],
    clientUserMessageId: operationId,
    ...(controls.model ? { model: controls.model } : {}),
    ...(controls.effort ? { effort: controls.effort } : {}),
    ...(controls.tier ? { serviceTier: controls.tier } : {}),
    ...(controls.tier ? { serviceTierForTurn: controls.tier } : {}),
  }, options.turnStartTimeoutMs ?? 30000);
  const turn = turnStarted?.turn;
  const inputReceiptSource = await verifiedUserMessageTurnReceipt(
    client, threadId, turn, operationId, ctx.operation.details.inputSha256, ctx.receiptVerification,
  );
  ctx.lane = updateLane(options.repoRoot, laneId, {
    state: 'materialized',
    turnId: turn.id,
    lastVerifiedAt: new Date().toISOString(),
  }, env);
  journalSpawnPhase(ctx, 'materialized', { turnId: turn.id });
  return { turn, inputReceiptSource };
}

// Name the thread and read it back at the seat; a failed read-back is
// PARTIAL_SUCCESS, and a failed seat verification leaves the lane
// delivery-unknown.
async function verifyThreadName(ctx, client, threadId, turn) {
  const { options, env, laneId, operationId } = ctx;
  try {
    await client.call('thread/name/set', { threadId, name: options.name });
    const read = await client.call('thread/read', { threadId, includeTurns: false });
    assertProviderSeat(ctx.lane, read?.thread, undefined, 'thread/read');
    if (read.thread.id !== threadId || read.thread.name !== options.name ||
        !['active', 'idle', 'notLoaded', 'systemError'].includes(read.thread.status?.type)) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread name read-back did not match', {
        expected: options.name,
        actual: read?.thread?.name,
      });
    }
    try { return normalizeThreadStatus(read.thread.status); } catch {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread name read-back returned invalid status');
    }
  } catch (error) {
    updatePendingLaneOperation(options.repoRoot, laneId, operationId, {
      expectedRevision: ctx.operation.revision ?? 0,
      state: 'partial',
      details: {
        ...ctx.operation.details,
        verificationFailedAt: new Date().toISOString(),
        causeCode: error.code || 'PROTOCOL_ERROR',
      },
    }, env);
    if (error.details?.providerSeatVerification) {
      ctx.lane = updateLane(options.repoRoot, laneId, { state: 'deliveryUnknown' }, env);
    }
    throw new TransmogrifyError('PARTIAL_SUCCESS', `turn started but postcondition verification failed: ${error.message}`, {
      laneId,
      providerId: threadId,
      turnId: turn.id,
      causeCode: error.code || 'PROTOCOL_ERROR',
    });
  }
}

// The launch is verified: settle the lane's state from the read-back, close
// the journal, and record the parent's spawned event. A verified launch whose
// event cannot be recorded is reported as such, never as not attempted.
function completeSpawn(ctx, observedStatus, threadId) {
  const { options, env, laneId, operationId } = ctx;
  ctx.lane = updateLane(options.repoRoot, laneId, {
    state: observedStatus.type === 'active' ? 'active' : observedStatus.type === 'systemError' ? 'failed' : 'idle',
    providerState: observedStatus,
    lastVerifiedAt: new Date().toISOString(),
  }, env);
  completeLaneOperation(options.repoRoot, laneId, operationId, { expectedRevision: ctx.operation.revision ?? 0, parentContext: options.parentContext, state: 'complete' }, env);
  ctx.spawnVerified = true;
  if (!options.dispatch) return;
  try {
    recordEvent({
      dispatchId: options.dispatch.dispatchId,
      type: 'child.spawned',
      fingerprint: `spawn-complete:${operationId}:${threadId}`,
      data: { state: 'spawned' },
    }, env);
  } catch (error) {
    throw new TransmogrifyError(
      'PARENT_EVENT_UNRECORDED',
      'lane launch is verified but the durable parent event could not be recorded',
      { laneId, providerId: threadId, providerMutation: 'verified', phase: 'parentEvent', code: error.code || 'INVALID_LOCAL_STATE' },
    );
  }
}

async function runLaunchCallback(ctx, launched) {
  if (!ctx.options.onLaunch) return;
  try {
    await ctx.options.onLaunch(launched);
  } catch {
    throw new TransmogrifyError(
      'HOST_CALLBACK_FAILED',
      'lane launch is verified but the host launch callback failed',
      { laneId: ctx.laneId, providerMutation: 'verified', phase: 'launchCallback' },
    );
  }
}

// Wait for the first turn to end and settle the lane and the parent's event
// from the completion notification.
async function awaitFirstTurnCompletion(ctx, completion, threadId, turn, launched) {
  const { options, env, laneId } = ctx;
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
  ctx.lane = updateLane(options.repoRoot, laneId, {
    state: completed.turn.status === 'failed' ? 'failed' : 'idle',
    providerState: { type: completed.turn.status === 'failed' ? 'systemError' : 'idle' },
    lastVerifiedAt: new Date().toISOString(),
  }, env);
  if (options.dispatch) {
    recordObservation({
      dispatchId: options.dispatch.dispatchId,
      phase: completed.turn.status === 'failed' ? 'failed' : 'idle',
      providerFingerprint: `turn:${completed.turn.id}:${completed.turn.status}`,
      eventType: completed.turn.status === 'failed' ? 'child.failed' : 'child.turn-completed',
      data: { state: ctx.lane.state, status: completed.turn.status },
    }, env);
  }
  return laneResult('spawn', ctx.lane, {
    operationId: ctx.operation.operationId,
    exchange: ctx.exchange,
    receipt: { ...launched.receipt, completedTurnId: completed.turn.id, completedStatus: completed.turn.status },
  });
}

// A partial success already journaled its exact phase. Every other failure is
// settled here: notDelivered while the provider request was never sent,
// unknown once it was, with the lane following the same split; a spawn that
// never reserved a lane settles the parent's dispatch so it cannot dangle.
function settleFailedSpawn(ctx, error) {
  if (error.code === 'PARTIAL_SUCCESS') return;
  const { options, env, laneId, operationId } = ctx;
  try {
    if (ctx.operation && !ctx.spawnVerified) {
      const current = pendingOperationForLane(options.repoRoot, laneId, env);
      if (current) {
        if (ctx.providerRequestDispatched) {
          updatePendingLaneOperation(options.repoRoot, laneId, operationId, {
            expectedRevision: current.revision ?? 0,
            state: 'unknown',
            ...(ctx.providerId ? { providerId: ctx.providerId } : {}),
            details: { ...current.details, deliveryBecameUnknownAt: new Date().toISOString() },
          }, env);
        } else {
          completeLaneOperation(options.repoRoot, laneId, operationId, {
            expectedRevision: current.revision ?? 0, parentContext: options.parentContext,
            state: 'failed',
            details: { ...current.details, failedBeforeProviderDispatchAt: new Date().toISOString() },
          }, env);
        }
      }
    }
    if (ctx.lane && !ctx.spawnVerified) {
      ctx.lane = updateLane(options.repoRoot, laneId, {
        state: ctx.providerRequestDispatched ? 'deliveryUnknown' : 'failed',
      }, env);
    }
    if (!ctx.lane && ctx.dispatchEnvelope) {
      failDispatch(ctx.dispatchEnvelope.dispatch.dispatchId, 'spawn-not-registered', env);
    }
  } catch {
    // The original failure is what the caller reports.
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
            expectedRevision: operation.revision ?? 0, parentContext: options.parentContext,
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
        expectedRevision: operation.revision ?? 0,
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
            expectedRevision: operation.revision ?? 0, parentContext: options.parentContext,
            state: 'notDelivered',
            details: { ...operation.details, notDeliveredObservedAt: new Date().toISOString() },
          }, env);
          throw new TransmogrifyError('NO_ACTIVE_TURN', error.rpc.message);
        }
        updatePendingLaneOperation(options.repoRoot, laneId, operation.operationId, {
          expectedRevision: operation.revision ?? 0,
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
      completeLaneOperation(options.repoRoot, laneId, operation.operationId, { expectedRevision: operation.revision ?? 0, parentContext: options.parentContext, state: 'complete' }, env);
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
  verifyCommandParent(options, env);
  return commandEventResult(options, await interruptOperation(options, env), env);
}

async function interruptOperation(options, env = process.env) {
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
          expectedRevision: operation.revision ?? 0, parentContext: options.parentContext,
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
            expectedRevision: operation.revision ?? 0, parentContext: options.parentContext,
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
        expectedRevision: operation.revision ?? 0,
        state: 'dispatching',
        details: { ...operation.details, dispatchStartedAt: new Date().toISOString() },
      }, env);
      try {
        await client.call('turn/interrupt', { threadId: lane.providerId, turnId: targetTurnId });
      } catch (error) {
        updatePendingLaneOperation(options.repoRoot, laneId, operation.operationId, {
          expectedRevision: operation.revision ?? 0,
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
      completeLaneOperation(options.repoRoot, laneId, operation.operationId, { expectedRevision: operation.revision ?? 0, parentContext: options.parentContext, state: 'complete' }, env);
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
  const initial = ownedLane(options, env, 'mutate');
  assertSeatIdentity(options, initial, env);
  const laneId = initial.laneId;
  return withLaneLease(options.repoRoot, laneId, async () => {
    const ctx = {
      options, env, laneId, receiptVerification, digest: messageDigest(options.message),
      lane: ownedLane({ ...options, laneId }, env, 'mutate'), operation: null,
    };
    assertSeatIdentity(options, ctx.lane, env);
    const controls = resumeControls(ctx.lane);
    ctx.operation = pendingOperationForLane(options.repoRoot, laneId, env);
    if (ctx.operation) {
      assertPendingMutation(ctx.operation, 'resume', ctx.lane, { messageSha256: ctx.digest });
    } else if (ctx.lane.state !== 'idle') {
      throw new TransmogrifyError('INVALID_STATE', `boundary resume requires an idle lane, got ${ctx.lane.state}`);
    }
    return withClient(options, async (client) => {
      assertRuntimeIdentity(ctx.lane, client);
      const current = (await inspectThread(client, ctx.lane)).turn;
      if (ctx.operation) {
        const settled = await settlePriorResume(ctx, client, current);
        if (settled) return settled;
      }
      refuseActiveTurn(ctx, current);
      if (!ctx.operation) {
        ctx.operation = beginLaneOperation(options.repoRoot, laneId, {
          type: 'resume',
          providerId: ctx.lane.providerId,
          details: { target: 'codex', messageSha256: ctx.digest, baselineTurnId: current?.id || null },
        }, env);
      }
      if (ctx.operation.state === 'planned') await dispatchThreadResume(ctx, client, controls);
      return dispatchResumedTurn(ctx, client, controls);
    }, env);
  }, env);
}

// The model, effort, and service tier the lane's pinned profile resolves to.
function resumeControls(lane) {
  const resolved = lane.executionProfile?.resolved;
  const control = resolved?.speed.nativeControl;
  if (control && (control.kind !== 'service-tier' || !['default', 'priority'].includes(control.value))) {
    throw new TransmogrifyError('EXECUTION_PROFILE_UNSUPPORTED', 'Codex profile has an invalid service-tier control');
  }
  return { model: resolved?.model.selector, effort: resolved?.effort.level, tier: control?.value };
}

function journalResumePhase(ctx, state, details = {}) {
  ctx.operation = updatePendingLaneOperation(ctx.options.repoRoot, ctx.laneId, ctx.operation.operationId, {
    expectedRevision: ctx.operation.revision ?? 0,
    state, details: { ...ctx.operation.details, ...details },
  }, ctx.env);
}

// A pending resume journal is settled from provider evidence before anything
// is sent again: a turn carrying the input's client message completes it; a
// journal that never dispatched, on a lane whose history moved, is not
// delivered; anything else that cannot be attributed stays uncertain and is
// never replayed. Returns the result for a completed prior resume, or null
// when the resume may proceed from its journaled phase.
async function settlePriorResume(ctx, client, current) {
  const { options, env, laneId, operation } = ctx;
  const uncertain = (message) => new TransmogrifyError('RECOVERY_UNCERTAIN', message, { laneId, operationId: operation.operationId });
  const baselineTurnId = operation.details.baselineTurnId;
  if (['turnDispatching', 'unknownTurn'].includes(operation.state)) {
    const recoveredTurnId = await findTurnByClientMessage(client, ctx.lane.providerId, operation.operationId, operation.details.messageSha256);
    if (!recoveredTurnId) throw uncertain('prior resume input has no exact client-message receipt; refusing to replay it');
    const inspected = await inspectThread(client, ctx.lane);
    ctx.lane = updateLaneFromInspection(options, ctx.lane, inspected, env);
    completeLaneOperation(options.repoRoot, laneId, operation.operationId, {
      expectedRevision: operation.revision ?? 0, parentContext: options.parentContext,
      state: 'complete',
      details: { ...operation.details, recoveredTurnId, postconditionObservedAt: new Date().toISOString() },
    }, env);
    return laneResult('resume', ctx.lane, {
      operationId: operation.operationId,
      receipt: { turnId: recoveredTurnId, reconciled: true },
    });
  }
  if (operation.state === 'planned' && (current?.id || null) !== baselineTurnId) {
    completeLaneOperation(options.repoRoot, laneId, operation.operationId, {
      expectedRevision: operation.revision ?? 0, parentContext: options.parentContext,
      state: 'notDelivered',
      details: { ...operation.details, notDeliveredObservedAt: new Date().toISOString() },
    }, env);
    throw new TransmogrifyError('INVALID_STATE', 'lane history changed before resume dispatch');
  }
  if (current?.id && current.id !== baselineTurnId) {
    throw uncertain('a new turn exists but cannot be attributed to the pending resume input');
  }
  if (!['planned', 'resumeAcknowledged'].includes(operation.state)) {
    throw uncertain('prior resume delivery remains unobservable; refusing to replay it');
  }
  return null;
}

// A boundary resume needs no active newest turn; a still-planned journal is
// closed as not delivered before the refusal.
function refuseActiveTurn(ctx, current) {
  if (current?.status !== 'inProgress') return;
  if (ctx.operation?.state === 'planned') {
    completeLaneOperation(ctx.options.repoRoot, ctx.laneId, ctx.operation.operationId, {
      expectedRevision: ctx.operation.revision ?? 0, parentContext: ctx.options.parentContext,
      state: 'notDelivered',
      details: { ...ctx.operation.details, notDeliveredObservedAt: new Date().toISOString() },
    }, ctx.env);
  }
  throw new TransmogrifyError('TARGET_ACTIVE', 'boundary resume requires no active newest turn');
}

// thread/resume at the owned seat, journaled as resumeDispatching before and
// resumeAcknowledged after; an unverifiable outcome leaves the journal
// unknownResume and the lane delivery-unknown.
async function dispatchThreadResume(ctx, client, controls) {
  const { options, env, laneId } = ctx;
  journalResumePhase(ctx, 'resumeDispatching', { resumeDispatchStartedAt: new Date().toISOString() });
  try {
    const resumed = await client.call('thread/resume', {
      threadId: ctx.lane.providerId,
      cwd: ctx.lane.seat.path,
      excludeTurns: true,
      ...(controls.model ? { model: controls.model } : {}),
      ...(controls.tier ? { serviceTier: controls.tier } : {}),
    });
    if (resumed?.thread?.id !== ctx.lane.providerId) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/resume response did not match lane provider id');
    }
    assertProviderSeat(ctx.lane, resumed.thread, resumed.cwd, 'thread/resume', true);
    if (controls.tier && resumed.serviceTier !== null && resumed.serviceTier !== undefined &&
        resumed.serviceTier !== controls.tier) {
      throw new TransmogrifyError(
        'EXECUTION_PROFILE_UNSUPPORTED',
        'thread/resume reported a service tier that contradicts the resolved profile',
      );
    }
  } catch (error) {
    updatePendingLaneOperation(options.repoRoot, laneId, ctx.operation.operationId, {
      expectedRevision: ctx.operation.revision ?? 0,
      state: 'unknownResume',
      details: {
        ...ctx.operation.details,
        deliveryBecameUnknownAt: new Date().toISOString(),
        causeCode: error.code || 'TRANSPORT_UNKNOWN',
        ...(error.details?.providerSeatVerification
          ? { providerSeatVerification: error.details.providerSeatVerification }
          : {}),
      },
    }, env);
    markLaneDeliveryUnknown(options, ctx.lane, env);
    throw new TransmogrifyError(
      'RECOVERY_UNCERTAIN',
      'thread resume outcome is unknown; refusing to replay it',
      { laneId, operationId: ctx.operation.operationId },
    );
  }
  journalResumePhase(ctx, 'resumeAcknowledged', { resumeAcknowledgedAt: new Date().toISOString() });
}

// turn/start with the durable client message id, verified by its input
// receipt; an unverifiable outcome leaves the journal unknownTurn.
async function dispatchResumedTurn(ctx, client, controls) {
  const { options, env, laneId } = ctx;
  journalResumePhase(ctx, 'turnDispatching', { turnDispatchStartedAt: new Date().toISOString() });
  try {
    const started = await client.call('turn/start', {
      threadId: ctx.lane.providerId,
      cwd: ctx.lane.seat.path,
      input: [{ type: 'text', text: options.message }],
      clientUserMessageId: ctx.operation.operationId,
      ...(controls.model ? { model: controls.model } : {}),
      ...(controls.effort ? { effort: controls.effort } : {}),
      ...(controls.tier ? { serviceTier: controls.tier } : {}),
      ...(controls.tier ? { serviceTierForTurn: controls.tier } : {}),
    }, options.turnStartTimeoutMs ?? 30000);
    const turn = started?.turn;
    const inputReceiptSource = await verifiedUserMessageTurnReceipt(
      client, ctx.lane.providerId, turn, ctx.operation.operationId, ctx.operation.details.messageSha256, ctx.receiptVerification,
    );
    ctx.lane = updateLane(options.repoRoot, laneId, {
      state: 'active',
      turnId: turn.id,
      lastVerifiedAt: new Date().toISOString(),
    }, env);
    completeLaneOperation(options.repoRoot, laneId, ctx.operation.operationId, {
      expectedRevision: ctx.operation.revision ?? 0, parentContext: options.parentContext,
      state: 'complete',
      details: { ...ctx.operation.details, turnId: turn.id },
    }, env);
    return laneResult('resume', ctx.lane, {
      operationId: ctx.operation.operationId,
      receipt: { turnId: turn.id, acknowledgedBy: 'response', inputReceiptSource },
    });
  } catch (error) {
    updatePendingLaneOperation(options.repoRoot, laneId, ctx.operation.operationId, {
      expectedRevision: ctx.operation.revision ?? 0,
      state: 'unknownTurn',
      details: { ...ctx.operation.details, turnDeliveryBecameUnknownAt: new Date().toISOString() },
    }, env);
    markLaneDeliveryUnknown(options, ctx.lane, env);
    throw new TransmogrifyError(
      'RECOVERY_UNCERTAIN',
      'resumed turn delivery outcome is unknown; refusing to replay it',
      { laneId, operationId: ctx.operation.operationId },
    );
  }
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
