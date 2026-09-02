'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  beginLaneOperation,
  bindLaneSeat,
  bindLaneProvider,
  completeLaneOperation,
  ensureRegistry,
  listLanes,
  listOperations,
  pendingOperationForLane,
  requireOwnedLane,
  requireOwnedProviderLane,
  settleTerminalLaneOperationPointer,
  reserveSpawn,
  updateLane,
  updateOperation,
  updatePendingLaneOperation,
  withLaneLease,
} = require('./state');
const { AppServerClient, validateUrl } = require('./app-server');
const {
  markDispatchJournaled, recordEvent, recordObservation, reserveDispatch, setObservedProfile,
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
  captureHarvestReceipt,
  isPermanentCleanupError,
  materializeManagedSeat,
  planManagedSeat,
  removeManagedSeat,
  verifyLaneSeat,
  verifySeat,
} = require('./worktree');
const {
  boundedCursor, canonicalLaneName, laneNameError, normalizeThreadStatus, ownedLaneNameError,
} = require('./validation');

const SOURCE_KINDS = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
];
const RETIRED_STATES = new Set([
  'archivedVerified', 'logicallyRetired', 'cleanupEligible', 'worktreeRemoved',
]);
const MAX_PAGINATION_PAGES = 100;
const MAX_PAGINATION_ROWS = 10_000;
const DEFAULT_INPUT_RECEIPT_VERIFY_ATTEMPTS = 100;
const DEFAULT_INPUT_RECEIPT_VERIFY_DELAY_MS = 100;

class TransmogrifyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function runtimeUrl(options, env = process.env) {
  return options.url || env.TRANSMOGRIFY_URL ||
    `ws://127.0.0.1:${env.TRANSMOGRIFY_PORT || '8843'}`;
}

function worktreesRoot(options, env = process.env) {
  return options.worktrees || env.WORKTREES || `${options.repoRoot}/.worktrees`;
}

function laneResult(operation, lane, extra = {}) {
  return {
    version: 1,
    ok: true,
    operation,
    operationId: lane.operationId || null,
    laneId: lane.laneId,
    adapter: lane.backend,
    state: lane.state,
    capabilities: lane.capabilities,
    visibility: lane.visibility,
    ...extra,
  };
}

function ownedLane(options, env, action = 'read') {
  if (options.laneId) {
    const lane = requireOwnedLane(options.repoRoot, options.laneId, env);
    if (lane.backend !== 'codex-app-server') {
      throw new TransmogrifyError('ADAPTER_MISMATCH', `lane ${lane.laneId} uses ${lane.backend}`);
    }
    if (action !== 'read' && RETIRED_STATES.has(lane.state)) {
      throw new TransmogrifyError('LANE_RETIRED', `lane ${lane.laneId} is retired`);
    }
    if (!lane.providerId) throw new TransmogrifyError('DELIVERY_UNKNOWN', `lane ${lane.laneId} has no provider id`);
    const endpoint = validateUrl(runtimeUrl(options, env));
    if (!lane.runtime?.endpoint || lane.runtime.endpoint !== endpoint) {
      throw new TransmogrifyError('RUNTIME_MISMATCH', `lane ${lane.laneId} is owned on another runtime endpoint`);
    }
    return lane;
  }
  const lane = requireOwnedProviderLane(
    options.repoRoot, 'codex-app-server', options.providerId, env,
  );
  if (action !== 'read' && RETIRED_STATES.has(lane.state)) {
    throw new TransmogrifyError('LANE_RETIRED', `lane ${lane.laneId} is retired`);
  }
  const endpoint = validateUrl(runtimeUrl(options, env));
  if (!lane.runtime?.endpoint || lane.runtime.endpoint !== endpoint) {
    throw new TransmogrifyError('RUNTIME_MISMATCH', `lane ${lane.laneId} is owned on another runtime endpoint`);
  }
  return lane;
}

function assertRuntimeIdentity(lane, client) {
  for (const key of ['endpoint', 'codexHome', 'platformFamily', 'platformOs']) {
    if (lane.runtime?.[key] !== client.runtimeIdentity?.[key]) {
      throw new TransmogrifyError('RUNTIME_MISMATCH', `lane runtime identity changed (${key})`);
    }
  }
}

function assertSeatIdentity(options, lane, env) {
  try { return verifyLaneSeat(options.repoRoot, lane.seat); } catch (error) {
    throw new TransmogrifyError('SEAT_MISMATCH', error.message);
  }
}

function assertProviderSeat(lane, thread, responseCwd, method, requireResponseCwd = false) {
  if (!thread || typeof thread !== 'object' || Array.isArray(thread) ||
      typeof thread.cwd !== 'string' ||
      ((requireResponseCwd || responseCwd !== undefined) && typeof responseCwd !== 'string')) {
    throw new TransmogrifyError(
      'PROTOCOL_ERROR',
      `${method} response omitted required provider cwd metadata`,
      { providerSeatVerification: 'malformed' },
    );
  }
  if (thread.cwd !== lane.seat?.path ||
      ((requireResponseCwd || responseCwd !== undefined) && responseCwd !== lane.seat?.path)) {
    throw new TransmogrifyError(
      'OWNERSHIP_MISMATCH',
      `${method} provider cwd does not match the exact reserved seat`,
      { providerSeatVerification: 'mismatch' },
    );
  }
  return thread;
}

function turnReceiptVerificationBounds(options) {
  const attempts = options.inputReceiptVerifyAttempts ?? DEFAULT_INPUT_RECEIPT_VERIFY_ATTEMPTS;
  const delayMs = options.inputReceiptVerifyDelayMs ?? DEFAULT_INPUT_RECEIPT_VERIFY_DELAY_MS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 100 ||
      !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 1000) {
    throw new TransmogrifyError('USAGE_ERROR', 'invalid turn input receipt verification bounds');
  }
  return { attempts, delayMs };
}

async function withClient(options, callback, env = process.env) {
  const client = new AppServerClient({
    url: runtimeUrl(options, env),
    timeoutMs: options.timeoutMs ?? 20000,
    clientInfo: {
      name: 'transmogrify',
      title: 'transmogrify',
      version: '0.2.0',
    },
    serverRequestHandler: options.serverRequestHandler,
  });
  try {
    const initialized = await client.connect();
    if (!client.verifiedRuntime) {
      throw new TransmogrifyError('UNVERIFIED_RUNTIME', `unsupported Codex app-server ${initialized.userAgent}`);
    }
    return await callback(client, initialized);
  } finally {
    client.close();
  }
}

async function readModelCatalog(client) {
  const data = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
    const response = await client.call('model/list', {
      cursor,
      includeHidden: true,
      limit: 100,
    });
    if (!response || !Array.isArray(response.data)) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'model/list response did not include data');
    }
    data.push(...response.data);
    if (data.length > MAX_PAGINATION_ROWS) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'model/list exceeded the bounded catalog size');
    }
    if (response.nextCursor === null || response.nextCursor === undefined) {
      return { data, nextCursor: null };
    }
    if (typeof response.nextCursor !== 'string' || !response.nextCursor ||
        seenCursors.has(response.nextCursor)) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'model/list returned an invalid pagination cursor');
    }
    seenCursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new TransmogrifyError('PROTOCOL_ERROR', 'model/list exceeded the bounded page count');
}

function executionRequest(options) {
  return Object.fromEntries([
    ['intent', options.intent],
    ['model', options.model],
    ['effort', options.effort],
    ['speed', options.speed],
  ].filter(([, value]) => value !== undefined));
}

function profileFailure(error) {
  if (!(error instanceof ExecutionProfileError)) throw error;
  throw new TransmogrifyError('EXECUTION_PROFILE_UNSUPPORTED', error.message, {
    profileCode: error.code,
  });
}

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
  if (options.allowProtocolOnly !== true) {
    throw new TransmogrifyError(
      'NATIVE_VISIBILITY_REQUIRED',
      'Codex spawn requires an app-visibility receipt; use --allow-protocol-only only for an explicitly non-native lane',
    );
  }
  if (options.parentContext || options.executionProfile !== undefined) {
    options = { ...options, executionProfile: await resolveSpawnProfile(options, env) };
  }
  const laneId = options.laneId || crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const endpoint = validateUrl(runtimeUrl(options, env));
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
        visibility: {
          surface: 'codex',
          state: 'protocolOnlyByOwnerOverride',
        },
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
        recordEvent({
          dispatchId: options.dispatch.dispatchId,
          type: 'child.spawned',
          fingerprint: `spawn-complete:${operationId}:${threadId}`,
          data: { state: 'spawned' },
        }, env);
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
      } catch {}
    }
    throw error;
  }
}

async function newestTurn(client, threadId) {
  try {
    const turns = await client.call('thread/turns/list', {
      threadId,
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    });
    if (!turns || !Array.isArray(turns.data)) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/turns/list response did not include data[]');
    }
    const turn = turns.data[0] || null;
    if (turn && (typeof turn.id !== 'string' ||
        !['completed', 'interrupted', 'failed', 'inProgress'].includes(turn.status) ||
        !Array.isArray(turn.items))) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/turns/list returned an invalid newest turn');
    }
    return turn;
  } catch (error) {
    if (error.rpc?.code === -32600 && /not materialized yet/i.test(error.rpc?.message || '')) return null;
    throw error;
  }
}

function userMessageTurnReceipt(turn, clientUserMessageId, inputSha256) {
  if (!turn || typeof turn.id !== 'string' || !Array.isArray(turn.items)) {
    throw new TransmogrifyError('PROTOCOL_ERROR', 'turn receipt is missing its item list');
  }
  const matches = turn.items.filter((item) =>
    item?.type === 'userMessage' && item.clientId === clientUserMessageId
  );
  if (matches.length !== 1) {
    throw new TransmogrifyError('PROTOCOL_ERROR', 'turn receipt did not contain one exact client message id');
  }
  const content = matches[0].content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' ||
      typeof content[0].text !== 'string' || messageDigest(content[0].text) !== inputSha256) {
    throw new TransmogrifyError('PROTOCOL_ERROR', 'turn receipt did not match the dispatched input');
  }
  return turn.id;
}

async function verifiedUserMessageTurnReceipt(
  client,
  threadId,
  turn,
  clientUserMessageId,
  inputSha256,
  options = {},
) {
  if (!turn || typeof turn.id !== 'string' || !Array.isArray(turn.items)) {
    throw new TransmogrifyError('PROTOCOL_ERROR', 'turn receipt is missing its item list');
  }
  const responseMatches = turn.items.filter((item) =>
    item?.type === 'userMessage' && item.clientId === clientUserMessageId
  );
  if (responseMatches.length > 0) {
    userMessageTurnReceipt(turn, clientUserMessageId, inputSha256);
    return 'turnStartResponse';
  }

  const { attempts, delayMs } = options;
  const aggregateBudget = {
    pagesRemaining: MAX_PAGINATION_PAGES,
    rowsRemaining: MAX_PAGINATION_ROWS,
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let persistedTurnId = null;
    try {
      persistedTurnId = await findTurnByClientMessage(
        client,
        threadId,
        clientUserMessageId,
        inputSha256,
        aggregateBudget,
      );
    } catch (error) {
      const transientUnmaterializedList = error.code === 'RPC_ERROR' &&
        error.method === 'thread/items/list' &&
        /^thread\/items\/list is not supported yet$/i.test(error.rpc?.message || '');
      if (!transientUnmaterializedList) throw error;
    }
    if (persistedTurnId !== null) {
      if (persistedTurnId !== turn.id) {
        throw new TransmogrifyError(
          'PROTOCOL_ERROR',
          'persisted turn input receipt did not match turn/start response',
        );
      }
      return 'threadItemsList';
    }
    if (attempt + 1 < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new TransmogrifyError('PROTOCOL_ERROR', 'turn receipt did not contain one exact client message id');
}

async function findTurnByClientMessage(
  client,
  threadId,
  clientUserMessageId,
  inputSha256,
  aggregateBudget = null,
) {
  let cursor = null;
  const seen = new Set();
  let matchedTurnId = null;
  let matchedEntries = 0;
  const budget = aggregateBudget || {
    pagesRemaining: MAX_PAGINATION_PAGES,
    rowsRemaining: MAX_PAGINATION_ROWS,
  };
  do {
    if (budget.pagesRemaining < 1) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/items/list exceeded the aggregate page bound');
    }
    budget.pagesRemaining -= 1;
    const page = await client.call('thread/items/list', {
      threadId,
      cursor,
      limit: 100,
      sortDirection: 'desc',
    });
    if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.data)) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/items/list response did not include data[]');
    }
    if (page.data.length > budget.rowsRemaining) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/items/list exceeded the aggregate row bound');
    }
    budget.rowsRemaining -= page.data.length;
    for (const entry of page.data) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          typeof entry.turnId !== 'string' || !entry.item ||
          typeof entry.item !== 'object' || Array.isArray(entry.item)) {
        throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/items/list returned an invalid entry');
      }
      if (entry.item.type !== 'userMessage' || entry.item.clientId !== clientUserMessageId) continue;
      matchedEntries += 1;
      if (matchedEntries > 1) {
        throw new TransmogrifyError('PROTOCOL_ERROR', 'client message id appeared more than once');
      }
      const observedTurnId = userMessageTurnReceipt({ id: entry.turnId, items: [entry.item] },
        clientUserMessageId, inputSha256);
      if (matchedTurnId && matchedTurnId !== observedTurnId) {
        throw new TransmogrifyError('PROTOCOL_ERROR', 'client message id appeared in multiple turns');
      }
      matchedTurnId = observedTurnId;
    }
    const next = boundedCursor(page.nextCursor, 'thread/items/list nextCursor');
    if (next !== null && seen.has(next)) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/items/list cursor cycle');
    }
    if (next !== null) seen.add(next);
    cursor = next;
  } while (cursor !== null);
  return matchedTurnId;
}

function phaseFor(thread, turn) {
  if (turn?.status === 'inProgress') return 'executing';
  if (turn?.status === 'failed' || thread.status.type === 'systemError') return 'failed';
  if (turn?.status === 'interrupted') return 'interrupted';
  if (turn?.status === 'completed' || thread.status.type === 'idle') return 'idle';
  if (thread.status.type === 'notLoaded') return 'notLoaded';
  if (thread.status.type === 'active') return 'executing';
  return 'unknown';
}

async function inspectThread(client, lane) {
  const read = await client.call('thread/read', {
    threadId: lane.providerId,
    includeTurns: false,
  });
  if (!read?.thread || read.thread.id !== lane.providerId) {
    throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/read returned an invalid thread');
  }
  assertProviderSeat(lane, read.thread, undefined, 'thread/read');
  let status;
  try { status = normalizeThreadStatus(read.thread.status); } catch {
    throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/read returned an invalid thread status');
  }
  const turn = await newestTurn(client, lane.providerId);
  const thread = { ...read.thread, status };
  return { thread, turn, phase: phaseFor(thread, turn) };
}

function observedLaneState(lane, phase) {
  if (RETIRED_STATES.has(lane.state) || ['retireRequested', 'archiveUnknown'].includes(lane.state)) {
    return lane.state;
  }
  if (phase === 'executing') return 'active';
  if (phase === 'failed') return 'failed';
  if (['idle', 'interrupted', 'notLoaded'].includes(phase)) return 'idle';
  return lane.state;
}

function messageDigest(message) {
  return crypto.createHash('sha256').update(message).digest('hex');
}

function assertPendingMutation(operation, type, lane, details = {}) {
  if (operation.type !== type) {
    throw new TransmogrifyError(
      'OPERATION_PENDING',
      `lane ${lane.laneId} already has pending ${operation.type} operation ${operation.operationId}`,
    );
  }
  for (const [key, value] of Object.entries(details)) {
    if (operation.details[key] !== value) {
      throw new TransmogrifyError(
        'OPERATION_PENDING',
        `pending ${type} operation ${operation.operationId} does not match this request`,
      );
    }
  }
  return operation;
}

function markLaneDeliveryUnknown(options, lane, env) {
  if (lane.state === 'failed') return lane;
  return updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
}

function updateLaneFromInspection(options, lane, inspected, env) {
  const state = observedLaneState(lane, inspected.phase);
  if (lane.state === 'interruptRequested' && state === 'active') {
    lane = updateLane(options.repoRoot, lane.laneId, { state: 'idle' }, env);
  }
  return updateLane(options.repoRoot, lane.laneId, {
    state,
    providerState: inspected.thread.status,
    turnId: inspected.turn?.id || lane.turnId,
    lastVerifiedAt: new Date().toISOString(),
  }, env);
}

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
      phase,
      turn: turn ? { id: turn.id, status: turn.status } : null,
      rawState: thread.status,
      receipt: { userAgent: initialized.userAgent },
    });
  }, env);
}

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
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

function requireHarvestedOutputSha256(options) {
  if (!/^[0-9a-f]{64}$/.test(options.harvestedOutputSha256 || '')) {
    throw new TransmogrifyError(
      'USAGE_ERROR',
      'retire requires --harvested-output-sha256 as a lowercase SHA-256 receipt',
    );
  }
  return options.harvestedOutputSha256;
}

function retirementHarvestReceipt(operation) {
  const receipt = operation?.details?.harvestReceipt;
  if (!receipt || !/^[0-9a-f]{64}$/.test(receipt.outputSha256 || '')) {
    throw new TransmogrifyError('HARVEST_REQUIRED', 'retirement operation has no durable harvest receipt');
  }
  return receipt;
}

function prepareRetirementOperation(options, lane, env) {
  const pending = pendingOperationForLane(options.repoRoot, lane.laneId, env);
  if (pending) {
    if (pending.type !== 'retire') {
      throw new TransmogrifyError(
        'OPERATION_PENDING',
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
  if (operation.details.cleanupBlocked === true ||
      operation.state === 'providerRetiredCleanupBlocked') {
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

async function retire(options, env = process.env) {
  let lane = ownedLane(options, env, 'read');
  const existingRetirement = pendingOperationForLane(options.repoRoot, lane.laneId, env);
  if (lane.state === 'worktreeRemoved' && !existingRetirement) {
    return laneResult('retire', lane, {
      receipt: {
        archived: true,
        alreadyRetired: true,
        worktreeRemoved: true,
      },
    });
  }
  return withLaneLease(options.repoRoot, lane.laneId, async () => {
    lane = ownedLane({ ...options, laneId: lane.laneId }, env, 'read');
    const pending = pendingOperationForLane(options.repoRoot, lane.laneId, env);
    if (lane.state === 'worktreeRemoved' && !pending) {
      return laneResult('retire', lane, {
        receipt: { archived: true, alreadyRetired: true, worktreeRemoved: true },
      });
    }
    const recoveringRemovedSeat = lane.state === 'worktreeRemoved' &&
      pending?.type === 'retire' && lane.seat?.managed === true;
    if (!recoveringRemovedSeat) assertSeatIdentity(options, lane, env);
    const prepared = prepareRetirementOperation(options, lane, env);
    let operation = prepared.operation;
    const { harvestReceipt } = prepared;

    if (lane.state === 'worktreeRemoved') {
      completeLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
        state: 'complete',
      }, env);
      return laneResult('retire', lane, {
        operationId: operation.operationId,
        receipt: {
          archived: true,
          alreadyRetired: true,
          worktreeRemoved: true,
          harvestedOutputSha256: harvestReceipt.outputSha256,
        },
      });
    }

    if (lane.state === 'archivedVerified') {
      lane = finishRetiredCleanup(options, lane, operation, harvestReceipt, env);
      return laneResult('retire', lane, {
        operationId: operation.operationId,
        receipt: {
          archived: true,
          alreadyRetired: true,
          worktreeRemoved: lane.state === 'worktreeRemoved',
          harvestedOutputSha256: harvestReceipt.outputSha256,
        },
      });
    }

    return withClient(options, async (client) => {
      assertRuntimeIdentity(lane, client);
      let reconciled = false;
      if (lane.state === 'retireRequested' || lane.state === 'archiveUnknown') {
        reconciled = await verifyArchived(client, lane, options);
        if (!reconciled) {
          updatePendingLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
            state: 'unknown',
          }, env);
          throw new TransmogrifyError('DELIVERY_UNKNOWN', 'prior archive delivery remains unverified');
        }
      } else {
        let turn;
        try {
          ({ turn } = await inspectThread(client, lane));
        } catch (error) {
          completeLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
            state: 'notDelivered',
            details: {
              ...operation.details,
              failedBeforeProviderDispatchAt: new Date().toISOString(),
            },
          }, env);
          throw error;
        }
        if (turn?.status === 'inProgress') {
          completeLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
            state: 'notDelivered',
          }, env);
          throw new TransmogrifyError('TARGET_ACTIVE', 'refusing to retire a lane with an active newest turn');
        }
        lane = updateLane(options.repoRoot, lane.laneId, { state: 'retireRequested' }, env);
        operation = updatePendingLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
          state: 'providerRequestDispatched',
        }, env);
        try {
          await client.call('thread/archive', { threadId: lane.providerId });
          operation = updatePendingLaneOperation(
            options.repoRoot,
            lane.laneId,
            operation.operationId,
            { state: 'providerAcknowledged' },
            env,
          );
        } catch (error) {
          lane = updateLane(options.repoRoot, lane.laneId, { state: 'archiveUnknown' }, env);
          updatePendingLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
            state: 'unknown',
            details: {
              ...operation.details,
              archiveFailurePhase: 'dispatch',
              causeCode: error.code || 'TRANSPORT_UNKNOWN',
              archiveDeliveryBecameUnknownAt: new Date().toISOString(),
            },
          }, env);
          throw error;
        }
        try {
          reconciled = await verifyArchived(client, lane, options);
        } catch (error) {
          lane = updateLane(options.repoRoot, lane.laneId, { state: 'archiveUnknown' }, env);
          updatePendingLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
            state: 'unknown',
            details: {
              ...operation.details,
              archiveFailurePhase: 'verification',
              causeCode: error.code || 'TRANSPORT_UNKNOWN',
              archiveDeliveryBecameUnknownAt: new Date().toISOString(),
            },
          }, env);
          throw error;
        }
        if (!reconciled) {
          lane = updateLane(options.repoRoot, lane.laneId, { state: 'archiveUnknown' }, env);
          updatePendingLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
            state: 'unknown',
            details: {
              ...operation.details,
              archiveFailurePhase: 'not-observed',
              causeCode: 'TRANSPORT_UNKNOWN',
              archiveDeliveryBecameUnknownAt: new Date().toISOString(),
            },
          }, env);
          throw new TransmogrifyError(
            'TRANSPORT_UNKNOWN',
            'archive was acknowledged but not verified in archived listing',
            { laneId: lane.laneId, providerId: lane.providerId },
          );
        }
      }
      lane = updateLane(options.repoRoot, lane.laneId, {
        state: 'archivedVerified',
        lastVerifiedAt: new Date().toISOString(),
      }, env);
      operation = updatePendingLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
        state: 'providerRetired',
      }, env);
      lane = finishRetiredCleanup(options, lane, operation, harvestReceipt, env);
      return laneResult('retire', lane, {
        operationId: operation.operationId,
        receipt: {
          archived: true,
          reconciled,
          worktreeRemoved: lane.state === 'worktreeRemoved',
          harvestedOutputSha256: harvestReceipt.outputSha256,
        },
      });
    }, env);
  }, env);
}

async function repairLocalRecoveryState(options, initial, operations, env) {
  return withLaneLease(options.repoRoot, initial.laneId, async () => {
    let lane = requireOwnedLane(options.repoRoot, initial.laneId, env);
    const pending = pendingOperationForLane(options.repoRoot, lane.laneId, env);
    const recorded = pending || operations.get(lane.operationId);
    const repaired = [];
    if (pending?.type === 'spawn' && ['planned', 'seatReady'].includes(pending.state) &&
        ['planned', 'failed'].includes(lane.state) && !lane.providerId) {
      if (lane.state === 'planned') {
        lane = updateLane(options.repoRoot, lane.laneId, { state: 'failed' }, env);
        repaired.push('unstartedSpawnState');
      }
      completeLaneOperation(options.repoRoot, lane.laneId, pending.operationId, {
        state: 'notDelivered',
        details: {
          ...pending.details,
          notDeliveredObservedAt: new Date().toISOString(),
        },
      }, env);
      repaired.push('unstartedSpawnOperation');
    }
    if (recorded?.type === 'spawn' && ['failed', 'notDelivered'].includes(recorded.state) &&
        lane.state === 'planned' && !lane.providerId) {
      lane = updateLane(options.repoRoot, lane.laneId, { state: 'failed' }, env);
      repaired.push('failedSpawnState');
    }
    const settled = settleTerminalLaneOperationPointer(options.repoRoot, lane.laneId, env);
    if (settled) repaired.push('terminalOperationPointer');
    const failedSpawnTerminal = recorded?.type === 'spawn' &&
      ['failed', 'notDelivered'].includes(recorded.state) &&
      lane.state === 'failed' && !lane.providerId;
    if (settled || repaired.length > 0 || failedSpawnTerminal) {
      lane = requireOwnedLane(options.repoRoot, lane.laneId, env);
      const terminalState = settled?.state || recorded?.state;
      return {
        laneId: lane.laneId,
        providerId: lane.providerId || null,
        state: lane.state,
        delivery: terminalState === 'complete' ? 'confirmed' : 'notDelivered',
        repaired,
      };
    }
    if (lane.state === 'worktreeRemoved') {
      return {
        laneId: lane.laneId,
        providerId: lane.providerId,
        state: lane.state,
        delivery: 'confirmed',
        repaired: [],
      };
    }
    return null;
  }, env);
}

function remainingRecoveryMs(deadline) {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < 1) {
    throw new TransmogrifyError('TIMEOUT', 'Codex recovery exceeded its aggregate deadline');
  }
  return remaining;
}

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
    if (exact.runtime?.endpoint !== endpoint) {
      throw new TransmogrifyError('RUNTIME_MISMATCH', `lane ${exact.laneId} is owned on another runtime endpoint`);
    }
    lanes = [exact];
  } else {
    lanes = listLanes(options.repoRoot, env).filter((lane) =>
      lane.backend === 'codex-app-server'
    );
  }
  const operations = new Map(listOperations(options.repoRoot, env).map((entry) => [entry.operationId, entry]));
  const localResults = [];
  const providerLanes = [];
  for (const initial of lanes) {
    if (initial.runtime?.endpoint !== endpoint) {
      localResults.push({
        laneId: initial.laneId,
        providerId: initial.providerId,
        skipped: 'differentRuntime',
      });
      continue;
    }
    const repaired = await repairLocalRecoveryState(options, initial, operations, env);
    if (repaired) localResults.push(repaired);
    else providerLanes.push(initial);
  }
  if (providerLanes.length === 0) {
    return {
      version: 1,
      ok: localResults.every((entry) => !entry.error && !entry.skipped &&
        entry.delivery !== 'unknown'),
      operation: 'recover',
      adapter: 'codex-app-server',
      recovered: localResults,
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
                delivery: 'unknown',
                repaired: [],
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
              delivery: 'confirmed',
              repaired,
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
                delivery: 'unknown',
                repaired: [],
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
              delivery: 'confirmed',
              repaired,
            };
          }
          if (operation?.type === 'retire') {
            return {
              laneId: lane.laneId,
              providerId: lane.providerId,
              state: lane.state,
              delivery: 'unknown',
              pendingOperation: 'retire',
              repaired: [],
            };
          }

          if (pending && ['steer', 'interrupt', 'resume'].includes(pending.type)) {
            if (pending.state === 'planned') {
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
                delivery: 'notDelivered',
                repaired: [`clearedUndispatched${pending.type[0].toUpperCase()}${pending.type.slice(1)}`],
              };
            }
            if (pending.type === 'steer') {
              return {
                laneId: lane.laneId,
                providerId: lane.providerId,
                state: lane.state,
                delivery: 'unknown',
                pendingOperation: 'steer',
                repaired: [],
              };
            }

            const pendingInspection = await inspectThread(client, lane);
            if (pending.type === 'interrupt') {
              const targetIsActive = pendingInspection.turn?.id === pending.details.turnId &&
                pendingInspection.turn.status === 'inProgress';
              if (targetIsActive) {
                return {
                  laneId: lane.laneId,
                  providerId: lane.providerId,
                  state: lane.state,
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
                phase: pendingInspection.phase,
                delivery: 'confirmed',
                repaired: ['interruptPostcondition'],
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
                phase: pendingInspection.phase,
                delivery: 'confirmed',
                repaired: ['resumeInputReceipt'],
              };
            }
            return {
              laneId: lane.laneId,
              providerId: lane.providerId,
              state: lane.state,
              delivery: 'unknown',
              pendingOperation: 'resume',
              repaired: [],
            };
          }

          let inspected = await inspectThread(client, lane);
          const repaired = [];
          const spawnPending = operation?.type === 'spawn' && operation.state !== 'complete';
          const recoveredSpawnTurnId = spawnPending
            ? await findTurnByClientMessage(
              client,
              lane.providerId,
              operation.operationId,
              operation.details.inputSha256,
            )
            : null;
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
          return {
            laneId: lane.laneId,
            providerId: lane.providerId,
            state: lane.state,
            phase: inspected.phase,
            delivery: spawnPending
              ? recoveredSpawnTurnId ? 'confirmed' : 'unknown'
              : inspected.turn ? 'confirmed' : 'unknown',
            ...(spawnPending && !recoveredSpawnTurnId ? { pendingOperation: 'spawn' } : {}),
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
          });
          continue;
        }
        recovered.push({
          laneId: initial.laneId,
          providerId: initial.providerId,
          error: error.message,
          code: error.code || 'RECOVERY_ERROR',
        });
      }
    }
    return {
      version: 1,
      ok: recovered.every((entry) =>
        !entry.error && !entry.skipped && entry.delivery !== 'unknown' &&
        entry.outcome !== 'cleanupRetryable'
      ),
      operation: 'recover',
      adapter: 'codex-app-server',
      recovered,
      receipt: { userAgent: initialized.userAgent },
    };
  }, env);
}

module.exports = {
  TransmogrifyError,
  executionCapabilities,
  interrupt,
  recover,
  resume,
  retire,
  spawn,
  status,
  steer,
};
