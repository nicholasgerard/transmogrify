'use strict';

// Claude Code lane adapter: spawn, status, steer, stop, recover, retire, and
// fleet reconciliation over the public CLI, the Remote Control bridge, and one
// pinned private archival call. A lane's session, job, bridge, and worker
// execution epoch form a single immutable identity, and every mutation is
// journaled before dispatch and confirmed against that exact identity. It never
// touches a session it does not own and never replays an unobserved delivery.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  appendLaneExecutionEpoch, beginLaneOperation, beginOperation, bindClaudeSpawnObservation, bindLaneSeat,
  completeLaneOperation, ensureRegistry, listLanes, listOperations, observeLaneStopped,
  pendingOperationForLane, projectPaths, rebindClaudeRuntime, repairUnstartedSpawn, requireOwnedLane, reserveSpawn, updateLane,
  settleTerminalLaneOperationPointer, updateOperation, updatePendingLaneOperation, withLaneLease,
} = require('./state');
const {
  assertSafeModelSelector, assertUniqueShortJobId, claudeResumeArgs, claudeSpawnArgs,
  createClaudeSurface,
  MAX_STEER_BYTES, parseJobId, sha256,
} = require('./claude-surface');
const { markDispatchJournaled, recordEvent, reserveDispatch } = require('./dispatch');
const {
  AdapterError, executionRequest, laneResult, profileFailure, worktreesRoot,
} = require('./adapter-kit');
const { phaseFields } = require('./output-schema');
const {
  ExecutionProfileError,
  createClaudeCliCatalog,
  requestFromProfile,
  resolveClaudeExecutionProfile,
  stableStringify,
  validateUnobservedProfile,
} = require('./execution-profile');
const {
  CLAUDE_GUIDANCE, CLAUDE_SELECTION_GUIDE, INTENT_DESCRIPTORS,
} = require('./execution-guidance');
const { canonicalLaneName, laneNameError, ownedLaneNameError } = require('./validation');
const {
  captureHarvestReceipt, isPermanentCleanupError, materializeManagedSeat, pathEntryExists,
  planManagedSeat, removeManagedSeat,
  verifyLaneSeat, verifySeat,
} = require('./worktree');

const BACKEND = 'claude-code';
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
// Retired lanes have released their provider and seat; retiring lanes are
// mid-retirement. Neither accepts a new mutation.
const RETIRED_STATES = new Set(['archivedVerified', 'cleanupEligible', 'worktreeRemoved']);
const RETIRING_STATES = new Set(['retireRequested', 'archiveUnknown', 'localRemovalPending']);
const NON_MUTABLE_STATES = new Set([...RETIRED_STATES, ...RETIRING_STATES]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// Adapter failure carrying a stable code. The code, not the message, drives the
// CLI exit status and the public delivery projection.
class ClaudeTransmogrifyError extends AdapterError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = 'ClaudeTransmogrifyError';
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// A dispatched spawn whose job is missing from the census this long after the
// launch finished is treated as gone rather than still registering.
const SPAWN_ABSENCE_GRACE_MS = 60_000;
// A freshly launched session writes its transcript and registers Remote
// Control a few seconds after the CLI returns. Spawn verification retries
// those two receipts inside this window instead of declaring the spawn
// uncertain on the first read.
const SPAWN_VERIFY_TIMEOUT_MS = 30_000;
const SPAWN_VERIFY_DELAY_MS = 500;
const RETRYABLE_SPAWN_RECEIPT_CODES = new Set([
  'TRANSCRIPT_RECEIPT_PENDING', 'REMOTE_CONTROL_UNAVAILABLE', 'DELIVERY_UNCERTAIN',
]);
const UNBOUND_PROVIDER_RECEIPT = Object.freeze({
  unbound: true, stop: 'notAttempted', archive: 'notAttempted', localRemoval: 'notAttempted',
});
const OWNER_ACTIONS = new Map([
  ['FORKED_COPY',
    'This Claude CLI build resumes a stopped background job as a new session, a fork. The fork ' +
    'this recovery created was stopped and the lane stays stopped with its original session. ' +
    'Retire the lane with a harvest digest, or spawn a new lane.'],
  ['REMOTE_CONTROL_UNAVAILABLE',
    'The session never registered Remote Control, usually because the Claude login broke at launch. ' +
    'Run claude auth status and, if it is logged out, claude auth login. Then stop and remove that ' +
    'exact session with claude stop and claude rm (claude agents --all lists it under this lane title), ' +
    'run reconcile again so the lane settles, and retire the lane to free its seat.'],
]);

// The cause recorded when a spawn cannot be verified: the failing check's code
// and its fixed message, never provider rows or paths.
function spawnCause(error) {
  return {
    ...(typeof error?.code === 'string' ? { causeCode: error.code } : {}),
    causeMessage: String(error?.message || 'unknown').slice(0, 300),
  };
}
function ownerActionFor(causeCode) {
  return OWNER_ACTIONS.get(causeCode) || null;
}
function commandDeadline(options) {
  return Number.isInteger(options.commandTimeoutMs)
    ? Date.now() + options.commandTimeoutMs : null;
}
// Time left in the aggregate command deadline. Exhaustion is TIMEOUT, so no
// single provider call can spend an unbounded budget.
function remainingCommandMs(deadline, minimum = 1) {
  if (deadline === null) return undefined;
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < minimum) {
    throw new ClaudeTransmogrifyError('TIMEOUT', 'Claude operation exceeded its command deadline');
  }
  return remaining;
}
// The runtime tuple with the prepared environment and org id stripped, so no
// durable record carries account or environment material.
function publicRuntime(runtime) {
  const { cleanEnv: _cleanEnv, orgId: _orgId, ...persisted } = runtime;
  return persisted;
}
// Recorded and current runtimes must agree on every key in both directions.
// allowLegacyProjectsIdentity keeps a pre-0.2 receipt on a removed seat readable
// without weakening the check on a live lane.
function sameRuntime(recorded, actual, options = {}) {
  const current = publicRuntime(actual);
  if (!recorded) return false;
  const legacyProjectsIdentity = options.allowLegacyProjectsIdentity === true &&
    recorded.projectsDevice === undefined &&
    recorded.projectsInode === undefined;
  const currentKeys = Object.keys(current).filter((key) =>
    !legacyProjectsIdentity || !['projectsDevice', 'projectsInode'].includes(key)
  );
  return currentKeys.every((key) => recorded[key] === current[key]) &&
    Object.keys(recorded).every((key) => recorded[key] === current[key]);
}
// The runtime a lane executes on now: its newest verified CLI transition, or
// the spawn runtime when no transition was ever recorded.
function effectiveRuntime(lane) {
  return lane.providerIdentity?.runtimeEpochs?.at(-1)?.runtime || lane.runtime;
}
// The identity keys a CLI upgrade must not change. The build hash is excluded
// because it is exactly what a transition rebinds.
function sameRuntimeIdentity(left, right) {
  return [
    'protocolGeneration', 'platform', 'arch', 'configDir', 'configDevice',
    'configInode', 'projectsDirectory', 'projectsDevice', 'projectsInode',
    'accountFingerprint',
  ].every((key) => left?.[key] === right?.[key]);
}
// The lifecycle semantics this adapter actually implements, recorded on every
// lane so a caller never assumes Codex-shaped turn control.
function capabilities() {
  return {
    steering: 'queuedSafePointPublicCli', stop: 'wholeSession', cancelTurnOnly: false,
    recovery: 'exactSessionNoExtraFlags', retirement: 'remoteArchiveThenLocalRemoval',
    nativePresentation: 'remoteControlDeepLink', approvalRelay: false,
  };
}
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
function surfaceFor(options) { return options.surface || createClaudeSurface(); }
// Measure the Claude runtime tuple, projecting a surface failure as an adapter
// error. It runs before any mutation, so a failure here changed nothing.
function preflight(options, env, surface) {
  try { return surface.preflight(options, env); } catch (error) {
    if (error instanceof ClaudeTransmogrifyError) throw error;
    throw new ClaudeTransmogrifyError(error.code || 'UNSUPPORTED_ENVIRONMENT', error.message, error.details);
  }
}

// Provenance for the pinned Claude capability catalog: the measured CLI build
// plus the documentation the selection contract was derived from.
function claudeCatalogSource(runtime) {
  return {
    kind: 'claude-cli+official-docs',
    cliVersion: runtime.cliVersion,
    cliSha256: runtime.cliSha256,
    verifiedAt: '2026-09-02',
    documentation: [
      'https://code.claude.com/docs/en/cli-usage',
      'https://code.claude.com/docs/en/model-config',
      'https://code.claude.com/docs/en/fast-mode',
      'https://code.claude.com/docs/en/workflows',
      'https://code.claude.com/docs/en/settings-reference',
      'https://platform.claude.com/docs/en/models/overview',
    ],
  };
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

// Compile a resolved profile into CLI arguments. Any control it cannot express
// exactly, an unexpected speed control or an execution setting that is not the
// ultracode/xhigh pair, is EXECUTION_PROFILE_UNSUPPORTED rather than a silently
// dropped selection.
function executionArgs(profile) {
  if (!profile) return {};
  const control = profile.resolved.speed.nativeControl;
  if (control.kind !== 'fast-mode' || typeof control.value !== 'boolean') {
    throw new ClaudeTransmogrifyError(
      'EXECUTION_PROFILE_UNSUPPORTED',
      'Claude execution profile has an unsupported speed control',
    );
  }
  const setting = profile.resolved.setting ?? null;
  let effort = profile.resolved.effort.level ?? undefined;
  if (setting !== null) {
    const settingControl = setting.nativeControl;
    if (
      setting.id !== 'ultracode'
      || settingControl.kind !== 'claude-effort-flag'
      || settingControl.value !== 'ultracode'
      || effort !== 'xhigh'
    ) {
      throw new ClaudeTransmogrifyError(
        'EXECUTION_PROFILE_UNSUPPORTED',
        'Claude execution profile has an unsupported execution setting',
      );
    }
    effort = settingControl.value;
  }
  return {
    model: profile.resolved.model.selector ?? undefined,
    effort,
    fastMode: control.value,
  };
}

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
// Re-verify the seat's recorded identity before a mutation; a replaced or moved
// worktree is SEAT_MISMATCH.
function assertSeat(options, lane) {
  try { return verifyLaneSeat(options.repoRoot, lane.seat); } catch (error) {
    throw new ClaudeTransmogrifyError('SEAT_MISMATCH', error.message);
  }
}
// Resolve the lane a command may act on. Another backend is ADAPTER_MISMATCH, a
// retiring or retired lane refuses mutation as LANE_RETIRED, and an incomplete
// session, job, or bridge identity is SPAWN_UNCERTAIN.
function ownedLane(options, env, mutation = false) {
  if (!options.repoRoot || !path.isAbsolute(options.repoRoot)) {
    throw new ClaudeTransmogrifyError('USAGE_ERROR', 'repoRoot must be absolute');
  }
  const lane = requireOwnedLane(options.repoRoot, options.laneId, env);
  if (lane.backend !== BACKEND) {
    throw new ClaudeTransmogrifyError('ADAPTER_MISMATCH', `lane ${lane.laneId} uses ${lane.backend}`);
  }
  if (mutation && NON_MUTABLE_STATES.has(lane.state)) {
    throw new ClaudeTransmogrifyError('LANE_RETIRED', `lane ${lane.laneId} is retiring or retired`);
  }
  if (!lane.providerId || !lane.providerIdentity?.sessionId || !lane.providerIdentity?.jobId ||
      !lane.providerIdentity?.bridgeId) {
    throw new ClaudeTransmogrifyError('SPAWN_UNCERTAIN', `lane ${lane.laneId} has incomplete Claude identity`);
  }
  return lane;
}
// Measure the current runtime through the lane's own recorded CLI path and
// require it to equal that lane's effective runtime. Drift in build, account,
// or config identity is RUNTIME_MISMATCH before anything is dispatched.
function runtimeForLane(options, lane, env, surface) {
  const expected = effectiveRuntime(lane);
  const runtime = preflight({
    ...options,
    claudeBin: options.claudeBin || expected.cliPath,
  }, env, surface);
  if (!sameRuntime(expected, runtime, {
    allowLegacyProjectsIdentity: lane.state === 'worktreeRemoved',
  })) {
    throw new ClaudeTransmogrifyError('RUNTIME_MISMATCH', 'Claude CLI/account/config identity changed');
  }
  return runtime;
}
function latestEpoch(lane) {
  return lane.providerIdentity.executionEpochs[lane.providerIdentity.executionEpochs.length - 1] || null;
}
// The live worker must be the exact journaled execution epoch: same pid, process
// birth, and control socket identity. Anything else is EXECUTION_EPOCH_UNBOUND
// and no command is sent to that process.
function ensureLatestEpoch(lane, execution) {
  const epoch = latestEpoch(lane);
  if (!epoch || epoch.pid !== execution.pid || epoch.processBirth !== execution.processBirth) {
    throw new ClaudeTransmogrifyError('EXECUTION_EPOCH_UNBOUND', 'Claude worker execution epoch is not journaled');
  }
  for (const key of ['path', 'device', 'inode', 'uid', 'mode']) {
    if (epoch.socket[key] !== execution.socket[key]) {
      throw new ClaudeTransmogrifyError('EXECUTION_EPOCH_UNBOUND', `Claude worker socket ${key} changed`);
    }
  }
  return epoch;
}
function sameExecutionEpoch(epoch, discovery) {
  return Boolean(epoch && epoch.pid === discovery.pid && epoch.processBirth === discovery.processBirth &&
    ['path', 'device', 'inode', 'uid', 'mode'].every((key) =>
      epoch.socket[key] === discovery.socket[key]));
}
function epochFromDiscovery(discovery, epochId = crypto.randomUUID()) {
  return {
    epochId, pid: discovery.pid, processBirth: discovery.processBirth,
    socket: discovery.socket, observedAt: new Date().toISOString(),
  };
}
// Collapse a listed agent row into one phase. A null pid is stopped, and an
// explicit waitingFor wins over any reported running state.
function phaseForAgent(agent) {
  const observedState = agent.status || agent.state || (agent.pid ? 'running' : 'stopped');
  const phase = agent.pid === null ? 'stopped' :
    agent.waitingFor ? 'waiting' :
      ['working', 'busy', 'running'].includes(observedState) ? 'working' :
        ['idle', 'done', 'completed'].includes(observedState) ? 'idle' : 'unknown';
  return { phase };
}
function runningLaneState(agent) { return phaseForAgent(agent).phase === 'working' ? 'active' : 'idle'; }
// Move a lane to the state its live agent implies, stepping through
// recoverRequested or deliveryUnknown first where the lifecycle has no direct
// edge out of stopped or stopRequested.
function updateRunningLane(repoRoot, lane, agent, env, patch = {}) {
  const target = runningLaneState(agent);
  let current = lane;
  if (current.state === 'stopped') {
    current = updateLane(repoRoot, current.laneId, { state: 'recoverRequested' }, env);
  } else if (current.state === 'stopRequested') {
    current = updateLane(repoRoot, current.laneId, { state: 'deliveryUnknown' }, env);
  }
  if (current.state !== target) {
    current = updateLane(repoRoot, current.laneId, { state: target, ...patch }, env);
  } else if (Object.keys(patch).length) {
    current = updateLane(repoRoot, current.laneId, patch, env);
  }
  return current;
}
// Poll the agent listing for a predicate within bounded attempts and the command
// deadline. Returns null on exhaustion; the caller decides whether that is a
// refusal or an unknown.
async function pollAgents(surface, runtime, predicate, options = {}) {
  const attempts = options.attempts ?? 30;
  const delayMs = options.delayMs ?? 100;
  const deadline = options.deadline ?? (Number.isInteger(options.timeoutMs)
    ? Date.now() + options.timeoutMs : null);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (deadline !== null && deadline - Date.now() < 100) return null;
    const remaining = remainingCommandMs(deadline, 100);
    const agents = await surface.agents(runtime, remaining === undefined
      ? {} : { timeoutMs: remaining });
    const result = predicate(agents);
    if (result) return { agents, result };
    if (attempt < attempts && delayMs) {
      const boundedDelay = deadline === null
        ? delayMs : Math.min(delayMs, Math.max(0, deadline - Date.now()));
      if (boundedDelay > 0) await sleep(boundedDelay);
    }
  }
  return null;
}
// Resume the lane's pending operation when it is this type, otherwise open a new
// journal. A different pending type is PENDING_OPERATION and nothing is sent.
function operationForType(repoRoot, lane, type, env, details) {
  const pending = pendingOperationForLane(repoRoot, lane.laneId, env);
  if (pending) {
    if (pending.type !== type) {
      throw new ClaudeTransmogrifyError(
        'PENDING_OPERATION',
        `lane ${lane.laneId} has unresolved ${pending.type} operation ${pending.operationId}`,
      );
    }
    return { operation: pending, resumed: true };
  }
  return {
    operation: beginLaneOperation(repoRoot, lane.laneId, {
      type, providerId: lane.providerId, details,
    }, env),
    resumed: false,
  };
}
function updatePending(repoRoot, laneId, operation, patch, env) {
  return updatePendingLaneOperation(repoRoot, laneId, operation.operationId, patch, env);
}
function completePending(repoRoot, laneId, operation, patch, env) {
  return completeLaneOperation(repoRoot, laneId, operation.operationId, patch, env);
}
// Whether this operation still owns the lane's pending pointer. An emergency
// stop journal runs beside a preserved pointer and must not clear it.
function operationUsesPendingPointer(repoRoot, laneId, operation, env) {
  return requireOwnedLane(repoRoot, laneId, env).pendingOperationId === operation.operationId;
}
// Patch through the lane pointer when this operation owns it and directly
// otherwise, so an emergency stop cannot settle another operation's pointer.
function updateOperationJournal(repoRoot, laneId, operation, patch, env) {
  return operationUsesPendingPointer(repoRoot, laneId, operation, env)
    ? updatePending(repoRoot, laneId, operation, patch, env)
    : updateOperation(repoRoot, operation.operationId, patch, env);
}
function completeOperationJournal(repoRoot, laneId, operation, patch, env) {
  return operationUsesPendingPointer(repoRoot, laneId, operation, env)
    ? completePending(repoRoot, laneId, operation, patch, env)
    : updateOperation(repoRoot, operation.operationId, { ...patch, state: patch.state || 'complete' }, env);
}
// Record a durable stop observation, leaving an already-stopped lane unchanged
// so a repeat observation cannot invent a second receipt.
function observedStop(repoRoot, lane, operation, env, receipt = {}) {
  if (lane.state === 'stopped') return lane;
  return observeLaneStopped(repoRoot, lane.laneId, {
    observationId: operation?.operationId || crypto.randomUUID(),
    observedAt: new Date().toISOString(),
    receipt: {
      source: operation ? `pending-${operation.type}` : 'exact-agent-status',
      exactSession: true, ...receipt,
    },
  }, env);
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
// Read the launch stdout receipt for an unbound spawn. The path must be the one
// this operation journaled, and a symlink, foreign owner, writable mode, or
// oversized file is SPAWN_UNCERTAIN. Absence returns null.
function readDurableSpawnReceipt(repoRoot, lane, env) {
  const paths = projectPaths(repoRoot, env);
  const expected = path.join(paths.operations, `${lane.operationId}.spawn.stdout`);
  if (lane.ownership.spawnIntent.stdoutPath !== expected) {
    throw new ClaudeTransmogrifyError('SPAWN_UNCERTAIN', 'Claude spawn stdout receipt path does not match its operation');
  }
  let stat;
  try { stat = fs.lstatSync(expected); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o022) !== 0 || stat.size > 64 * 1024) {
    throw new ClaudeTransmogrifyError('SPAWN_UNCERTAIN', 'Claude spawn stdout receipt is unsafe');
  }
  return { stdout: fs.readFileSync(expected, 'utf8'), modifiedAt: stat.mtimeMs };
}
// Delete the stdout and stderr receipts once the spawn is bound or proven not
// delivered, under the same path and safety checks used to read them. Anything
// unexpected is SPAWN_UNCERTAIN and the files are left in place.
function removeDurableSpawnReceipts(repoRoot, lane, env) {
  const paths = projectPaths(repoRoot, env);
  for (const [suffix, recorded] of [
    ['stdout', lane.ownership.spawnIntent.stdoutPath],
    ['stderr', lane.ownership.spawnIntent.stderrPath],
  ]) {
    const expected = path.join(paths.operations, `${lane.operationId}.spawn.${suffix}`);
    if (recorded !== expected) {
      throw new ClaudeTransmogrifyError(
        'SPAWN_UNCERTAIN',
        `Claude spawn ${suffix} receipt path does not match its operation`,
      );
    }
    let stat;
    try { stat = fs.lstatSync(expected); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024) {
      throw new ClaudeTransmogrifyError(
        'SPAWN_UNCERTAIN',
        `Claude spawn ${suffix} receipt is unsafe to remove`,
      );
    }
    fs.unlinkSync(expected);
  }
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
  if (!options.repoRoot || !path.isAbsolute(options.repoRoot) ||
      typeof options.name !== 'string' || !options.name ||
      typeof options.input !== 'string' || !options.input) {
    throw new ClaudeTransmogrifyError('USAGE_ERROR', 'spawn requires absolute repoRoot, name, and input');
  }
  const nameProblem = laneNameError(options.name, 'Claude lane name');
  if (nameProblem) throw new ClaudeTransmogrifyError('USAGE_ERROR', nameProblem);
  options = { ...options, name: canonicalLaneName(options.name) };
  const canonicalNameProblem = ownedLaneNameError(options.name, 'Claude lane name');
  if (canonicalNameProblem) {
    throw new ClaudeTransmogrifyError('USAGE_ERROR', canonicalNameProblem);
  }
  if (options.model !== undefined) assertSafeModelSelector(options.model);
  const surface = surfaceFor(options);
  const runtime = preflight(options, env, surface);
  if (options.parentContext || options.executionProfile !== undefined) {
    options = { ...options, executionProfile: resolveSpawnProfile(options, runtime) };
  }
  const resolvedExecution = executionArgs(options.executionProfile);
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
  const operationId = crypto.randomUUID();
  const preflightAgents = await surface.agents(runtime);
  const spawnNonce = crypto.randomUUID();
  const marker = `[transmogrify spawn ${spawnNonce}]`;
  const prompt = `${options.input}\n\n${marker}`;
  const argv = claudeSpawnArgs(options.name, prompt, {
    ...(options.executionProfile ? resolvedExecution : { model: options.model }),
  });
  const paths = projectPaths(options.repoRoot, env);
  const stdoutPath = path.join(paths.operations, `${operationId}.spawn.stdout`);
  const stderrPath = path.join(paths.operations, `${operationId}.spawn.stderr`);
  const seatIntent = options.cwd ? null : planManagedSeat(
    options.repoRoot, worktreesRoot(options, env), laneId,
    { branchName: options.branchName, baseRef: options.baseRef },
  );
  const externalSeat = options.cwd
    ? verifySeat(options.repoRoot, options.cwd, worktreesRoot(options, env)) : null;
  const spawnIntent = {
    operationId, spawnNonce, displayName: options.name, promptSha256: sha256(options.input),
    promptMarkerSha256: sha256(marker),
    modelSelector: options.executionProfile?.resolved.model.selector ?? options.model,
    preflightSessionIds: preflightAgents
      .filter((agent) => typeof agent.sessionId === 'string')
      .map((agent) => agent.sessionId.toLowerCase()).sort(),
    stdoutPath, stderrPath,
  };
  let { lane, operation } = reserveSpawn(options.repoRoot, {
    operation: {
      operationId, type: 'spawn', laneId,
      details: {
        target: 'claude', name: options.name, promptSha256: sha256(options.input),
        promptMarkerSha256: sha256(marker), spawnNonce, stdoutPath, stderrPath,
        modelSelector: options.executionProfile?.resolved.model.selector ?? options.model,
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
  }, env);
  if (options.dispatch) markDispatchJournaled(options.dispatch.dispatchId, env);
  if (!lane.seat) {
    const seat = materializeManagedSeat(options.repoRoot, lane.seatIntent);
    lane = bindLaneSeat(options.repoRoot, lane.laneId, operation.operationId, seat, env);
    operation = pendingOperationForLane(options.repoRoot, lane.laneId, env);
  }
  const dispatchStartedAt = Date.now();
  operation = updatePending(options.repoRoot, lane.laneId, operation, {
    state: 'dispatching', details: { ...operation.details, dispatchStartedAt },
  }, env);
  let launch;
  try {
    launch = await surface.launch(runtime, argv, {
      cwd: lane.seat.path, stdoutPath, stderrPath, timeoutMs: options.launchTimeoutMs,
    });
  } catch (error) {
    const definitelyNotStarted = ['ENOENT', 'EACCES'].includes(error.code);
    if (definitelyNotStarted) {
      operation = updatePending(options.repoRoot, lane.laneId, operation, {
        state: 'notDeliveredCaptureCleanup',
        details: { ...operation.details, errorCode: error.code },
      }, env);
      updateLane(options.repoRoot, lane.laneId, { state: 'failed' }, env);
      removeDurableSpawnReceipts(options.repoRoot, lane, env);
      completePending(options.repoRoot, lane.laneId, operation, {
        state: 'notDelivered', details: { ...operation.details, errorCode: error.code },
      }, env);
    } else {
      updatePending(options.repoRoot, lane.laneId, operation, { state: 'spawnUnknown' }, env);
      updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
    }
    throw new ClaudeTransmogrifyError(
      definitelyNotStarted ? 'NOT_DELIVERED' : 'SPAWN_UNCERTAIN', error.message,
      { laneId: lane.laneId },
    );
  }
  operation = updatePending(options.repoRoot, lane.laneId, operation, {
    state: 'dispatched',
    details: {
      ...operation.details, dispatchFinishedAt: Date.now(),
      stdoutSha256: sha256(launch.stdout), stderrSha256: sha256(launch.stderr),
    },
  }, env);
  let jobId;
  try { jobId = parseJobId(launch.stdout); } catch (error) {
    updatePending(options.repoRoot, lane.laneId, operation, { state: 'spawnUnknown' }, env);
    updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
    throw new ClaudeTransmogrifyError('SPAWN_UNCERTAIN', error.message, { laneId: lane.laneId });
  }
  let finalized;
  try {
    finalized = await finalizeSpawn(options, env, surface, runtime, lane, operation, jobId, launch.stdout);
    if (options.onLaunch) options.onLaunch(finalized.lane);
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
  if (options.dispatch) {
    try {
      recordEvent({
        dispatchId: options.dispatch.dispatchId,
        type: 'child.spawned',
        fingerprint: `spawn-complete:${operation.operationId}:${finalized.lane.providerId}`,
        data: { state: 'spawned' },
      }, env);
    } catch (error) {
      // The provider effect is verified and journaled; only the durable parent
      // notification failed. Never project this as uncertain or not attempted.
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
  return laneResult('spawn', finalized.lane, {
    operationId: operation.operationId,
    receipt: {
      jobId, sessionId: finalized.lane.providerId,
      bridgeIdSha256: sha256(finalized.lane.providerIdentity.bridgeId),
      presentation: finalized.presentation.state,
      requestedModelSelector: finalized.lane.ownership.spawnIntent.modelSelector || null,
      ...(finalized.lane.executionProfile ? {
        executionProfile: finalized.lane.executionProfile,
      } : {}),
    },
  });
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

// Settle a pending steer from its transcript delivery receipt. An observed
// receipt completes the journal and restores the pre-dispatch lane state; an
// unobservable one leaves the operation unknown and the lane delivery-unknown.
async function reconcileSteer(options, env, surface, runtime, lane, operation, deadline = null) {
  let receipt;
  try {
    if (deadline !== null) remainingCommandMs(deadline);
    receipt = surface.verifyDeliveryTranscript(runtime, lane.providerId, {
      messageSha256: operation.details.messageSha256,
      deliveryToken: operation.details.deliveryToken,
    });
  } catch (error) {
    const mutationMayHaveStarted = ['dispatching', 'queued', 'unknown'].includes(operation.state);
    if (!mutationMayHaveStarted && error.code !== 'DELIVERY_UNCERTAIN') throw error;
    if (mutationMayHaveStarted && operation.state !== 'unknown') {
      operation = updatePending(options.repoRoot, lane.laneId, operation, { state: 'unknown' }, env);
    }
    let current = requireOwnedLane(options.repoRoot, lane.laneId, env);
    if (['active', 'idle'].includes(current.state)) {
      current = updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
    }
    return {
      complete: false,
      lane: current,
      error: new ClaudeTransmogrifyError('DELIVERY_UNCERTAIN', error.message, {
        ...(error.code ? { causeCode: error.code } : {}),
      }),
    };
  }
  completePending(options.repoRoot, lane.laneId, operation, {
    state: 'complete', details: { ...operation.details, observation: receipt },
  }, env);
  let current = requireOwnedLane(options.repoRoot, lane.laneId, env);
  const priorLaneState = operation.details.laneStateBeforeDispatch;
  if (current.state === 'deliveryUnknown' && ['active', 'idle'].includes(priorLaneState)) {
    current = updateLane(options.repoRoot, lane.laneId, { state: priorLaneState }, env);
  }
  return { complete: true, receipt, lane: current };
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
        details: { ...operation.details, dispatchStartedAt: Date.now() },
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
          dispatchFinishedAt: Date.now(),
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
      const observed = await surface.waitForTranscriptDelivery(
        snapshot, framed, options.deliveryObserveTimeoutMs,
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

async function exactAgent(surface, runtime, lane, options = {}) {
  return surface.exactOwnedAgent(await surface.agents(runtime, {
    timeoutMs: options.commandTimeoutMs,
  }), lane.providerIdentity, {
    name: lane.displayName, cwd: lane.seat.path,
  });
}
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
    if (Number.isFinite(notAfter) && Date.now() > notAfter) {
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
    const dispatchStartedAt = Date.now();
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
      const dispatched = await surface.run(runtime, claudeResumeArgs(
        lane.providerId,
        executionArgs(lane.executionProfile),
      ), {
        cwd: lane.seat.path, timeoutMs: options.commandTimeoutMs,
      });
      operation = updatePending(options.repoRoot, lane.laneId, operation, {
        state: 'dispatched',
        details: {
          ...operation.details, dispatchFinishedAt: Date.now(),
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
              localRemovalDispatchStartedAt: Date.now(),
            },
          }, env);
          try {
            await surface.run(runtime, ['rm', lane.providerIdentity.jobId], {
              cwd: options.repoRoot, timeoutMs: options.commandTimeoutMs,
            });
            pending = updatePending(options.repoRoot, lane.laneId, pending, {
              state: 'localRemovalDispatched',
              details: { ...pending.details, localRemovalDispatchFinishedAt: Date.now() },
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
  const windowEnd = Date.now() + timeoutMs;
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
      const remaining = Math.min(windowEnd - Date.now(), deadline === null ? Infinity : deadline - Date.now() - 100);
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
  if (!Number.isFinite(finishedAt) || Date.now() - finishedAt < graceMs) return null;
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
    return { laneId: lane.laneId, providerId: lane.providerId, state: lane.state, outcome: 'stoppedObserved' };
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
  };
}
// Fleet reconciliation for one lane or every Claude lane. It settles pending
// journals by observation, records verified runtime transitions, and reports
// each lane's outcome without replaying any provider mutation.
async function reconcile(options, env = process.env) {
  if (!options.repoRoot || !path.isAbsolute(options.repoRoot)) {
    throw new ClaudeTransmogrifyError('USAGE_ERROR', 'reconcile requires absolute repoRoot');
  }
  let lanes;
  if (options.laneId) {
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
    lanes = [exact];
  } else {
    lanes = listLanes(options.repoRoot, env).filter((lane) => lane.backend === BACKEND);
  }
  if (lanes.length === 0) {
    return { version: 1, ok: true, operation: 'reconcile', adapter: BACKEND, results: [] };
  }
  const deadline = commandDeadline(options);
  const surface = surfaceFor(options);
  const operations = new Map(listOperations(options.repoRoot, env)
    .map((operation) => [operation.operationId, operation]));
  let runtime = null;
  const results = [];
  for (const initial of lanes) {
    try {
      const terminalRepair = await withLaneLease(options.repoRoot, initial.laneId, async () => {
        const repair = repairUnstartedSpawn(
          options.repoRoot, initial.laneId, operations.get(initial.operationId), env,
        );
        if (!repair) return null;
        return {
          laneId: repair.lane.laneId,
          providerId: repair.lane.providerId || null,
          state: repair.lane.state,
          outcome: repair.unstartedSpawn ? 'spawnNotDelivered' : 'terminalOperationPointerCleared',
          delivery: repair.delivery,
          repaired: repair.repaired,
        };
      }, env);
      if (terminalRepair) {
        results.push(terminalRepair);
        continue;
      }
      const outerPending = pendingOperationForLane(options.repoRoot, initial.laneId, env);
      const cleanupOnlyRetirement = outerPending?.type === 'retire' &&
        RETIRED_STATES.has(initial.state);
      if (cleanupOnlyRetirement) {
        if (options.finishRetirements !== true) {
          results.push({
            laneId: initial.laneId, providerId: initial.providerId,
            state: initial.state, outcome: 'retirementPending',
          });
        } else {
          const retired = await retire({ ...options, laneId: initial.laneId }, env);
          results.push({
            laneId: retired.laneId, providerId: retired.providerId,
            state: retired.state, outcome: 'retirementFinished',
          });
        }
        continue;
      }
      if (!runtime) {
        runtime = preflight({
          ...options,
          ...(deadline === null ? {} : {
            commandTimeoutMs: remainingCommandMs(deadline, 100),
          }),
        }, env, surface);
      }
      const expectedRuntime = effectiveRuntime(initial);
      const needsRuntimeTransition = !sameRuntime(expectedRuntime, runtime);
      if (needsRuntimeTransition && !sameRuntimeIdentity(expectedRuntime, publicRuntime(runtime))) {
        results.push({ laneId: initial.laneId, state: initial.state, outcome: 'differentRuntime' });
        continue;
      }
      if (outerPending?.type === 'retire') {
        if (options.finishRetirements !== true) {
          results.push({
            laneId: initial.laneId, providerId: initial.providerId,
            state: initial.state, outcome: 'retirementPending',
          });
        } else {
          const retired = await retire({ ...options, laneId: initial.laneId }, env);
          results.push({
            laneId: retired.laneId, providerId: retired.providerId,
            state: retired.state, outcome: 'retirementFinished',
          });
        }
        continue;
      }
      let runtimeRebound = false;
      const result = await withLaneLease(options.repoRoot, initial.laneId, async () => {
        let lane = requireOwnedLane(options.repoRoot, initial.laneId, env);
        if (!sameRuntime(effectiveRuntime(lane), runtime)) {
          lane = await bindRuntimeTransition(options, env, surface, runtime, lane, deadline);
          runtimeRebound = true;
        }
        const operation = pendingOperationForLane(options.repoRoot, lane.laneId, env);
        if (operation?.type === 'spawn') {
          const repaired = await reconcilePendingSpawn(
            options, env, surface, runtime, lane, operation, deadline,
          );
          return {
            laneId: repaired.lane.laneId, providerId: repaired.lane.providerId,
            state: repaired.lane.state, outcome: repaired.outcome,
            ...(repaired.presentation ? { presentation: repaired.presentation } : {}),
          };
        }
        if (operation?.type === 'steer') {
          const observed = await reconcileSteer(
            options, env, surface, runtime, lane, operation, deadline,
          );
          return {
            laneId: lane.laneId, providerId: lane.providerId,
            state: observed.lane.state,
            outcome: observed.complete ? 'steerDeliveredObserved' : 'steerUnknown',
          };
        }
        if (operation?.type === 'stop') {
          const stopped = await reconcilePendingStop(
            options, env, surface, runtime, lane, operation, deadline,
          );
          return {
            laneId: stopped.lane.laneId, providerId: stopped.lane.providerId,
            state: stopped.lane.state, outcome: stopped.outcome,
          };
        }
        if (operation?.type === 'recover') {
          const recovered = await observeRecovery(
            options, env, surface, runtime, lane, operation, deadline,
          );
          return {
            laneId: lane.laneId, providerId: lane.providerId,
            state: recovered ? recovered.lane.state : lane.state,
            outcome: recovered ? (recovered.settled || 'recoveryVerified') : 'recoveryUnknown',
          };
        }
        if (operation) {
          throw new ClaudeTransmogrifyError('RECONCILIATION_UNCERTAIN', `unsupported pending operation ${operation.type}`);
        }
        if (RETIRED_STATES.has(lane.state)) {
          return {
            laneId: lane.laneId, providerId: lane.providerId,
            state: lane.state, outcome: 'alreadyRetired',
          };
        }
        return reconcileBoundLane(options, env, surface, runtime, lane, deadline);
      }, env);
      results.push(runtimeRebound ? {
        ...result,
        outcome: result.outcome === 'verified' ? 'runtimeRebound' : result.outcome,
        runtimeTransition: 'verified',
      } : result);
    } catch (error) {
      if (error.code === 'CLEANUP_RETRYABLE') {
        results.push({
          laneId: initial.laneId,
          state: initial.state,
          outcome: 'cleanupRetryable',
          code: error.code,
          providerRetired: true,
          cleanup: 'retryable',
        });
        continue;
      }
      if (error.code === 'FORKED_COPY' && error.details?.copiesStopped !== undefined) {
        results.push({
          laneId: initial.laneId, providerId: initial.providerId, state: 'stopped',
          outcome: 'forkedCopyStopped', code: error.code,
          copiesStopped: error.details.copiesStopped, ownerAction: error.details.ownerAction,
        });
        continue;
      }
      const causeCode = error.details?.causeCode;
      results.push({
        laneId: initial.laneId, providerId: initial.providerId, state: initial.state,
        outcome: 'uncertain', code: error.code || 'RECONCILIATION_UNCERTAIN', error: error.message,
        ...(causeCode ? { causeCode } : {}),
        ...((error.details?.ownerAction || ownerActionFor(causeCode))
          ? { ownerAction: error.details?.ownerAction || ownerActionFor(causeCode) } : {}),
      });
    }
  }
  return {
    version: 1,
    ok: results.every((result) => ![
      'spawnUnknown', 'steerUnknown', 'stopPending', 'recoveryUnknown',
      'cleanupRetryable', 'retirementPending', 'differentRuntime', 'uncertain',
    ].includes(result.outcome)),
    operation: 'reconcile', adapter: BACKEND, results,
  };
}

module.exports = {
  BACKEND, ClaudeTransmogrifyError, capabilities, descriptor, reconcile, recover, retire,
  executionCapabilities, spawn: spawnLane, status, steer, stop,
};
