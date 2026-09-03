'use strict';

// Claude Code lane runtime helpers shared by the adapter and its spawn,
// retirement, and recovery modules: the adapter error and owner actions, the
// measured runtime and its identity comparisons, exact ownership and seat
// checks, execution epochs, the census poll, journal helpers, the observed
// stop, durable spawn receipts, and the child hook settings.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  beginLaneOperation, completeLaneOperation, observeLaneStopped, pendingOperationForLane,
  projectPaths, requireOwnedLane, updateLane, updateOperation, updatePendingLaneOperation,
} = require('./state');
const { createClaudeSurface } = require('./claude-surface');
const { childHooksPath, failDispatch, watcherPaths } = require('./dispatch');
const { AdapterError, deadlineFor } = require('./adapter-kit');
const { sleep } = require('./async');
const { verifyLaneSeat } = require('./worktree');

// A child launched for a parent carries session hooks (through the CLI's
// --settings) whose only action is to touch the parent's watcher nudge file
// when the child's turn ends, when its session ends, and when it raises a
// notification. The watcher then reads the child at once through the normal
// verified path instead of polling it; the hook itself asserts nothing.
// Verified live on the pinned CLI on 2026-09-03 (prompt submit, stop, and
// session end all fired through --settings). TRANSMOGRIFY_CHILD_HOOKS=off
// disables it.
function childHooksEnabled(env) {
  return env.TRANSMOGRIFY_CHILD_HOOKS !== 'off';
}

function safeHookPath(candidate) {
  return typeof candidate === 'string' && /^[A-Za-z0-9._\/-]+$/.test(candidate);
}

// Returns the settings file path, or null when the state root cannot be
// named safely inside a shell command (the child then runs without hooks and
// the watcher polls it).
function writeChildHooksSettings(laneId, parentRef, execution, env) {
  const file = childHooksPath(laneId, env);
  const nudge = watcherPaths(parentRef, env).nudge;
  if (!safeHookPath(nudge)) return null;
  const command = "/bin/sh -c 'mkdir -p \"" + path.dirname(nudge) + "\" && date +%s > \"" + nudge + "\"'";
  const hook = [{ hooks: [{ type: 'command', command, timeout: 5 }] }];
  const settings = {
    ...(execution?.fastMode !== undefined ? { fastMode: execution.fastMode } : {}),
    hooks: { Stop: hook, SessionEnd: hook, Notification: hook },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}

// The settings file a lane's session was launched with, when it still exists,
// so a resume reapplies the same hooks and fast-mode pin.
function existingChildHooksSettings(laneId, env) {
  const file = childHooksPath(laneId, env);
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

function removeChildHooksSettings(laneId, env) {
  try { fs.unlinkSync(childHooksPath(laneId, env)); } catch { /* never written or already gone */ }
}

// A spawn that fails before its lane is reserved leaves the parent a dispatch
// with nothing to observe; settle it as failed so the parent is told once and
// the child is not counted as outstanding. Best effort: the original failure
// is what the caller reports.
function failReservedDispatch(dispatchEnvelope, env) {
  if (!dispatchEnvelope) return;
  try { failDispatch(dispatchEnvelope.dispatch.dispatchId, 'spawn-not-registered', env); } catch { /* reported by the next observation */ }
}

const BACKEND = 'claude-code';

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

// The lane's aggregate command budget, on whatever clock options carries.
function commandDeadline(options) {
  return deadlineFor(options, options.commandTimeoutMs);
}

// Time left in the aggregate command deadline. Exhaustion is TIMEOUT, so no
// single provider call can spend an unbounded budget.
function remainingCommandMs(deadline, minimum = 1) {
  if (deadline === null) return undefined;
  const remaining = Math.floor(deadline.msLeft());
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
  const deadline = options.deadline ?? deadlineFor(options, options.timeoutMs);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (deadline !== null && deadline.msLeft() < 100) return null;
    const remaining = remainingCommandMs(deadline, 100);
    const agents = await surface.agents(runtime, remaining === undefined
      ? {} : { timeoutMs: remaining });
    const result = predicate(agents);
    if (result) return { agents, result };
    if (attempt < attempts && delayMs) {
      const boundedDelay = deadline === null
        ? delayMs : Math.min(delayMs, Math.max(0, deadline.msLeft()));
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
  // A concurrent observer (the parent's watcher reading status) may have
  // recorded the same worker exit first; the stop is verified either way.
  const current = requireOwnedLane(repoRoot, lane.laneId, env);
  if (current.state === 'stopped') return current;
  return observeLaneStopped(repoRoot, lane.laneId, {
    observationId: operation?.operationId || crypto.randomUUID(),
    observedAt: new Date().toISOString(),
    receipt: {
      source: operation ? `pending-${operation.type}` : 'exact-agent-status',
      exactSession: true, ...receipt,
    },
  }, env);
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

async function exactAgent(surface, runtime, lane, options = {}) {
  return surface.exactOwnedAgent(await surface.agents(runtime, {
    timeoutMs: options.commandTimeoutMs,
  }), lane.providerIdentity, {
    name: lane.displayName, cwd: lane.seat.path,
  });
}

// Delivery projection for each reconcilePendingSpawn outcome. reconcilePendingSpawn
// itself only names an outcome, so this is applied at the reconcile call site to
// give every entry a delivery value too.
const SPAWN_OUTCOME_DELIVERY = new Map([
  ['spawnNotDelivered', 'notDelivered'],
  ['spawnVerified', 'confirmed'],
  ['spawnUnknown', 'unknown'],
  ['spawnBoundFromDurableReceipt', 'confirmed'],
  ['spawnJobAbsent', 'notDelivered'],
]);

module.exports = {
  childHooksEnabled,
  safeHookPath,
  writeChildHooksSettings,
  existingChildHooksSettings,
  removeChildHooksSettings,
  failReservedDispatch,
  BACKEND,
  RETIRED_STATES,
  RETIRING_STATES,
  NON_MUTABLE_STATES,
  SHA256_PATTERN,
  ClaudeTransmogrifyError,
  SPAWN_ABSENCE_GRACE_MS,
  SPAWN_VERIFY_TIMEOUT_MS,
  SPAWN_VERIFY_DELAY_MS,
  RETRYABLE_SPAWN_RECEIPT_CODES,
  UNBOUND_PROVIDER_RECEIPT,
  OWNER_ACTIONS,
  spawnCause,
  ownerActionFor,
  commandDeadline,
  remainingCommandMs,
  publicRuntime,
  sameRuntime,
  effectiveRuntime,
  sameRuntimeIdentity,
  capabilities,
  surfaceFor,
  preflight,
  claudeCatalogSource,
  executionArgs,
  assertSeat,
  ownedLane,
  runtimeForLane,
  latestEpoch,
  ensureLatestEpoch,
  sameExecutionEpoch,
  epochFromDiscovery,
  phaseForAgent,
  runningLaneState,
  updateRunningLane,
  pollAgents,
  operationForType,
  updatePending,
  completePending,
  operationUsesPendingPointer,
  updateOperationJournal,
  completeOperationJournal,
  observedStop,
  readDurableSpawnReceipt,
  removeDurableSpawnReceipts,
  reconcileSteer,
  exactAgent,
  SPAWN_OUTCOME_DELIVERY,
};
