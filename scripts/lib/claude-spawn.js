'use strict';

// Claude Code lane spawn: the pinned execution selection, the background
// launch, the exact-session attribution and binding, native presentation,
// and the settlement of a spawn journal by observation.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  bindClaudeSpawnObservation, bindLaneSeat, ensureRegistry, pendingOperationForLane,
  projectPaths, requireOwnedLane, reserveSpawn, updateLane,
} = require('./state');
const {
  assertSafeModelSelector, claudeSpawnArgs, parseJobId, sha256,
} = require('./claude-surface');
const { markDispatchJournaled, recordEvent, reserveDispatch } = require('./dispatch');
const {
  executionRequest, laneResult, nowMs, profileFailure, worktreesRoot,
} = require('./adapter-kit');
const { sleep } = require('./async');
const {
  ExecutionProfileError, requestFromProfile, resolveClaudeExecutionProfile, stableStringify,
  validateUnobservedProfile,
} = require('./execution-profile');
const { CLAUDE_GUIDANCE } = require('./execution-guidance');
const { canonicalLaneName, laneNameError, ownedLaneNameError } = require('./validation');
const {
  materializeManagedSeat, planManagedSeat, plannedProvisionedEntries, verifySeat,
} = require('./worktree');
const { prependExchangePreamble, writePacket } = require('./exchange');
const {
  BACKEND, ClaudeTransmogrifyError, RETRYABLE_SPAWN_RECEIPT_CODES, SPAWN_ABSENCE_GRACE_MS,
  SPAWN_VERIFY_DELAY_MS, SPAWN_VERIFY_TIMEOUT_MS, capabilities, childHooksEnabled, claudeCatalogSource,
  completePending, ensureLatestEpoch, epochFromDiscovery, exactAgent, executionArgs,
  failReservedDispatch, observedStop, ownerActionFor, pollAgents, preflight, publicRuntime,
  readDurableSpawnReceipt, remainingCommandMs, removeChildHooksSettings, removeDurableSpawnReceipts,
  spawnCause, surfaceFor, updatePending, updateRunningLane, writeChildHooksSettings,
} = require('./claude-runtime');

// The lane's immutable spawn intent and its journal must name the same model
// selector; a disagreement is OWNERSHIP_MISMATCH before reconciliation acts.
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

// Resolve the immutable execution profile against the pinned Claude catalog. A
// supplied profile must resolve identically or it is refused as stale.
function resolveSpawnProfile(options, runtime) {
  try {
    let supplied = null;
    if (options.executionProfile !== undefined) {
      supplied = validateUnobservedProfile(options.executionProfile);
      if (supplied.provider !== 'claude') {
        throw new ExecutionProfileError('INVALID_PROFILE', 'execution profile provider is not claude');
      }
    }
    const resolved = resolveClaudeExecutionProfile({
      request: supplied ? requestFromProfile(supplied) : executionRequest(options),
      guidance: CLAUDE_GUIDANCE,
      source: claudeCatalogSource(runtime),
    });
    if (supplied && stableStringify(supplied) !== stableStringify(resolved)) {
      throw new ExecutionProfileError(
        'STALE_PROFILE', 'supplied Claude execution profile does not match pinned capabilities',
      );
    }
    return resolved;
  } catch (error) { return profileFailure(error); }
}

// Dispatch the Remote Control deep link so the lane is visible natively.
// Presentation is best effort: a failure records dispatchUnknown visibility and
// never fails the surrounding lifecycle operation.
async function presentLane(options, env, surface, runtime, lane) {
  const attemptedAt = new Date().toISOString();
  try {
    const presentation = await surface.dispatchDeepLink(
      runtime,
      lane.providerIdentity.bridgeId,
      { timeoutMs: options.commandTimeoutMs },
    );
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

// The immutable creation receipt: the attributed session, its realpath cwd, the
// launch stdout digest, the transcript proof, and the worker identity.
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

// The single new agent row this launch produced: exact job id, the lane's
// display name, a cwd resolving to the owned seat, a start time inside the
// dispatch window, and absence from the preflight census. Anything other than
// one exact match returns null, so an ambiguous spawn is never adopted.
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

// Attribute a launched job to one exact session and bind it: verify the
// transcript nonce and prompt digests, discover the worker and bridge, bind
// session, job, bridge, and first execution epoch in one write, then present the
// lane and close the journal. Failing to attribute exactly one session is
// SPAWN_UNCERTAIN and leaves the lane delivery-unknown.
async function finalizeSpawn(options, env, surface, runtime, lane, operation, jobId, stdout,
  deadline = null) {
  const dispatchStartedAt = operation.details.dispatchStartedAt;
  const receiptStat = fs.lstatSync(lane.ownership.spawnIntent.stdoutPath);
  const dispatchFinishedAt = operation.details.dispatchFinishedAt || receiptStat.mtimeMs;
  if (!Number.isFinite(dispatchStartedAt) || !Number.isFinite(dispatchFinishedAt)) {
    throw new ClaudeTransmogrifyError('SPAWN_UNCERTAIN', 'Claude spawn dispatch window is incomplete');
  }
  const located = await pollAgents(surface, runtime, (agents) => candidateFromJob(
    agents, jobId, lane.ownership.spawnIntent, lane.seat, dispatchStartedAt, dispatchFinishedAt,
  ), { attempts: options.discoveryAttempts, delayMs: options.discoveryDelayMs, deadline });
  if (!located) {
    throw new ClaudeTransmogrifyError('SPAWN_UNCERTAIN', 'spawned Claude job could not be attributed to one exact session');
  }
  const candidate = located.result;
  const { transcript, discovery } = await awaitSpawnReceipts(options, surface, runtime, lane, jobId, candidate, deadline);
  lane = bindClaudeSpawnObservation(options.repoRoot, lane.laneId, {
    sessionId: candidate.sessionId, jobId, bridgeId: discovery.bridgeId,
    creationReceipt: creationReceipt(candidate, jobId, discovery, stdout, runtime, transcript),
    bridgeReceipt: bridgeReceipt(discovery),
    epoch: epochFromDiscovery(discovery, operation.operationId),
  }, env);
  lane = updateRunningLane(options.repoRoot, lane, candidate, env, {
    lastVerifiedAt: new Date().toISOString(),
  });
  const presented = await presentLane(deadline === null ? options : {
    ...options,
    commandTimeoutMs: remainingCommandMs(deadline),
  }, env, surface, runtime, lane);
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

// Create an exact-owned Claude lane. The immutable spawn intent, its nonce,
// prompt digests, preflight session census, and capture paths, is journaled
// before the CLI is launched so the resulting session can be attributed without
// guessing. ENOENT or EACCES is proven NOT_DELIVERED; every other launch or
// attribution failure is SPAWN_UNCERTAIN and the launch is never repeated.
async function spawnLane(options, env = process.env) {
  options = validateClaudeSpawnRequest(options);
  const packet = options.input;
  const surface = surfaceFor(options);
  const runtime = preflight(options, env, surface);
  if (options.parentContext || options.executionProfile !== undefined) {
    options = { ...options, executionProfile: resolveSpawnProfile(options, runtime) };
  }
  const laneId = options.laneId || crypto.randomUUID();
  const dispatchEnvelope = options.parentContext ? reserveDispatch({
    parentContext: options.parentContext,
    repoRoot: options.repoRoot,
    laneId,
    targetProvider: 'claude',
    backend: BACKEND,
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
  const ctx = {
    options, env, surface, runtime, laneId, dispatchEnvelope, packet,
    operationId: crypto.randomUUID(), lane: null, operation: null, argv: null, stdoutPath: null, stderrPath: null,
  };
  await reserveClaudeSpawn(ctx);
  const launch = await launchSession(ctx);
  const jobId = readJobId(ctx, launch);
  const finalized = await attributeSession(ctx, jobId, launch);
  recordSpawnedEvent(ctx, finalized);
  return laneResult('spawn', finalized.lane, {
    operationId: ctx.operation.operationId,
    exchange: ctx.exchange,
    receipt: {
      jobId, sessionId: finalized.lane.providerId,
      bridgeIdSha256: sha256(finalized.lane.providerIdentity.bridgeId),
      presentation: finalized.presentation.state,
      requestedModelSelector: finalized.lane.ownership.spawnIntent.modelSelector || null,
      ...(finalized.lane.executionProfile ? { executionProfile: finalized.lane.executionProfile } : {}),
    },
  });
}

function validateClaudeSpawnRequest(options) {
  if (!options.repoRoot || !path.isAbsolute(options.repoRoot) ||
      typeof options.name !== 'string' || !options.name ||
      typeof options.input !== 'string' || !options.input) {
    throw new ClaudeTransmogrifyError('USAGE_ERROR', 'spawn requires absolute repoRoot, name, and input');
  }
  const nameProblem = laneNameError(options.name, 'Claude lane name');
  if (nameProblem) throw new ClaudeTransmogrifyError('USAGE_ERROR', nameProblem);
  const canonical = { ...options, name: canonicalLaneName(options.name) };
  const canonicalNameProblem = ownedLaneNameError(canonical.name, 'Claude lane name');
  if (canonicalNameProblem) throw new ClaudeTransmogrifyError('USAGE_ERROR', canonicalNameProblem);
  if (canonical.model !== undefined) assertSafeModelSelector(canonical.model);
  return canonical;
}

// Take the preflight census, build the exact argv (prompt marker, pinned
// execution, child hooks), plan or verify the seat, and reserve the lane with
// its spawn journal. A failure before the reservation settles the parent's
// dispatch; the seat is materialized once the journal exists.
async function reserveClaudeSpawn(ctx) {
  const { options, env, surface, runtime, laneId, dispatchEnvelope, operationId } = ctx;
  let preflightAgents;
  try {
    preflightAgents = await surface.agents(runtime);
  } catch (error) {
    failReservedDispatch(dispatchEnvelope, env);
    throw error;
  }
  const spawnNonce = crypto.randomUUID();
  const marker = `[transmogrify spawn ${spawnNonce}]`;
  const execution = options.executionProfile ? executionArgs(options.executionProfile) : { model: options.model };
  const settingsFile = (dispatchEnvelope && childHooksEnabled(env)
    ? writeChildHooksSettings(laneId, dispatchEnvelope.dispatch.parentRef, execution, env)
    : null) || undefined;
  const paths = projectPaths(options.repoRoot, env);
  ctx.stdoutPath = path.join(paths.operations, `${operationId}.spawn.stdout`);
  ctx.stderrPath = path.join(paths.operations, `${operationId}.spawn.stderr`);
  let seatIntent;
  let externalSeat;
  try {
    seatIntent = options.cwd ? null : planManagedSeat(
      options.repoRoot, worktreesRoot(options, env), laneId,
      { branchName: options.branchName, baseRef: options.baseRef },
    );
    externalSeat = options.cwd
      ? {
        ...verifySeat(options.repoRoot, options.cwd, worktreesRoot(options, env)),
        provisioned: plannedProvisionedEntries(options.repoRoot),
      } : null;
  } catch (error) {
    failReservedDispatch(dispatchEnvelope, env);
    throw error;
  }
  options.input = prependExchangePreamble(
    (externalSeat || seatIntent).path,
    options.input,
  );
  const prompt = `${options.input}\n\n${marker}`;
  ctx.argv = claudeSpawnArgs(options.name, prompt, {
    ...execution,
    ...(settingsFile ? { fastMode: undefined, settingsFile } : {}),
  });
  const modelSelector = options.executionProfile?.resolved.model.selector ?? options.model;
  const spawnIntent = {
    operationId, spawnNonce, displayName: options.name, promptSha256: sha256(options.input),
    promptMarkerSha256: sha256(marker),
    modelSelector,
    preflightSessionIds: preflightAgents
      .filter((agent) => typeof agent.sessionId === 'string')
      .map((agent) => agent.sessionId.toLowerCase()).sort(),
    stdoutPath: ctx.stdoutPath, stderrPath: ctx.stderrPath,
  };
  try {
    ({ lane: ctx.lane, operation: ctx.operation } = reserveSpawn(options.repoRoot, {
      operation: {
        operationId, type: 'spawn', laneId,
        details: {
          target: 'claude', name: options.name, promptSha256: sha256(options.input),
          promptMarkerSha256: sha256(marker), spawnNonce, stdoutPath: ctx.stdoutPath, stderrPath: ctx.stderrPath,
          modelSelector,
          ...(options.executionProfile ? { executionProfile: options.executionProfile } : {}),
          ...(dispatchEnvelope ? {
            dispatchId: dispatchEnvelope.dispatch.dispatchId,
            promptReceipts: dispatchEnvelope.receipts,
          } : {}),
        },
      },
      lane: {
        laneId, backend: BACKEND, target: 'claude', displayName: options.name,
        state: 'planned', operationId,
        ...(options.lineage ? { lineage: options.lineage } : {}),
        ...(options.executionProfile ? { executionProfile: options.executionProfile } : {}),
        capabilities: capabilities(), runtime: publicRuntime(runtime), seat: externalSeat, seatIntent,
        providerIdentity: {
          version: 1, sessionId: null, jobId: null, bridgeId: null,
          executionEpochs: [], runtimeEpochs: [],
        },
        spawnIntent,
      },
    }, env));
  } catch (error) {
    failReservedDispatch(dispatchEnvelope, env);
    throw error;
  }
  if (options.dispatch) markDispatchJournaled(options.dispatch.dispatchId, env);
  if (!ctx.lane.seat) {
    const seat = materializeManagedSeat(options.repoRoot, ctx.lane.seatIntent);
    ctx.lane = bindLaneSeat(options.repoRoot, ctx.lane.laneId, ctx.operation.operationId, seat, env);
    ctx.operation = pendingOperationForLane(options.repoRoot, ctx.lane.laneId, env);
  }
  ctx.exchange = writePacket(options.repoRoot, ctx.lane.seat, ctx.packet).exchange;
}

// Launch the background session with the journal in dispatching. A launch
// the operating system refused is NOT_DELIVERED with its receipts removed;
// any other failure is SPAWN_UNCERTAIN and nothing is repeated.
async function launchSession(ctx) {
  const { options, env, surface, runtime, lane } = ctx;
  ctx.operation = updatePending(options.repoRoot, lane.laneId, ctx.operation, {
    state: 'dispatching', details: { ...ctx.operation.details, dispatchStartedAt: nowMs(options) },
  }, env);
  let launch;
  try {
    launch = await surface.launch(runtime, ctx.argv, {
      cwd: lane.seat.path, stdoutPath: ctx.stdoutPath, stderrPath: ctx.stderrPath, timeoutMs: options.launchTimeoutMs,
    });
  } catch (error) {
    const definitelyNotStarted = ['ENOENT', 'EACCES'].includes(error.code);
    if (definitelyNotStarted) {
      ctx.operation = updatePending(options.repoRoot, lane.laneId, ctx.operation, {
        state: 'notDeliveredCaptureCleanup',
        details: { ...ctx.operation.details, errorCode: error.code },
      }, env);
      updateLane(options.repoRoot, lane.laneId, { state: 'failed' }, env);
      removeDurableSpawnReceipts(options.repoRoot, lane, env);
      removeChildHooksSettings(lane.laneId, env);
      completePending(options.repoRoot, lane.laneId, ctx.operation, {
        state: 'notDelivered', details: { ...ctx.operation.details, errorCode: error.code },
      }, env);
    } else {
      updatePending(options.repoRoot, lane.laneId, ctx.operation, { state: 'spawnUnknown' }, env);
      updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
    }
    throw new ClaudeTransmogrifyError(
      definitelyNotStarted ? 'NOT_DELIVERED' : 'SPAWN_UNCERTAIN', error.message,
      { laneId: lane.laneId },
    );
  }
  ctx.operation = updatePending(options.repoRoot, lane.laneId, ctx.operation, {
    state: 'dispatched',
    details: {
      ...ctx.operation.details, dispatchFinishedAt: nowMs(options),
      stdoutSha256: sha256(launch.stdout), stderrSha256: sha256(launch.stderr),
    },
  }, env);
  return launch;
}

function readJobId(ctx, launch) {
  const { options, env, lane } = ctx;
  try { return parseJobId(launch.stdout); } catch (error) {
    updatePending(options.repoRoot, lane.laneId, ctx.operation, { state: 'spawnUnknown' }, env);
    updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
    throw new ClaudeTransmogrifyError('SPAWN_UNCERTAIN', error.message, { laneId: lane.laneId });
  }
}

// Attribute the launched job to its exact session and bind it; a failure
// leaves the journal unknown with its cause and the lane delivery-unknown
// unless a later phase already advanced it.
async function attributeSession(ctx, jobId, launch) {
  const { options, env, surface, runtime, lane, operation } = ctx;
  try {
    const finalized = await finalizeSpawn(options, env, surface, runtime, lane, operation, jobId, launch.stdout);
    if (options.onLaunch) options.onLaunch(finalized.lane);
    return finalized;
  } catch (error) {
    const current = requireOwnedLane(options.repoRoot, lane.laneId, env);
    const cause = spawnCause(error);
    if (current.pendingOperationId === operation.operationId) {
      updatePending(options.repoRoot, lane.laneId, operation, {
        state: 'spawnUnknown', details: { ...operation.details, ...cause },
      }, env);
      if (current.state === 'planned' || current.state === 'created') {
        updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
      }
    }
    throw new ClaudeTransmogrifyError('SPAWN_UNCERTAIN', error.message, {
      laneId: lane.laneId, providerId: current.providerId, ...cause,
      ...(ownerActionFor(cause.causeCode) ? { ownerAction: ownerActionFor(cause.causeCode) } : {}),
    });
  }
}

// The provider effect is verified and journaled; a parent event that cannot
// be recorded is reported as such, never as uncertain or not attempted.
function recordSpawnedEvent(ctx, finalized) {
  const { options, env, lane, operation } = ctx;
  if (!options.dispatch) return;
  try {
    recordEvent({
      dispatchId: options.dispatch.dispatchId,
      type: 'child.spawned',
      fingerprint: `spawn-complete:${operation.operationId}:${finalized.lane.providerId}`,
      data: { state: 'spawned' },
    }, env);
  } catch (error) {
    throw new ClaudeTransmogrifyError(
      'PARENT_EVENT_UNRECORDED',
      'lane launch is verified but the durable parent event could not be recorded',
      {
        laneId: lane.laneId,
        providerId: finalized.lane.providerId,
        providerMutation: 'verified',
        phase: 'parentEvent',
        code: error.code || 'INVALID_LOCAL_STATE',
      },
    );
  }
}

// Settle a spawn journal without relaunching. A bound lane is verified and
// presented; an unbound one is bound from the durable stdout receipt when it
// exists, reported not delivered only when the launch provably never started,
// and otherwise left spawnUnknown.
async function reconcilePendingSpawn(options, env, surface, runtime, lane, operation,
  deadline = null) {
  assertSpawnSelection(lane, operation);
  if (!lane.seat && lane.seatIntent) {
    const seat = materializeManagedSeat(options.repoRoot, lane.seatIntent);
    lane = bindLaneSeat(options.repoRoot, lane.laneId, operation.operationId, seat, env);
    operation = pendingOperationForLane(options.repoRoot, lane.laneId, env);
  }
  if (operation.state === 'notDeliveredCaptureCleanup') {
    removeDurableSpawnReceipts(options.repoRoot, lane, env);
    removeChildHooksSettings(lane.laneId, env);
    if (lane.state !== 'failed') lane = updateLane(options.repoRoot, lane.laneId, { state: 'failed' }, env);
    completePending(options.repoRoot, lane.laneId, operation, { state: 'notDelivered' }, env);
    return { lane, outcome: 'spawnNotDelivered' };
  }
  if (lane.providerId) {
    const agent = await exactAgent(surface, runtime, lane, deadline === null ? {} : {
      commandTimeoutMs: remainingCommandMs(deadline, 100),
    });
    if (agent.pid === null) lane = observedStop(options.repoRoot, lane, operation, env);
    else {
      const execution = surface.executionReceipt(runtime, lane, agent, deadline === null ? {} : {
        timeoutMs: remainingCommandMs(deadline),
      });
      ensureLatestEpoch(lane, execution);
      lane = updateRunningLane(options.repoRoot, lane, agent, env);
    }
    const presented = await presentLane(deadline === null ? options : {
      ...options,
      commandTimeoutMs: remainingCommandMs(deadline),
    }, env, surface, runtime, lane);
    removeDurableSpawnReceipts(options.repoRoot, lane, env);
    completePending(options.repoRoot, lane.laneId, operation, {
      state: 'complete', details: { ...operation.details, presentation: presented.presentation.state },
    }, env);
    return { lane: presented.lane, outcome: 'spawnVerified', presentation: presented.presentation.state };
  }
  const receipt = readDurableSpawnReceipt(options.repoRoot, lane, env);
  if (!receipt) {
    if (['planned', 'seatReady'].includes(operation.state)) {
      lane = updateLane(options.repoRoot, lane.laneId, { state: 'failed' }, env);
      completePending(options.repoRoot, lane.laneId, operation, { state: 'notDelivered' }, env);
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
  const absence = await observeSpawnJobAbsence(options, surface, runtime, lane, normalized, jobId, deadline);
  if (absence) return settleAbsentSpawn(options, env, lane, normalized, jobId, absence);
  let finalized;
  try {
    finalized = await finalizeSpawn(
      options, env, surface, runtime, lane, normalized, jobId, receipt.stdout, deadline,
    );
  } catch (error) {
    const cause = spawnCause(error);
    try {
      updatePending(options.repoRoot, lane.laneId, normalized, {
        state: normalized.state, details: { ...normalized.details, ...cause },
      }, env);
    } catch {}
    throw new ClaudeTransmogrifyError('SPAWN_UNCERTAIN', error.message, {
      laneId: lane.laneId, ...cause,
      ...(ownerActionFor(cause.causeCode) ? { ownerAction: ownerActionFor(cause.causeCode) } : {}),
    });
  }
  return {
    lane: finalized.lane, outcome: 'spawnBoundFromDurableReceipt',
    presentation: finalized.presentation.state,
  };
}

// Read the transcript receipt and the worker identity, retrying only the
// "not yet" failures (transcript not written, bridge not registered) inside a
// bounded window. Any other failure, and the last failure once the window
// closes, propagates with its own code so the journal records the cause.
async function awaitSpawnReceipts(options, surface, runtime, lane, jobId, candidate, deadline) {
  const timeoutMs = options.spawnVerifyTimeoutMs ?? SPAWN_VERIFY_TIMEOUT_MS;
  const delayMs = options.spawnVerifyDelayMs ?? SPAWN_VERIFY_DELAY_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || !Number.isInteger(delayMs) || delayMs < 0) {
    throw new ClaudeTransmogrifyError('USAGE_ERROR', 'spawn verification window must be non-negative integers');
  }
  const windowEnd = nowMs(options) + timeoutMs;
  const expectation = {
    spawnNonce: lane.ownership.spawnIntent.spawnNonce,
    promptSha256: lane.ownership.spawnIntent.promptSha256,
    promptMarkerSha256: lane.ownership.spawnIntent.promptMarkerSha256,
  };
  const expected = {
    sessionId: candidate.sessionId, jobId, name: lane.displayName, cwd: lane.seat.path,
  };
  let transcript = null;
  for (;;) {
    try {
      if (!transcript) transcript = surface.verifySpawnTranscript(runtime, candidate.sessionId, expectation);
      const discovery = surface.discoverExecution(runtime, expected, candidate,
        deadline === null ? {} : { timeoutMs: remainingCommandMs(deadline) });
      return { transcript, discovery };
    } catch (error) {
      const retryable = RETRYABLE_SPAWN_RECEIPT_CODES.has(error?.code);
      const remaining = Math.min(windowEnd - nowMs(options), deadline === null ? Infinity : deadline.msLeft() - 100);
      if (!retryable || remaining <= 0) throw error;
      await sleep(Math.min(delayMs, Math.max(0, remaining)));
    }
  }
}

// Whether the dispatched job has vanished from the provider census. Only an
// old dispatch counts, and only when every poll agrees, so a job that is still
// registering is never mistaken for a dead one. Never mutates the provider.
async function observeSpawnJobAbsence(options, surface, runtime, lane, operation, jobId, deadline) {
  const finishedAt = operation.details.dispatchFinishedAt;
  const graceMs = options.spawnAbsenceGraceMs ?? SPAWN_ABSENCE_GRACE_MS;
  if (!Number.isInteger(graceMs) || graceMs < 0) {
    throw new ClaudeTransmogrifyError('USAGE_ERROR', 'spawnAbsenceGraceMs must be a non-negative integer');
  }
  if (!Number.isFinite(finishedAt) || nowMs(options) - finishedAt < graceMs) return null;
  const attempts = Math.max(1, options.discoveryAttempts ?? 3);
  const delayMs = options.discoveryDelayMs ?? 1000;
  let seat = null;
  try { seat = lane.seat ? fs.realpathSync(lane.seat.path) : null; } catch { seat = null; }
  const preflight = lane.ownership?.spawnIntent?.preflightSessionIds || [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const agents = await surface.agents(runtime, deadline === null ? {} : {
      timeoutMs: remainingCommandMs(deadline, 100),
    });
    const present = agents.some((agent) => {
      if (typeof agent?.id === 'string' && agent.id.toLowerCase() === jobId) return true;
      if (agent?.name !== lane.displayName) return false;
      if (typeof agent.sessionId === 'string' && preflight.includes(agent.sessionId.toLowerCase())) return false;
      if (!seat || typeof agent.cwd !== 'string') return false;
      try { return fs.realpathSync(agent.cwd) === seat; } catch { return false; }
    });
    if (present) return null;
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  return { observedAbsentAt: new Date().toISOString(), attempts };
}

// Close a spawn journal whose job is provably gone: the lane fails, the raw
// capture files go (their digests stay in the operation), and the operation
// records the absence. The parent's wait loop turns the terminal spawn into a
// child.failed event; retire can then free the seat.
function settleAbsentSpawn(options, env, lane, operation, jobId, absence) {
  let settled = lane.state === 'failed'
    ? lane : updateLane(options.repoRoot, lane.laneId, { state: 'failed' }, env);
  removeDurableSpawnReceipts(options.repoRoot, settled, env);
  completePending(options.repoRoot, settled.laneId, operation, {
    state: 'failed',
    details: {
      ...operation.details, outcome: 'spawnJobAbsent', jobId,
      observedAbsentAt: absence.observedAbsentAt, absenceAttempts: absence.attempts,
    },
  }, env);
  settled = requireOwnedLane(options.repoRoot, settled.laneId, env);
  return { lane: settled, outcome: 'spawnJobAbsent' };
}

module.exports = {
  assertSpawnSelection,
  resolveSpawnProfile,
  presentLane,
  creationReceipt,
  bridgeReceipt,
  candidateFromJob,
  finalizeSpawn,
  spawnLane,
  reconcilePendingSpawn,
  awaitSpawnReceipts,
  observeSpawnJobAbsence,
  settleAbsentSpawn,
};
