'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateUnobservedProfile } = require('./execution-profile');
const { sanitizedGitEnv } = require('./git-env');

const SCHEMA_VERSION = 1;
const ACTIVE_LANE_STATES = new Set([
  'planned',
  'created',
  'materialized',
  'named',
  'active',
  'idle',
  'retireRequested',
  'archiveUnknown',
  'deliveryUnknown',
  'interruptRequested',
  'stopRequested',
  'stopped',
  'recoverRequested',
  'localRemovalPending',
]);
const RETIRED_LANE_STATES = new Set([
  'archivedVerified',
  'logicallyRetired',
  'cleanupEligible',
  'worktreeRemoved',
]);
const TERMINAL_OPERATION_STATES = new Set(['complete', 'failed', 'notDelivered']);
const LANE_TRANSITIONS = new Map([
  ['planned', new Set(['created', 'failed', 'deliveryUnknown'])],
  ['created', new Set(['materialized', 'active', 'idle', 'failed', 'deliveryUnknown', 'retireRequested', 'stopRequested'])],
  ['materialized', new Set(['active', 'idle', 'failed', 'deliveryUnknown', 'retireRequested', 'stopRequested'])],
  ['named', new Set(['active', 'idle', 'deliveryUnknown', 'retireRequested', 'stopRequested'])],
  ['active', new Set(['idle', 'failed', 'interruptRequested', 'retireRequested', 'deliveryUnknown', 'stopRequested'])],
  ['idle', new Set(['active', 'failed', 'retireRequested', 'interruptRequested', 'deliveryUnknown', 'stopRequested'])],
  ['interruptRequested', new Set(['idle', 'failed', 'retireRequested', 'deliveryUnknown'])],
  ['stopRequested', new Set(['stopped', 'failed', 'deliveryUnknown'])],
  ['stopped', new Set(['recoverRequested', 'retireRequested'])],
  ['recoverRequested', new Set(['active', 'idle', 'stopped', 'failed', 'deliveryUnknown', 'stopRequested'])],
  ['retireRequested', new Set(['archiveUnknown', 'localRemovalPending', 'archivedVerified'])],
  ['archiveUnknown', new Set(['localRemovalPending', 'archivedVerified'])],
  ['localRemovalPending', new Set(['archivedVerified'])],
  ['deliveryUnknown', new Set(['created', 'materialized', 'active', 'idle', 'failed', 'retireRequested', 'archiveUnknown', 'stopRequested', 'stopped', 'recoverRequested'])],
  ['failed', new Set(['retireRequested', 'worktreeRemoved'])],
  ['archivedVerified', new Set(['cleanupEligible', 'worktreeRemoved'])],
  ['cleanupEligible', new Set(['worktreeRemoved'])],
  ['logicallyRetired', new Set(['cleanupEligible', 'worktreeRemoved'])],
  ['worktreeRemoved', new Set()],
]);

function assertLaneTransition(from, to) {
  if (from === to) return;
  if (!LANE_TRANSITIONS.get(from)?.has(to)) {
    throw new Error(`invalid lane state transition: ${from} -> ${to}`);
  }
}

function stateRoot(env = process.env) {
  const configured = env.TRANSMOGRIFY_STATE_DIR ||
    path.join(env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), '.local', 'state'), 'transmogrify');
  if (!path.isAbsolute(configured)) {
    throw new Error(`TRANSMOGRIFY_STATE_DIR must be absolute: ${configured}`);
  }
  let ancestor = path.resolve(configured);
  const missing = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const ancestorStat = fs.lstatSync(ancestor);
  if (!ancestorStat.isDirectory() || ancestorStat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && ancestorStat.uid !== process.getuid()) ||
      (ancestorStat.mode & 0o022) !== 0) {
    throw new Error(`refusing non-owner-controlled state ancestor: ${ancestor}`);
  }
  const canonicalAncestor = fs.realpathSync(ancestor);
  return path.join(canonicalAncestor, ...missing);
}

function assertPrivateStateDirectory(directory) {
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error(`refusing symlinked state directory: ${directory}`);
  if (!stat.isDirectory()) throw new Error(`state path is not a directory: ${directory}`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`refusing state directory owned by another user: ${directory}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`refusing non-private state directory: ${directory}`);
  }
}

function ensurePrivateStateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivateStateDirectory(directory);
}

function gitOutput(repoRoot, args) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizedGitEnv(),
    }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`git ${args.join(' ')} failed for ${repoRoot}: ${detail}`);
  }
}

function identityFor(targetPath) {
  const stat = fs.statSync(targetPath);
  return { device: stat.dev, inode: stat.ino };
}

function resolveProject(repoRoot) {
  if (!repoRoot || !path.isAbsolute(repoRoot)) {
    throw new Error(`REPO_ROOT must be an absolute path: ${repoRoot || '(missing)'}`);
  }
  const canonicalInput = fs.realpathSync(repoRoot);
  const root = fs.realpathSync(gitOutput(canonicalInput, ['rev-parse', '--show-toplevel']));
  if (root !== canonicalInput) {
    throw new Error(`REPO_ROOT must be the worktree root: expected ${root}, got ${canonicalInput}`);
  }
  const commonDir = fs.realpathSync(gitOutput(root, [
    'rev-parse', '--path-format=absolute', '--git-common-dir',
  ]));
  return {
    root,
    commonDir,
    rootIdentity: identityFor(root),
    commonDirIdentity: identityFor(commonDir),
  };
}

function projectKey(project) {
  return crypto.createHash('sha256').update(project.commonDir).digest('hex');
}

function projectPaths(repoRoot, env = process.env) {
  const project = resolveProject(repoRoot);
  const root = stateRoot(env);
  const relativeToRepo = path.relative(project.root, root);
  const relativeToCommon = path.relative(project.commonDir, root);
  if (relativeToRepo === '' || (!relativeToRepo.startsWith(`..${path.sep}`) && relativeToRepo !== '..')) {
    throw new Error(`operator state must be outside the repository: ${root}`);
  }
  if (relativeToCommon === '' || (!relativeToCommon.startsWith(`..${path.sep}`) && relativeToCommon !== '..')) {
    throw new Error(`operator state must be outside the Git common directory: ${root}`);
  }
  const projects = path.join(root, 'projects');
  const directory = path.join(projects, projectKey(project));
  const laneLocks = path.join(directory, 'lane-locks');
  const operations = path.join(directory, 'operations');
  for (const candidate of [root, projects, directory, laneLocks, operations]) {
    assertPrivateStateDirectory(candidate);
  }
  return {
    project,
    directory,
    registry: path.join(directory, 'registry.json'),
    lock: path.join(directory, 'lock'),
    laneLocks,
    operations,
  };
}

function sameIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode;
}

function sameJson(left, right) {
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
  };
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAUDE_JOB_PATTERN = /^[0-9a-f]{8}$/i;
const CLAUDE_BRIDGE_PATTERN = /^session_(?:staging_)?[0-9A-Za-z]{1,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const GIT_OBJECT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const CLAUDE_BACKEND = 'claude-code';

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
}

function assertTimestamp(value, label) {
  if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
}

function validateExecutionEpoch(epoch, expectedOrdinal) {
  if (!epoch || typeof epoch !== 'object' || Array.isArray(epoch)) {
    throw new Error('Claude execution epoch must be an object');
  }
  assertExactKeys(epoch, new Set([
    'epochId', 'ordinal', 'pid', 'processBirth', 'socket', 'observedAt',
  ]), 'Claude execution epoch');
  if (!UUID_PATTERN.test(epoch.epochId || '')) throw new Error('Claude execution epoch requires a UUID');
  if (epoch.ordinal !== expectedOrdinal) throw new Error('Claude execution epoch ordinals must be contiguous');
  if (!Number.isInteger(epoch.pid) || epoch.pid < 1) throw new Error('Claude execution epoch PID is invalid');
  if (typeof epoch.processBirth !== 'string' || !epoch.processBirth) {
    throw new Error('Claude execution epoch process birth is required');
  }
  assertTimestamp(epoch.observedAt, 'Claude execution epoch observedAt');
  const socket = epoch.socket;
  if (!socket || typeof socket !== 'object' || Array.isArray(socket)) {
    throw new Error('Claude execution epoch socket receipt is required');
  }
  assertExactKeys(socket, new Set([
    'path', 'device', 'inode', 'uid', 'mode', 'tokenSha256',
  ]), 'Claude execution epoch socket');
  if (!path.isAbsolute(socket.path || '')) throw new Error('Claude execution socket path must be absolute');
  for (const key of ['device', 'inode', 'uid', 'mode']) {
    if (!Number.isInteger(socket[key]) || socket[key] < 0) {
      throw new Error(`Claude execution socket ${key} is invalid`);
    }
  }
  if (socket.mode !== 0o600) throw new Error('Claude execution socket mode must be 0600');
  if (socket.tokenSha256 !== undefined && !SHA256_PATTERN.test(socket.tokenSha256)) {
    throw new Error('Claude execution socket tokenSha256 is invalid');
  }
}

const CLAUDE_RUNTIME_KEYS = new Set([
  'protocolGeneration', 'platform', 'arch', 'cliPath', 'cliVersion', 'cliSha256',
  'configDir', 'configDevice', 'configInode', 'projectsDirectory', 'projectsDevice',
  'projectsInode', 'accountFingerprint',
]);
const CLAUDE_RUNTIME_IDENTITY_KEYS = [
  'protocolGeneration', 'platform', 'arch', 'configDir', 'configDevice',
  'configInode', 'projectsDirectory', 'projectsDevice', 'projectsInode',
  'accountFingerprint',
];

function validateClaudeRuntime(runtime, label = 'Claude runtime', options = {}) {
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new Error(`${label} must be an object`);
  }
  assertExactKeys(runtime, CLAUDE_RUNTIME_KEYS, label);
  if (runtime.protocolGeneration !== 1 || typeof runtime.platform !== 'string' ||
      typeof runtime.arch !== 'string' || !/^\d+\.\d+\.\d+$/.test(runtime.cliVersion || '') ||
      !SHA256_PATTERN.test(runtime.cliSha256 || '') ||
      !SHA256_PATTERN.test(runtime.accountFingerprint || '')) {
    throw new Error(`${label} has an invalid compatibility identity`);
  }
  for (const key of ['cliPath', 'configDir', 'projectsDirectory']) {
    if (!path.isAbsolute(runtime[key] || '')) throw new Error(`${label} ${key} must be absolute`);
  }
  for (const key of ['configDevice', 'configInode']) {
    if (!Number.isInteger(runtime[key]) || runtime[key] < 0) {
      throw new Error(`${label} ${key} is invalid`);
    }
  }
  const legacyProjectsIdentity = options.allowLegacyProjectsIdentity === true &&
    runtime.projectsDevice === undefined && runtime.projectsInode === undefined;
  if (!legacyProjectsIdentity) {
    for (const key of ['projectsDevice', 'projectsInode']) {
      if (!Number.isInteger(runtime[key]) || runtime[key] < 0) {
        throw new Error(`${label} ${key} is invalid`);
      }
    }
  }
}

function sameClaudeRuntimeIdentity(left, right) {
  return CLAUDE_RUNTIME_IDENTITY_KEYS.every((key) => left?.[key] === right?.[key]);
}

function assertReceipt(receipt, label) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error(`${label} is required`);
  }
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      if (/(token|secret|credential|authorization)/i.test(key) && key !== 'tokenSha256') {
        throw new Error(`${label} contains secret-bearing field ${key}`);
      }
      visit(nested);
    }
  };
  visit(receipt);
}

function validateClaudeProviderIdentity(lane) {
  const identity = lane.providerIdentity;
  if (identity === undefined) return;
  if (lane.backend !== CLAUDE_BACKEND) {
    throw new Error(`lane ${lane.laneId} uses Claude provider identity with backend ${lane.backend}`);
  }
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error(`lane ${lane.laneId} has an invalid Claude provider identity`);
  }
  assertExactKeys(identity, new Set([
    'version', 'sessionId', 'jobId', 'bridgeId', 'executionEpochs', 'runtimeEpochs',
  ]), `lane ${lane.laneId} Claude provider identity`);
  if (identity.version !== 1) throw new Error(`lane ${lane.laneId} has an unsupported Claude provider identity`);
  for (const key of ['sessionId', 'jobId', 'bridgeId']) {
    if (identity[key] !== null && typeof identity[key] !== 'string') {
      throw new Error(`lane ${lane.laneId} Claude ${key} must be a string or null`);
    }
  }
  const hasSession = identity.sessionId !== null;
  const hasJob = identity.jobId !== null;
  if (hasSession !== hasJob) throw new Error(`lane ${lane.laneId} Claude session and job must bind atomically`);
  if (hasSession) {
    if (!UUID_PATTERN.test(identity.sessionId)) throw new Error(`lane ${lane.laneId} Claude session id is invalid`);
    if (identity.sessionId !== identity.sessionId.toLowerCase() || identity.jobId !== identity.jobId.toLowerCase()) {
      throw new Error(`lane ${lane.laneId} Claude session and job ids must be lowercase`);
    }
    if (!CLAUDE_JOB_PATTERN.test(identity.jobId) ||
        identity.sessionId.slice(0, 8).toLowerCase() !== identity.jobId.toLowerCase()) {
      throw new Error(`lane ${lane.laneId} Claude job id does not match its session`);
    }
    if (lane.providerId !== identity.sessionId) {
      throw new Error(`lane ${lane.laneId} Claude session does not match providerId`);
    }
  } else if (lane.providerId !== null) {
    throw new Error(`lane ${lane.laneId} Claude providerId is bound without a session`);
  }
  if (identity.bridgeId !== null && !CLAUDE_BRIDGE_PATTERN.test(identity.bridgeId)) {
    throw new Error(`lane ${lane.laneId} Claude bridge id is invalid`);
  }
  if (identity.bridgeId !== null && !hasSession) {
    throw new Error(`lane ${lane.laneId} Claude bridge is bound without a session`);
  }
  if (!Array.isArray(identity.executionEpochs)) {
    throw new Error(`lane ${lane.laneId} Claude execution epochs must be an array`);
  }
  if (identity.executionEpochs.length > 0 && (!hasSession || identity.bridgeId === null)) {
    throw new Error(`lane ${lane.laneId} has Claude execution epochs without a fully bound provider`);
  }
  const epochIds = new Set();
  identity.executionEpochs.forEach((epoch, index) => {
    validateExecutionEpoch(epoch, index + 1);
    if (epochIds.has(epoch.epochId)) throw new Error(`lane ${lane.laneId} has duplicate Claude execution epochs`);
    epochIds.add(epoch.epochId);
  });
  const runtimeEpochs = identity.runtimeEpochs || [];
  if (!Array.isArray(runtimeEpochs)) {
    throw new Error(`lane ${lane.laneId} Claude runtime epochs must be an array`);
  }
  const allowLegacyProjectsIdentity = lane.state === 'worktreeRemoved';
  const runtimeBound = lane.runtime !== null && lane.runtime !== undefined;
  if (hasSession || identity.executionEpochs.length > 0 || runtimeEpochs.length > 0 || runtimeBound) {
    validateClaudeRuntime(lane.runtime, `lane ${lane.laneId} initial Claude runtime`, {
      allowLegacyProjectsIdentity,
    });
  }
  const transitionIds = new Set();
  let priorRuntime = lane.runtime;
  let priorExecutionOrdinal = 0;
  runtimeEpochs.forEach((transition, index) => {
    const label = `lane ${lane.laneId} Claude runtime epoch`;
    if (!transition || typeof transition !== 'object' || Array.isArray(transition)) {
      throw new Error(`${label} must be an object`);
    }
    assertExactKeys(transition, new Set([
      'transitionId', 'ordinal', 'fromCliSha256', 'runtime', 'worker',
      'executionEpochOrdinal', 'observedAt',
    ]), label);
    if (!UUID_PATTERN.test(transition.transitionId || '') ||
        transitionIds.has(transition.transitionId)) {
      throw new Error(`${label} id is invalid or duplicated`);
    }
    if (transition.ordinal !== index + 1 ||
        transition.fromCliSha256 !== priorRuntime?.cliSha256) {
      throw new Error(`${label} chain is invalid`);
    }
    validateClaudeRuntime(transition.runtime, label, { allowLegacyProjectsIdentity });
    if (!sameClaudeRuntimeIdentity(priorRuntime, transition.runtime) ||
        transition.runtime.cliSha256 === priorRuntime.cliSha256) {
      throw new Error(`${label} changes the immutable provider identity or repeats a build`);
    }
    const worker = transition.worker;
    if (!worker || typeof worker !== 'object' || Array.isArray(worker)) {
      throw new Error(`${label} worker receipt is required`);
    }
    assertExactKeys(worker, new Set(['path', 'sha256']), `${label} worker`);
    if (worker.path !== transition.runtime.cliPath || worker.sha256 !== transition.runtime.cliSha256) {
      throw new Error(`${label} worker does not match its runtime`);
    }
    if (!Number.isInteger(transition.executionEpochOrdinal) ||
        transition.executionEpochOrdinal <= priorExecutionOrdinal ||
        transition.executionEpochOrdinal > identity.executionEpochs.length) {
      throw new Error(`${label} execution reference is invalid`);
    }
    assertTimestamp(transition.observedAt, `${label} observedAt`);
    transitionIds.add(transition.transitionId);
    priorRuntime = transition.runtime;
    priorExecutionOrdinal = transition.executionEpochOrdinal;
  });
}

function validateClaudeSpawnIntent(lane) {
  if (lane.providerIdentity === undefined) return;
  const intent = lane.ownership?.spawnIntent;
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new Error(`lane ${lane.laneId} requires an immutable Claude spawn intent`);
  }
  assertExactKeys(intent, new Set([
    'operationId', 'spawnNonce', 'displayName', 'promptSha256', 'promptMarkerSha256',
    'preflightSessionIds', 'stdoutPath', 'stderrPath', 'modelSelector',
  ]), `lane ${lane.laneId} Claude spawn intent`);
  if (!UUID_PATTERN.test(intent.operationId || '') || !UUID_PATTERN.test(intent.spawnNonce || '') ||
      intent.operationId !== lane.operationId || intent.operationId !== lane.ownership.operationId) {
    throw new Error(`lane ${lane.laneId} Claude spawn intent operation does not match ownership`);
  }
  if (intent.displayName !== lane.displayName) {
    throw new Error(`lane ${lane.laneId} Claude spawn intent name does not match`);
  }
  if (intent.modelSelector !== undefined &&
      (typeof intent.modelSelector !== 'string' ||
       !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(intent.modelSelector))) {
    throw new Error(`lane ${lane.laneId} Claude spawn intent model is invalid`);
  }
  for (const key of ['promptSha256', 'promptMarkerSha256']) {
    if (!SHA256_PATTERN.test(intent[key] || '')) {
      throw new Error(`lane ${lane.laneId} Claude spawn intent ${key} is invalid`);
    }
  }
  if (!Array.isArray(intent.preflightSessionIds) ||
      intent.preflightSessionIds.some((entry) => !UUID_PATTERN.test(entry) || entry !== entry.toLowerCase()) ||
      new Set(intent.preflightSessionIds).size !== intent.preflightSessionIds.length) {
    throw new Error(`lane ${lane.laneId} Claude spawn intent preflight census is invalid`);
  }
  for (const key of ['stdoutPath', 'stderrPath']) {
    if (!path.isAbsolute(intent[key] || '')) {
      throw new Error(`lane ${lane.laneId} Claude spawn intent ${key} must be absolute`);
    }
  }
}

function validateLaneJournal(lane) {
  if (lane.pendingOperationId !== undefined && lane.pendingOperationId !== null &&
      !UUID_PATTERN.test(lane.pendingOperationId)) {
    throw new Error(`lane ${lane.laneId} has an invalid pending operation pointer`);
  }
  if (lane.observedStops === undefined) return;
  if (!Array.isArray(lane.observedStops)) {
    throw new Error(`lane ${lane.laneId} observed stops must be an array`);
  }
  const ids = new Set();
  for (const observation of lane.observedStops) {
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
      throw new Error(`lane ${lane.laneId} has an invalid observed-stop record`);
    }
    assertExactKeys(observation, new Set([
      'observationId', 'fromState', 'observedAt', 'receipt',
    ]), `lane ${lane.laneId} observed stop`);
    if (!UUID_PATTERN.test(observation.observationId || '') || ids.has(observation.observationId)) {
      throw new Error(`lane ${lane.laneId} observed-stop id is invalid or duplicated`);
    }
    if (typeof observation.fromState !== 'string' || !observation.fromState) {
      throw new Error(`lane ${lane.laneId} observed-stop source state is invalid`);
    }
    assertTimestamp(observation.observedAt, `lane ${lane.laneId} observed stop observedAt`);
    assertReceipt(observation.receipt, `lane ${lane.laneId} observed stop receipt`);
    ids.add(observation.observationId);
  }
}

function validateSeatIntent(lane) {
  if (lane.seatIntent === undefined || lane.seatIntent === null) return;
  const intent = lane.seatIntent;
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new Error(`lane ${lane.laneId} has an invalid seat intent`);
  }
  assertExactKeys(intent, new Set([
    'version', 'laneId', 'path', 'worktreesRoot', 'gitCommonDir', 'branchRef',
    'baseCommit', 'managed',
  ]), `lane ${lane.laneId} seat intent`);
  if (intent.version !== 1 || intent.laneId !== lane.laneId || intent.managed !== true) {
    throw new Error(`lane ${lane.laneId} has an invalid managed seat intent identity`);
  }
  for (const key of ['path', 'worktreesRoot', 'gitCommonDir']) {
    if (!path.isAbsolute(intent[key] || '')) {
      throw new Error(`lane ${lane.laneId} seat intent ${key} must be absolute`);
    }
  }
  if (typeof intent.branchRef !== 'string' || !intent.branchRef.startsWith('refs/heads/')) {
    throw new Error(`lane ${lane.laneId} seat intent branchRef is invalid`);
  }
  if (!GIT_OBJECT_PATTERN.test(intent.baseCommit || '')) {
    throw new Error(`lane ${lane.laneId} seat intent baseCommit is invalid`);
  }
  if (lane.seat !== null && lane.seat !== undefined) {
    for (const key of ['path', 'worktreesRoot', 'gitCommonDir', 'branchRef', 'managed']) {
      if (lane.seat[key] !== intent[key]) {
        throw new Error(`lane ${lane.laneId} seat does not match its intent (${key})`);
      }
    }
    if (lane.seat.head !== intent.baseCommit) {
      throw new Error(`lane ${lane.laneId} seat does not match its intended base commit`);
    }
  }
}

function validateLineage(lane) {
  if (lane.lineage === undefined) return;
  const lineage = lane.lineage;
  if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage)) {
    throw new Error(`lane ${lane.laneId} has invalid dispatch lineage`);
  }
  assertExactKeys(lineage, new Set([
    'version', 'dispatchId', 'parentRef', 'installationId',
  ]), `lane ${lane.laneId} dispatch lineage`);
  if (lineage.version !== 1 || !UUID_PATTERN.test(lineage.dispatchId || '') ||
      !UUID_PATTERN.test(lineage.parentRef || '') || !UUID_PATTERN.test(lineage.installationId || '')) {
    throw new Error(`lane ${lane.laneId} has invalid dispatch lineage`);
  }
}

function validateExecutionProfile(lane) {
  if (lane.executionProfile === undefined) return;
  try {
    validateUnobservedProfile(lane.executionProfile);
  } catch (error) {
    throw new Error(`lane ${lane.laneId} has invalid execution profile: ${error.message}`);
  }
  if (lane.executionProfile.provider !== lane.target) {
    throw new Error(`lane ${lane.laneId} execution profile provider does not match target`);
  }
}

function validateProviderIdentities(registry) {
  const claims = new Map();
  const seatClaims = new Map();
  for (const [laneKey, lane] of Object.entries(registry.lanes)) {
    if (!lane || typeof lane !== 'object' || Array.isArray(lane) || lane.laneId !== laneKey ||
        typeof lane.backend !== 'string' || !lane.backend ||
        (lane.providerId !== null && (typeof lane.providerId !== 'string' || !lane.providerId))) {
      throw new Error(`ownership registry lane ${laneKey} has an invalid canonical identity`);
    }
    validateLaneJournal(lane);
    validateSeatIntent(lane);
    validateLineage(lane);
    validateExecutionProfile(lane);
    const seatPath = lane.seat?.path || lane.seatIntent?.path;
    if (seatPath && lane.state !== 'worktreeRemoved') {
      if (seatClaims.has(seatPath)) {
        throw new Error(`lane seat is already owned as lane ${seatClaims.get(seatPath)}`);
      }
      seatClaims.set(seatPath, lane.laneId);
    }
    validateClaudeProviderIdentity(lane);
    validateClaudeSpawnIntent(lane);
    if (lane.providerId !== null) {
      const providerKey = `${lane.backend}\0provider\0${lane.providerId}`;
      if (claims.has(providerKey)) {
        throw new Error(`provider resource is already owned as lane ${claims.get(providerKey)}`);
      }
      claims.set(providerKey, lane.laneId);
    }
    if (lane.providerIdentity === undefined) continue;
    for (const [kind, value] of [
      ['session', lane.providerIdentity.sessionId],
      ['job', lane.providerIdentity.jobId],
      ['bridge', lane.providerIdentity.bridgeId],
    ]) {
      if (value === null) continue;
      const key = `${lane.backend}\0${kind}\0${value}`;
      if (claims.has(key)) throw new Error(`Claude ${kind} is already owned as lane ${claims.get(key)}`);
      claims.set(key, lane.laneId);
    }
  }
}

function validateRegistry(registry, project) {
  if (!registry || registry.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`unsupported or corrupt registry schema: ${registry?.schemaVersion ?? '(missing)'}`);
  }
  if (!registry.project || registry.project.root !== project.root ||
      registry.project.commonDir !== project.commonDir ||
      !sameIdentity(registry.project.rootIdentity, project.rootIdentity) ||
      !sameIdentity(registry.project.commonDirIdentity, project.commonDirIdentity)) {
    throw new Error('project identity does not match the ownership registry; explicit adoption is required');
  }
  if (!registry.lanes || typeof registry.lanes !== 'object' || Array.isArray(registry.lanes)) {
    throw new Error('ownership registry lanes must be an object');
  }
  validateProviderIdentities(registry);
  return registry;
}

function readJson(file) {
  let raw;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`refusing unsafe JSON state file: ${file}`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`refusing JSON state file owned by another user: ${file}`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`refusing non-private JSON state file: ${file}`);
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`refusing corrupt JSON state at ${file}: ${error.message}`);
  }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function atomicWriteJson(file, value) {
  const directory = path.dirname(file);
  ensurePrivateStateDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  fsyncDirectory(directory);
}

function processBirth(pid, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  try {
    return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { LC_ALL: 'C', LANG: 'C', PATH: '/usr/bin:/bin' },
      timeout: timeoutMs,
    }).trim() || null;
  } catch {
    return null;
  }
}

const SELF_START_MS = Date.now() - (process.uptime() * 1000);
const FALLBACK_BIRTH_PREFIX = 'self-start-ms:';

function fallbackProcessBirth(startMs = SELF_START_MS) {
  return `${FALLBACK_BIRTH_PREFIX}${Math.round(startMs)}`;
}

function processMatches(owner, dependencies = {}) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid < 1 || !owner.processBirth) return false;
  const signal = dependencies.kill || process.kill.bind(process);
  const birth = dependencies.processBirth || processBirth;
  try {
    signal(owner.pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
  const observed = birth(owner.pid);
  if (!observed) {
    // A live PID whose birth cannot be measured is never stale-reclaimed. For
    // the current process, the monotonic fallback still proves our own lock.
    if (owner.pid !== (dependencies.selfPid ?? process.pid)) return true;
    const expected = fallbackProcessBirth(dependencies.selfStartMs ?? SELF_START_MS);
    return owner.processBirth === expected;
  }
  if (observed === owner.processBirth) return true;
  if (!owner.processBirth.startsWith(FALLBACK_BIRTH_PREFIX)) return false;
  const recordedMs = Number(owner.processBirth.slice(FALLBACK_BIRTH_PREFIX.length));
  const observedMs = Date.parse(observed);
  return Number.isFinite(recordedMs) && Number.isFinite(observedMs) &&
    Math.abs(recordedMs - observedMs) <= 2000;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function lockOwner(dependencies = {}) {
  const pid = dependencies.selfPid ?? process.pid;
  const birth = (dependencies.processBirth || processBirth)(pid) ||
    fallbackProcessBirth(dependencies.selfStartMs ?? SELF_START_MS);
  return {
    token: crypto.randomUUID(),
    pid,
    processBirth: birth,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
  };
}

function staleLockObservation(lockDirectory, ownerlessGraceMs) {
  let stat;
  try {
    stat = fs.lstatSync(lockDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing unsafe ownership lock path: ${lockDirectory}`);
  }
  const ownerFile = path.join(lockDirectory, 'owner.json');
  const owner = readJson(ownerFile);
  if (owner) {
    let ownerStat;
    try {
      ownerStat = fs.lstatSync(ownerFile);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    return {
      stat,
      owner,
      stale: Date.now() - ownerStat.mtimeMs >= ownerlessGraceMs && !processMatches(owner),
    };
  }
  return {
    stat,
    owner: null,
    stale: Date.now() - stat.mtimeMs >= ownerlessGraceMs,
  };
}

function removeQuarantinedLock(directory) {
  try {
    const entries = fs.readdirSync(directory);
    if (entries.length === 1 && entries[0] === 'owner.json') {
      fs.unlinkSync(path.join(directory, 'owner.json'));
      fs.rmdirSync(directory);
    } else if (entries.length === 0) {
      fs.rmdirSync(directory);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function quarantineObservedLock(lockDirectory, observed) {
  const current = staleLockObservation(lockDirectory, 0);
  if (!current || current.stat.dev !== observed.stat.dev || current.stat.ino !== observed.stat.ino) {
    return false;
  }
  if (observed.owner) {
    if (!current.owner || current.owner.token !== observed.owner.token || processMatches(current.owner)) {
      return false;
    }
  } else if (current.owner) {
    return false;
  }
  const quarantine = `${lockDirectory}.stale-${Date.now()}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockDirectory, quarantine);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  removeQuarantinedLock(quarantine);
  return true;
}

function reclaimStaleCoordinator(reaperDirectory, ownerlessGraceMs) {
  const observed = staleLockObservation(reaperDirectory, ownerlessGraceMs);
  if (!observed?.stale) return false;
  return quarantineObservedLock(reaperDirectory, observed);
}

function acquireReaper(reaperDirectory, ownerlessGraceMs) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(reaperDirectory, { mode: 0o700 });
      const owner = lockOwner();
      atomicWriteJson(path.join(reaperDirectory, 'owner.json'), owner);
      return owner;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (!reclaimStaleCoordinator(reaperDirectory, ownerlessGraceMs)) return null;
  }
  return null;
}

function reapStaleLock(lockDirectory, observed, ownerlessGraceMs) {
  const reaperDirectory = `${lockDirectory}.reaper`;
  const reaper = acquireReaper(reaperDirectory, ownerlessGraceMs);
  if (!reaper) return false;
  try {
    let currentStat;
    try {
      currentStat = fs.lstatSync(lockDirectory);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory() ||
        currentStat.dev !== observed.stat.dev || currentStat.ino !== observed.stat.ino) {
      return false;
    }
    const ownerFile = path.join(lockDirectory, 'owner.json');
    const currentOwner = readJson(ownerFile);
    let stale = false;
    if (observed.owner) {
      if (!currentOwner || currentOwner.token !== observed.owner.token) return false;
      let ownerStat;
      try { ownerStat = fs.lstatSync(ownerFile); } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
      stale = Date.now() - ownerStat.mtimeMs >= ownerlessGraceMs && !processMatches(currentOwner);
    } else {
      if (currentOwner) return false;
      stale = Date.now() - currentStat.mtimeMs >= ownerlessGraceMs;
    }
    if (!stale) return false;
    return quarantineObservedLock(lockDirectory, { stat: currentStat, owner: currentOwner });
  } finally {
    releaseLock(reaperDirectory, reaper);
  }
}

function acquireLock(lockDirectory, options = {}) {
  const waitMs = options.waitMs ?? 5000;
  const pollMs = options.pollMs ?? 50;
  const ownerlessGraceMs = options.ownerlessGraceMs ?? 30_000;
  const started = Date.now();
  const pendingOwner = lockOwner(options.dependencies);

  ensurePrivateStateDirectory(path.dirname(lockDirectory));
  while (true) {
    const reaperDirectory = `${lockDirectory}.reaper`;
    reclaimStaleCoordinator(reaperDirectory, ownerlessGraceMs);
    try {
      fs.mkdirSync(lockDirectory, { mode: 0o700 });
      atomicWriteJson(path.join(lockDirectory, 'owner.json'), pendingOwner);
      return pendingOwner;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const observed = staleLockObservation(lockDirectory, ownerlessGraceMs);
    if (!observed) continue;
    if (observed.stale) {
      if (reapStaleLock(lockDirectory, observed, ownerlessGraceMs)) continue;
    }

    if (Date.now() - started >= waitMs) {
      throw new Error(`timed out waiting for ownership lock: ${lockDirectory}`);
    }
    sleepSync(pollMs);
  }
}

function releaseLock(lockDirectory, owner) {
  const ownerFile = path.join(lockDirectory, 'owner.json');
  const current = readJson(ownerFile);
  if (!current || current.token !== owner.token) {
    throw new Error(`refusing to release a lock owned by another process: ${lockDirectory}`);
  }
  fs.unlinkSync(ownerFile);
  fs.rmdirSync(lockDirectory);
}

function withProjectLock(paths, callback, options) {
  const owner = acquireLock(paths.lock, options);
  try { return callback(); } finally { releaseLock(paths.lock, owner); }
}

async function withLaneLease(repoRoot, laneId, callback, env = process.env, options) {
  if (!/^[0-9A-Za-z._-]+$/.test(laneId || '')) throw new Error(`invalid lane id: ${laneId}`);
  const paths = projectPaths(repoRoot, env);
  ensurePrivateStateDirectory(paths.laneLocks);
  const lockDirectory = path.join(paths.laneLocks, laneId);
  const owner = acquireLock(lockDirectory, options);
  try { return await callback(); } finally { releaseLock(lockDirectory, owner); }
}

function newRegistry(project) {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    installationId: crypto.randomUUID(),
    project,
    createdAt: now,
    updatedAt: now,
    lanes: {},
  };
}

function ensureRegistry(repoRoot, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const existing = readJson(paths.registry);
    if (existing) return { paths, registry: validateRegistry(existing, paths.project) };
    const registry = newRegistry(paths.project);
    ensurePrivateStateDirectory(paths.operations);
    atomicWriteJson(paths.registry, registry);
    return { paths, registry };
  });
}

function readRegistry(repoRoot, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  const registry = readJson(paths.registry);
  if (!registry) throw new Error(`ownership registry does not exist; run bootstrap first: ${paths.registry}`);
  return { paths, registry: validateRegistry(registry, paths.project) };
}

function writeRegistry(paths, registry) {
  validateRegistry(registry, paths.project);
  registry.updatedAt = new Date().toISOString();
  atomicWriteJson(paths.registry, registry);
}

function operationFile(paths, operationId) {
  if (!UUID_PATTERN.test(operationId || '')) {
    throw new Error(`invalid operation id: ${operationId}`);
  }
  return path.join(paths.operations, `${operationId}.json`);
}

function validateOperationRecord(record, expectedOperationId) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      !UUID_PATTERN.test(record.operationId || '') ||
      (expectedOperationId !== undefined && record.operationId !== expectedOperationId)) {
    throw new Error(`invalid operation record: ${expectedOperationId || '(unknown)'}`);
  }
  if (typeof record.type !== 'string' || !record.type) throw new Error('operation type is required');
  if (typeof record.state !== 'string' || !record.state) throw new Error('operation state is required');
  if (record.laneId !== null && (typeof record.laneId !== 'string' || !record.laneId)) {
    throw new Error('operation laneId must be a non-empty string or null');
  }
  if (record.providerId !== null && (typeof record.providerId !== 'string' || !record.providerId)) {
    throw new Error('operation providerId must be a non-empty string or null');
  }
  if (!record.details || typeof record.details !== 'object' || Array.isArray(record.details)) {
    throw new Error('operation details must be an object');
  }
  assertTimestamp(record.createdAt, 'operation createdAt');
  assertTimestamp(record.updatedAt, 'operation updatedAt');
  return record;
}

function newOperationRecord(operation, operationId = operation.operationId || crypto.randomUUID()) {
  const now = new Date().toISOString();
  return validateOperationRecord({
    operationId,
    type: operation.type,
    state: operation.state || 'planned',
    laneId: operation.laneId ?? null,
    providerId: operation.providerId ?? null,
    details: operation.details || {},
    createdAt: now,
    updatedAt: now,
  }, operationId);
}

function patchedOperationRecord(current, patch) {
  for (const protectedKey of ['operationId', 'type', 'laneId', 'createdAt']) {
    if (patch[protectedKey] !== undefined && patch[protectedKey] !== current[protectedKey]) {
      throw new Error(`cannot change immutable operation field ${protectedKey}`);
    }
  }
  if (patch.providerId !== undefined) {
    if (patch.providerId !== null && (typeof patch.providerId !== 'string' || !patch.providerId)) {
      throw new Error('operation providerId must be a non-empty string or null');
    }
    if (current.providerId !== null && patch.providerId !== current.providerId) {
      throw new Error('cannot change immutable operation field providerId');
    }
  }
  if (patch.details !== undefined) {
    if (!patch.details || typeof patch.details !== 'object' || Array.isArray(patch.details)) {
      throw new Error('operation details must be an object');
    }
    for (const [key, value] of Object.entries(current.details)) {
      if (!(key in patch.details) || !sameJson(patch.details[key], value)) {
        throw new Error(`cannot change immutable operation detail ${key}`);
      }
    }
  }
  return validateOperationRecord({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  }, current.operationId);
}

function beginOperation(repoRoot, operation, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = readJson(paths.registry);
    if (!registry) throw new Error('ownership registry does not exist; run bootstrap first');
    validateRegistry(registry, paths.project);
    const operationId = operation.operationId || crypto.randomUUID();
    const record = newOperationRecord(operation, operationId);
    ensurePrivateStateDirectory(paths.operations);
    const file = operationFile(paths, operationId);
    if (fs.existsSync(file)) throw new Error(`operation already exists: ${operationId}`);
    atomicWriteJson(file, record);
    return record;
  });
}

function updateOperation(repoRoot, operationId, patch, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const file = operationFile(paths, operationId);
    const persisted = readJson(file);
    if (!persisted) throw new Error(`operation does not exist: ${operationId}`);
    const current = validateOperationRecord(persisted, operationId);
    const updated = patchedOperationRecord(current, patch);
    atomicWriteJson(file, updated);
    return updated;
  });
}

function listOperations(repoRoot, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  if (!fs.existsSync(paths.operations)) return [];
  return fs.readdirSync(paths.operations)
    .filter((entry) => UUID_PATTERN.test(entry.slice(0, -5)) && entry.endsWith('.json'))
    .sort()
    .map((entry) => {
      const operationId = entry.slice(0, -5);
      return validateOperationRecord(readJson(path.join(paths.operations, entry)), operationId);
    });
}

function assertSeatClaimAvailable(registry, laneId, claimedPath) {
  if (!path.isAbsolute(claimedPath || '')) throw new Error('lane seat claim requires an absolute path');
  const collision = Object.values(registry.lanes).find((entry) =>
    entry.laneId !== laneId && (entry.seat?.path || entry.seatIntent?.path) === claimedPath &&
    entry.state !== 'worktreeRemoved'
  );
  if (collision) throw new Error(`lane seat is already owned as lane ${collision.laneId}`);
}

function assertSeatAvailable(registry, laneId, seat) {
  if (!seat || typeof seat !== 'object' || Array.isArray(seat) || !path.isAbsolute(seat.path || '')) {
    throw new Error('lane seat requires an absolute path and identity receipt');
  }
  assertSeatClaimAvailable(registry, laneId, seat.path);
}

function reservationRecord(paths, registry, lane, options = {}) {
  if (!lane || typeof lane.laneId !== 'string' || !lane.laneId ||
      typeof lane.backend !== 'string' || !lane.backend ||
      typeof lane.displayName !== 'string' || !lane.displayName) {
    throw new Error('lane reservation requires laneId, backend, and displayName');
  }
  if (lane.seat) assertSeatAvailable(registry, lane.laneId, lane.seat);
  if (lane.seatIntent) assertSeatClaimAvailable(registry, lane.laneId, lane.seatIntent.path);
  const now = new Date().toISOString();
  const record = {
    laneId: lane.laneId,
    backend: lane.backend,
    providerId: null,
    target: lane.target || null,
    displayName: lane.displayName,
    state: lane.state || 'planned',
    operationId: lane.operationId || null,
    turnId: null,
    capabilities: lane.capabilities || {},
    runtime: lane.runtime || null,
    visibility: lane.visibility || null,
    ownership: {
      installationId: registry.installationId,
      projectCommonDir: paths.project.commonDir,
      operationId: lane.operationId || null,
      creationReceipt: null,
    },
    seat: lane.seat || null,
    createdAt: now,
    lastVerifiedAt: null,
    updatedAt: now,
  };
  if (lane.seatIntent !== undefined) record.seatIntent = lane.seatIntent;
  if (lane.lineage !== undefined) record.lineage = lane.lineage;
  if (lane.executionProfile !== undefined) record.executionProfile = lane.executionProfile;
  if (options.pendingOperationId !== undefined) {
    record.pendingOperationId = options.pendingOperationId;
  }
  if (lane.providerIdentity !== undefined) record.providerIdentity = lane.providerIdentity;
  if (lane.spawnIntent !== undefined) record.ownership.spawnIntent = lane.spawnIntent;
  return record;
}

function reserveSpawn(repoRoot, reservation, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = validateRegistry(readJson(paths.registry), paths.project);
    const operationInput = reservation?.operation;
    const laneInput = reservation?.lane;
    if (!operationInput || operationInput.type !== 'spawn' ||
        !UUID_PATTERN.test(operationInput.operationId || '') ||
        !laneInput || laneInput.operationId !== operationInput.operationId ||
        laneInput.laneId !== operationInput.laneId) {
      throw new Error('spawn reservation requires one exact operation and matching lane');
    }
    if (laneInput.seatIntent && laneInput.seat !== undefined && laneInput.seat !== null) {
      throw new Error('managed spawn reservation must be durable before binding its lane seat');
    }
    const prospectiveLane = reservationRecord(paths, registry, laneInput, {
      pendingOperationId: operationInput.operationId,
    });
    ensurePrivateStateDirectory(paths.operations);
    const file = operationFile(paths, operationInput.operationId);
    let operation = readJson(file);
    if (operation) {
      operation = validateOperationRecord(operation, operationInput.operationId);
      const expected = {
        type: operationInput.type,
        state: operationInput.state || 'planned',
        laneId: operationInput.laneId,
        providerId: operationInput.providerId ?? null,
        details: operationInput.details || {},
      };
      for (const key of Object.keys(expected)) {
        if (!sameJson(operation[key], expected[key])) {
          throw new Error(`cannot change immutable spawn reservation field ${key}`);
        }
      }
    } else {
      operation = newOperationRecord(operationInput, operationInput.operationId);
      atomicWriteJson(file, operation);
    }

    const existing = registry.lanes[laneInput.laneId];
    if (existing) {
      const exactRetry = existing.operationId === operation.operationId &&
        existing.pendingOperationId === operation.operationId &&
        existing.backend === laneInput.backend && existing.displayName === laneInput.displayName &&
        existing.providerId === null && sameJson(existing.seat, laneInput.seat || null) &&
        sameJson(existing.seatIntent, laneInput.seatIntent) &&
        sameJson(existing.lineage, laneInput.lineage) &&
        sameJson(existing.executionProfile, laneInput.executionProfile);
      if (!exactRetry) throw new Error(`lane id already exists: ${laneInput.laneId}`);
      return { operation, lane: existing };
    }
    const lane = prospectiveLane;
    registry.lanes[lane.laneId] = lane;
    writeRegistry(paths, registry);
    return { operation, lane };
  });
}

function bindLaneSeat(repoRoot, laneId, operationId, seat, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = validateRegistry(readJson(paths.registry), paths.project);
    const lane = registry.lanes[laneId];
    if (!lane) throw new Error(`lane is not owned: ${laneId}`);
    if (lane.pendingOperationId !== operationId || lane.operationId !== operationId) {
      throw new Error(`operation ${operationId} is not the pending spawn for lane ${laneId}`);
    }
    assertSeatAvailable(registry, laneId, seat);
    if (lane.seatIntent) {
      for (const key of ['path', 'worktreesRoot', 'gitCommonDir', 'branchRef', 'managed']) {
        if (seat[key] !== lane.seatIntent[key]) {
          throw new Error(`lane seat does not match its immutable intent (${key})`);
        }
      }
      if (seat.head !== lane.seatIntent.baseCommit) {
        throw new Error('lane seat does not match its immutable intent (baseCommit)');
      }
    }
    if (lane.seat !== null) {
      if (!sameJson(lane.seat, seat)) throw new Error('cannot change immutable lane field seat');
      return lane;
    }
    const file = operationFile(paths, operationId);
    const operation = validateOperationRecord(readJson(file), operationId);
    if (operation.laneId !== laneId || operation.type !== 'spawn') {
      throw new Error(`operation ${operationId} is not the spawn journal for lane ${laneId}`);
    }
    if (operation.details.seat !== undefined && !sameJson(operation.details.seat, seat)) {
      throw new Error('operation journal contains a different lane seat');
    }
    const updatedOperation = patchedOperationRecord(operation, {
      state: operation.state === 'planned' ? 'seatReady' : operation.state,
      details: { ...operation.details, seat },
    });
    atomicWriteJson(file, updatedOperation);
    const updated = { ...lane, seat, updatedAt: new Date().toISOString() };
    registry.lanes[laneId] = updated;
    writeRegistry(paths, registry);
    return updated;
  });
}

function beginLaneOperation(repoRoot, laneId, operation, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = validateRegistry(readJson(paths.registry), paths.project);
    const lane = registry.lanes[laneId];
    if (!lane) throw new Error(`lane is not owned: ${laneId}`);
    if (lane.pendingOperationId) {
      throw new Error(`lane ${laneId} already has pending operation ${lane.pendingOperationId}`);
    }
    if (operation.laneId !== undefined && operation.laneId !== laneId) {
      throw new Error(`operation laneId does not match lane ${laneId}`);
    }
    const record = newOperationRecord({ ...operation, laneId });
    ensurePrivateStateDirectory(paths.operations);
    const file = operationFile(paths, record.operationId);
    if (fs.existsSync(file)) throw new Error(`operation already exists: ${record.operationId}`);
    atomicWriteJson(file, record);
    registry.lanes[laneId] = {
      ...lane,
      pendingOperationId: record.operationId,
      updatedAt: new Date().toISOString(),
    };
    writeRegistry(paths, registry);
    return record;
  });
}

function pendingOperationForLane(repoRoot, laneId, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = validateRegistry(readJson(paths.registry), paths.project);
    const lane = registry.lanes[laneId];
    if (!lane) throw new Error(`lane is not owned: ${laneId}`);
    if (!lane.pendingOperationId) return null;
    const operation = validateOperationRecord(
      readJson(operationFile(paths, lane.pendingOperationId)), lane.pendingOperationId,
    );
    if (operation.laneId !== laneId) {
      throw new Error(`pending operation ${operation.operationId} belongs to another lane`);
    }
    return operation;
  });
}

function updatePendingLaneOperation(repoRoot, laneId, operationId, patch, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = validateRegistry(readJson(paths.registry), paths.project);
    const lane = registry.lanes[laneId];
    if (!lane) throw new Error(`lane is not owned: ${laneId}`);
    if (lane.pendingOperationId !== operationId) {
      throw new Error(`operation ${operationId} is not pending for lane ${laneId}`);
    }
    const file = operationFile(paths, operationId);
    const current = validateOperationRecord(readJson(file), operationId);
    if (current.laneId !== laneId) throw new Error(`operation ${operationId} belongs to another lane`);
    const updated = patchedOperationRecord(current, patch);
    atomicWriteJson(file, updated);
    return updated;
  });
}

function completeLaneOperation(repoRoot, laneId, operationId, patch = {}, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = validateRegistry(readJson(paths.registry), paths.project);
    const lane = registry.lanes[laneId];
    if (!lane) throw new Error(`lane is not owned: ${laneId}`);
    const file = operationFile(paths, operationId);
    const current = validateOperationRecord(readJson(file), operationId);
    if (current.laneId !== laneId) throw new Error(`operation ${operationId} belongs to another lane`);
    if (lane.pendingOperationId !== operationId) {
      const expectedState = patch.state || 'complete';
      const exactRetry = !lane.pendingOperationId && current.state === expectedState &&
        Object.entries(patch).every(([key, value]) => sameJson(current[key], value));
      if (!exactRetry) throw new Error(`operation ${operationId} is not pending for lane ${laneId}`);
      return current;
    }
    const updated = patchedOperationRecord(current, { ...patch, state: patch.state || 'complete' });
    atomicWriteJson(file, updated);
    registry.lanes[laneId] = {
      ...lane,
      pendingOperationId: null,
      updatedAt: new Date().toISOString(),
    };
    writeRegistry(paths, registry);
    return updated;
  });
}

function settleTerminalLaneOperationPointer(repoRoot, laneId, env = process.env) {
  const pending = pendingOperationForLane(repoRoot, laneId, env);
  if (!pending || !TERMINAL_OPERATION_STATES.has(pending.state)) return null;
  return completeLaneOperation(
    repoRoot,
    laneId,
    pending.operationId,
    { state: pending.state },
    env,
  );
}

function registerLane(repoRoot, lane, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const existing = readJson(paths.registry);
    const registry = existing ? validateRegistry(existing, paths.project) : newRegistry(paths.project);
    if (!lane || typeof lane.backend !== 'string' || typeof lane.providerId !== 'string' ||
        !lane.providerId || typeof lane.displayName !== 'string' || !lane.displayName) {
      throw new Error('lane requires backend, providerId, and displayName');
    }
    const collision = Object.values(registry.lanes).find((entry) =>
      entry.backend === lane.backend && entry.providerId === lane.providerId
    );
    if (collision) throw new Error(`provider resource is already owned as lane ${collision.laneId}`);
    if (lane.seat?.path) assertSeatAvailable(registry, lane.laneId || null, lane.seat);

    const laneId = lane.laneId || crypto.randomUUID();
    if (registry.lanes[laneId]) throw new Error(`lane id already exists: ${laneId}`);
    const now = new Date().toISOString();
    const record = {
      laneId,
      backend: lane.backend,
      providerId: lane.providerId,
      target: lane.target || null,
      displayName: lane.displayName,
      state: lane.state || 'created',
      operationId: lane.operationId || null,
      turnId: lane.turnId || null,
      capabilities: lane.capabilities || {},
      runtime: lane.runtime || null,
      visibility: lane.visibility || null,
      ownership: {
        installationId: registry.installationId,
        projectCommonDir: paths.project.commonDir,
        operationId: lane.operationId || null,
        creationReceipt: lane.creationReceipt || null,
      },
      seat: lane.seat || null,
      createdAt: now,
      lastVerifiedAt: lane.lastVerifiedAt || null,
      updatedAt: now,
    };
    if (lane.seatIntent !== undefined) record.seatIntent = lane.seatIntent;
    if (lane.lineage !== undefined) record.lineage = lane.lineage;
    if (lane.executionProfile !== undefined) record.executionProfile = lane.executionProfile;
    if (lane.providerIdentity !== undefined) record.providerIdentity = lane.providerIdentity;
    registry.lanes[laneId] = record;
    ensurePrivateStateDirectory(paths.operations);
    writeRegistry(paths, registry);
    return record;
  });
}

function reserveLane(repoRoot, lane, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = validateRegistry(readJson(paths.registry), paths.project);
    const record = reservationRecord(paths, registry, lane);
    if (registry.lanes[lane.laneId]) throw new Error(`lane id already exists: ${lane.laneId}`);
    registry.lanes[record.laneId] = record;
    writeRegistry(paths, registry);
    return record;
  });
}

function bindLaneProvider(repoRoot, laneId, providerId, patch = {}, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = validateRegistry(readJson(paths.registry), paths.project);
    const current = registry.lanes[laneId];
    if (!current) throw new Error(`lane is not owned: ${laneId}`);
    if (current.backend === CLAUDE_BACKEND) {
      throw new Error('Claude lanes require bindClaudeProviderIdentity');
    }
    assertExactKeys(patch, new Set(['state', 'runtime', 'ownership']), 'provider binding patch');
    if (current.providerId && current.providerId !== providerId) {
      throw new Error(`cannot change immutable lane field providerId`);
    }
    if (typeof providerId !== 'string' || !providerId) throw new Error('provider id is required');
    if (patch.providerIdentity !== undefined &&
        !sameJson(patch.providerIdentity, current.providerIdentity)) {
      throw new Error('cannot change immutable lane field providerIdentity through bindLaneProvider');
    }
    if (current.runtime?.endpoint && patch.runtime?.endpoint &&
        current.runtime.endpoint !== patch.runtime.endpoint) {
      throw new Error('provider runtime endpoint does not match the lane reservation');
    }
    if (patch.seat !== undefined && !sameJson(patch.seat, current.seat)) {
      throw new Error('cannot change immutable lane field seat through bindLaneProvider');
    }
    if (patch.ownership !== undefined) {
      assertExactKeys(patch.ownership, new Set(['creationReceipt']), 'provider binding ownership patch');
      for (const key of ['installationId', 'projectCommonDir', 'operationId', 'spawnIntent']) {
        if (patch.ownership[key] !== undefined &&
            !sameJson(patch.ownership[key], current.ownership[key])) {
          throw new Error(`cannot change immutable lane ownership field ${key}`);
        }
      }
      if (current.ownership.creationReceipt !== null &&
          patch.ownership.creationReceipt !== undefined &&
          !sameJson(patch.ownership.creationReceipt, current.ownership.creationReceipt)) {
        throw new Error('cannot change immutable lane ownership field creationReceipt');
      }
    }
    if (current.providerId) {
      if (patch.state !== undefined && patch.state !== current.state) {
        throw new Error('cannot change lane state through an idempotent provider bind');
      }
      if (patch.runtime !== undefined && !sameJson(patch.runtime, current.runtime)) {
        throw new Error('cannot change immutable lane runtime through an idempotent provider bind');
      }
    }
    const collision = Object.values(registry.lanes).find((entry) =>
      entry.laneId !== laneId && entry.backend === current.backend && entry.providerId === providerId
    );
    if (collision) throw new Error(`provider resource is already owned as lane ${collision.laneId}`);
    const now = new Date().toISOString();
    const updated = {
      ...current,
      ...patch,
      laneId: current.laneId,
      backend: current.backend,
      providerId,
      createdAt: current.createdAt,
      ownership: {
        ...current.ownership,
        ...(patch.ownership || {}),
      },
      updatedAt: now,
    };
    assertLaneTransition(current.state, updated.state);
    registry.lanes[laneId] = updated;
    writeRegistry(paths, registry);
    return updated;
  });
}

function bindClaudeSpawnObservation(repoRoot, laneId, binding, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = validateRegistry(readJson(paths.registry), paths.project);
    const current = registry.lanes[laneId];
    if (!current) throw new Error(`lane is not owned: ${laneId}`);
    if (current.backend !== CLAUDE_BACKEND || current.providerIdentity?.version !== 1) {
      throw new Error(`lane ${laneId} has no Claude provider identity reservation`);
    }
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      throw new Error('Claude spawn observation must be an object');
    }
    assertExactKeys(binding, new Set([
      'sessionId', 'jobId', 'bridgeId', 'creationReceipt', 'bridgeReceipt', 'epoch',
    ]), 'Claude spawn observation');
    const sessionId = binding?.sessionId;
    const jobId = binding?.jobId;
    const bridgeId = binding?.bridgeId;
    if (!UUID_PATTERN.test(sessionId || '') || !CLAUDE_JOB_PATTERN.test(jobId || '') ||
        sessionId !== sessionId.toLowerCase() || jobId !== jobId.toLowerCase() ||
        sessionId.slice(0, 8) !== jobId) {
      throw new Error('Claude spawn observation requires a matching session UUID and job id');
    }
    if (!CLAUDE_BRIDGE_PATTERN.test(bridgeId || '')) throw new Error('Claude bridge id is invalid');
    assertReceipt(binding.creationReceipt, 'Claude creation receipt');
    assertReceipt(binding.bridgeReceipt, 'Claude bridge receipt');
    if (!binding.epoch || typeof binding.epoch !== 'object' || Array.isArray(binding.epoch) ||
        binding.epoch.ordinal !== undefined) {
      throw new Error('Claude spawn observation requires an execution epoch without an ordinal');
    }
    const epoch = { ...binding.epoch, ordinal: 1 };
    validateExecutionEpoch(epoch, 1);

    const identity = current.providerIdentity;
    const immutableMismatch = (current.providerId && current.providerId !== sessionId) ||
      (identity.sessionId && identity.sessionId !== sessionId) ||
      (identity.jobId && identity.jobId !== jobId) ||
      (identity.bridgeId && identity.bridgeId !== bridgeId);
    if (immutableMismatch) throw new Error('cannot change immutable Claude provider identity');
    if (identity.executionEpochs.length > 0 && !sameJson(identity.executionEpochs[0], epoch)) {
      throw new Error('cannot change immutable Claude execution epoch');
    }
    const fullyBound = current.providerId === sessionId && identity.sessionId === sessionId &&
      identity.jobId === jobId && identity.bridgeId === bridgeId && identity.executionEpochs.length >= 1;
    if (fullyBound) {
      if (!sameJson(binding.creationReceipt, current.ownership.creationReceipt) ||
          !sameJson(binding.bridgeReceipt, current.ownership.bridgeReceipt)) {
        throw new Error('cannot change immutable Claude spawn observation receipts');
      }
      return current;
    }
    if (!['planned', 'created', 'deliveryUnknown'].includes(current.state)) {
      throw new Error(`cannot bind Claude spawn observation from lane state ${current.state}`);
    }
    const collision = Object.values(registry.lanes).find((entry) =>
      entry.laneId !== laneId && entry.backend === current.backend &&
      (entry.providerId === sessionId || entry.providerIdentity?.jobId === jobId ||
       entry.providerIdentity?.bridgeId === bridgeId)
    );
    if (collision) throw new Error(`Claude provider is already owned as lane ${collision.laneId}`);

    const operationId = current.operationId;
    const operationFilePath = operationFile(paths, operationId);
    const operation = validateOperationRecord(readJson(operationFilePath), operationId);
    if (operation.laneId !== laneId || operation.type !== 'spawn') {
      throw new Error(`operation ${operationId} is not the spawn journal for lane ${laneId}`);
    }
    const updatedOperation = patchedOperationRecord(operation, {
      providerId: sessionId,
      state: ['planned', 'dispatching', 'spawnUnknown'].includes(operation.state)
        ? 'providerObserved'
        : operation.state,
    });
    atomicWriteJson(operationFilePath, updatedOperation);

    const nextState = 'created';
    assertLaneTransition(current.state, nextState);
    const updated = {
      ...current,
      providerId: sessionId,
      providerIdentity: {
        ...identity,
        sessionId,
        jobId,
        bridgeId,
        executionEpochs: [epoch],
      },
      ownership: {
        ...current.ownership,
        creationReceipt: binding.creationReceipt,
        bridgeReceipt: binding.bridgeReceipt,
      },
      state: nextState,
      updatedAt: new Date().toISOString(),
    };
    registry.lanes[laneId] = updated;
    writeRegistry(paths, registry);
    return updated;
  });
}

function bindClaudeProviderIdentity(repoRoot, laneId, binding, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = validateRegistry(readJson(paths.registry), paths.project);
    const current = registry.lanes[laneId];
    if (!current) throw new Error(`lane is not owned: ${laneId}`);
    if (current.backend !== CLAUDE_BACKEND) throw new Error(`lane ${laneId} is not a Claude lane`);
    if (current.providerIdentity === undefined || current.providerIdentity.version !== 1) {
      throw new Error(`lane ${laneId} has no Claude provider identity reservation`);
    }
    const sessionId = binding?.sessionId;
    const jobId = binding?.jobId;
    if (!UUID_PATTERN.test(sessionId || '') || !CLAUDE_JOB_PATTERN.test(jobId || '') ||
        sessionId !== sessionId.toLowerCase() || jobId !== jobId.toLowerCase() ||
        sessionId.slice(0, 8) !== jobId) {
      throw new Error('Claude provider binding requires a matching session UUID and job id');
    }
    assertReceipt(binding?.creationReceipt, 'Claude creation receipt');
    const identity = current.providerIdentity;
    if ((current.providerId && current.providerId !== sessionId) ||
        (identity.sessionId && identity.sessionId !== sessionId) ||
        (identity.jobId && identity.jobId !== jobId)) {
      throw new Error('cannot change immutable Claude provider identity');
    }
    if (current.providerId === sessionId && identity.sessionId === sessionId && identity.jobId === jobId) {
      if (!sameJson(binding.creationReceipt, current.ownership.creationReceipt)) {
        throw new Error('cannot change immutable Claude creation receipt');
      }
      return current;
    }
    if (!['planned', 'deliveryUnknown'].includes(current.state)) {
      throw new Error(`cannot bind Claude provider identity from lane state ${current.state}`);
    }
    const collision = Object.values(registry.lanes).find((entry) =>
      entry.laneId !== laneId && entry.backend === current.backend &&
      (entry.providerId === sessionId || entry.providerIdentity?.jobId === jobId)
    );
    if (collision) throw new Error(`Claude provider is already owned as lane ${collision.laneId}`);
    const updated = {
      ...current,
      providerId: sessionId,
      providerIdentity: { ...identity, sessionId, jobId },
      ownership: {
        ...current.ownership,
        creationReceipt: binding.creationReceipt,
      },
      updatedAt: new Date().toISOString(),
    };
    registry.lanes[laneId] = updated;
    writeRegistry(paths, registry);
    return updated;
  });
}

function bindLaneProviderBridge(repoRoot, laneId, bridgeId, receipt, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = validateRegistry(readJson(paths.registry), paths.project);
    const current = registry.lanes[laneId];
    if (!current) throw new Error(`lane is not owned: ${laneId}`);
    if (current.backend !== CLAUDE_BACKEND || RETIRED_LANE_STATES.has(current.state)) {
      throw new Error(`lane ${laneId} cannot bind a Claude bridge from state ${current.state}`);
    }
    if (!current.providerIdentity?.sessionId || !current.providerIdentity?.jobId) {
      throw new Error('Claude provider session must be bound before its bridge');
    }
    if (!CLAUDE_BRIDGE_PATTERN.test(bridgeId || '')) throw new Error('Claude bridge id is invalid');
    assertReceipt(receipt, 'Claude bridge receipt');
    if (current.providerIdentity.bridgeId && current.providerIdentity.bridgeId !== bridgeId) {
      throw new Error('cannot change immutable Claude bridge id');
    }
    if (current.providerIdentity.bridgeId === bridgeId) {
      if (!sameJson(receipt, current.ownership.bridgeReceipt)) {
        throw new Error('cannot change immutable Claude bridge receipt');
      }
      return current;
    }
    const collision = Object.values(registry.lanes).find((entry) =>
      entry.laneId !== laneId && entry.backend === current.backend &&
      entry.providerIdentity?.bridgeId === bridgeId
    );
    if (collision) throw new Error(`Claude bridge is already owned as lane ${collision.laneId}`);
    const updated = {
      ...current,
      providerIdentity: { ...current.providerIdentity, bridgeId },
      ownership: {
        ...current.ownership,
        bridgeReceipt: receipt,
      },
      updatedAt: new Date().toISOString(),
    };
    registry.lanes[laneId] = updated;
    writeRegistry(paths, registry);
    return updated;
  });
}

function appendLaneExecutionEpoch(repoRoot, laneId, epoch, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = validateRegistry(readJson(paths.registry), paths.project);
    const current = registry.lanes[laneId];
    if (!current) throw new Error(`lane is not owned: ${laneId}`);
    if (current.backend !== CLAUDE_BACKEND || RETIRED_LANE_STATES.has(current.state)) {
      throw new Error(`lane ${laneId} cannot record a Claude execution epoch from state ${current.state}`);
    }
    if (!current.providerIdentity?.sessionId || !current.providerIdentity?.jobId ||
        !current.providerIdentity?.bridgeId) {
      throw new Error('Claude provider identity must be fully bound before recording an execution epoch');
    }
    if (!epoch || typeof epoch !== 'object' || Array.isArray(epoch) || epoch.ordinal !== undefined) {
      throw new Error('Claude execution epoch input must omit ordinal');
    }
    const existing = current.providerIdentity.executionEpochs.find((entry) => entry.epochId === epoch.epochId);
    if (existing) {
      const retry = { ...epoch, ordinal: existing.ordinal };
      if (!sameJson(retry, existing)) throw new Error('cannot change immutable Claude execution epoch');
      return current;
    }
    const next = { ...epoch, ordinal: current.providerIdentity.executionEpochs.length + 1 };
    validateExecutionEpoch(next, next.ordinal);
    const updated = {
      ...current,
      providerIdentity: {
        ...current.providerIdentity,
        executionEpochs: [...current.providerIdentity.executionEpochs, next],
      },
      updatedAt: new Date().toISOString(),
    };
    registry.lanes[laneId] = updated;
    writeRegistry(paths, registry);
    return updated;
  });
}

function rebindClaudeRuntime(repoRoot, laneId, transition, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = validateRegistry(readJson(paths.registry), paths.project);
    const current = registry.lanes[laneId];
    if (!current) throw new Error(`lane is not owned: ${laneId}`);
    if (current.backend !== CLAUDE_BACKEND || RETIRED_LANE_STATES.has(current.state)) {
      throw new Error(`lane ${laneId} cannot rebind a Claude runtime from state ${current.state}`);
    }
    if (!current.providerIdentity?.sessionId || !current.providerIdentity?.jobId ||
        !current.providerIdentity?.bridgeId || !current.runtime) {
      throw new Error('Claude provider identity must be fully bound before rebinding its runtime');
    }
    if (!transition || typeof transition !== 'object' || Array.isArray(transition)) {
      throw new Error('Claude runtime transition must be an object');
    }
    assertExactKeys(transition, new Set([
      'transitionId', 'fromCliSha256', 'runtime', 'worker', 'epoch', 'observedAt',
    ]), 'Claude runtime transition');
    if (!UUID_PATTERN.test(transition.transitionId || '')) {
      throw new Error('Claude runtime transition requires a UUID');
    }
    const runtimeEpochs = current.providerIdentity.runtimeEpochs || [];
    const existing = runtimeEpochs.find((entry) => entry.transitionId === transition.transitionId);
    if (existing) {
      const execution = current.providerIdentity.executionEpochs[existing.executionEpochOrdinal - 1];
      const retry = {
        transitionId: transition.transitionId,
        ordinal: existing.ordinal,
        fromCliSha256: transition.fromCliSha256,
        runtime: transition.runtime,
        worker: transition.worker,
        executionEpochOrdinal: existing.executionEpochOrdinal,
        observedAt: transition.observedAt,
      };
      const retryEpoch = { ...transition.epoch, ordinal: existing.executionEpochOrdinal };
      if (!sameJson(retry, existing) || !sameJson(retryEpoch, execution)) {
        throw new Error('cannot change immutable Claude runtime transition');
      }
      return current;
    }
    const priorRuntime = runtimeEpochs.at(-1)?.runtime || current.runtime;
    validateClaudeRuntime(priorRuntime, 'current Claude runtime');
    validateClaudeRuntime(transition.runtime, 'next Claude runtime');
    if (transition.fromCliSha256 !== priorRuntime.cliSha256) {
      throw new Error('Claude runtime transition does not continue the current runtime');
    }
    if (!sameClaudeRuntimeIdentity(priorRuntime, transition.runtime)) {
      throw new Error('Claude runtime transition changes the immutable provider identity');
    }
    if (transition.runtime.cliSha256 === priorRuntime.cliSha256) {
      throw new Error('Claude runtime transition must bind a different build');
    }
    if (!transition.worker || typeof transition.worker !== 'object' ||
        Array.isArray(transition.worker)) {
      throw new Error('Claude runtime transition requires a worker receipt');
    }
    assertExactKeys(transition.worker, new Set(['path', 'sha256']), 'Claude runtime transition worker');
    if (transition.worker.path !== transition.runtime.cliPath ||
        transition.worker.sha256 !== transition.runtime.cliSha256) {
      throw new Error('Claude runtime transition worker does not match the next runtime');
    }
    if (!transition.epoch || typeof transition.epoch !== 'object' ||
        Array.isArray(transition.epoch) || transition.epoch.ordinal !== undefined) {
      throw new Error('Claude runtime transition requires an execution epoch without an ordinal');
    }
    const executionEpochOrdinal = current.providerIdentity.executionEpochs.length + 1;
    const epoch = { ...transition.epoch, ordinal: executionEpochOrdinal };
    validateExecutionEpoch(epoch, executionEpochOrdinal);
    const previousEpoch = current.providerIdentity.executionEpochs.at(-1);
    if (previousEpoch && previousEpoch.pid === epoch.pid &&
        previousEpoch.processBirth === epoch.processBirth &&
        sameJson(previousEpoch.socket, epoch.socket)) {
      throw new Error('Claude runtime transition did not bind a new execution epoch');
    }
    assertTimestamp(transition.observedAt, 'Claude runtime transition observedAt');
    const runtimeEpoch = {
      transitionId: transition.transitionId,
      ordinal: runtimeEpochs.length + 1,
      fromCliSha256: transition.fromCliSha256,
      runtime: transition.runtime,
      worker: transition.worker,
      executionEpochOrdinal,
      observedAt: transition.observedAt,
    };
    const updated = {
      ...current,
      providerIdentity: {
        ...current.providerIdentity,
        executionEpochs: [...current.providerIdentity.executionEpochs, epoch],
        runtimeEpochs: [...runtimeEpochs, runtimeEpoch],
      },
      lastVerifiedAt: transition.observedAt,
      updatedAt: new Date().toISOString(),
    };
    registry.lanes[laneId] = updated;
    writeRegistry(paths, registry);
    return updated;
  });
}

function observeLaneStopped(repoRoot, laneId, observation, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = validateRegistry(readJson(paths.registry), paths.project);
    const current = registry.lanes[laneId];
    if (!current) throw new Error(`lane is not owned: ${laneId}`);
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
      throw new Error('observed stop requires a durable observation');
    }
    assertExactKeys(observation, new Set(['observationId', 'observedAt', 'receipt']), 'observed stop');
    if (!UUID_PATTERN.test(observation.observationId || '')) {
      throw new Error('observed stop requires a UUID observationId');
    }
    assertTimestamp(observation.observedAt, 'observed stop observedAt');
    assertReceipt(observation.receipt, 'observed stop receipt');
    const existing = (current.observedStops || []).find((entry) =>
      entry.observationId === observation.observationId
    );
    if (existing) {
      const retry = { ...observation, fromState: existing.fromState };
      if (!sameJson(existing, retry)) throw new Error('cannot change immutable observed-stop record');
      if (current.state !== 'stopped') {
        throw new Error('observed-stop receipt exists but lane is not stopped');
      }
      return current;
    }
    if (current.state === 'stopped') {
      throw new Error('lane is already stopped without this observation receipt');
    }
    const allowed = new Set([
      'created', 'materialized', 'named', 'active', 'idle', 'interruptRequested',
      'stopRequested', 'recoverRequested', 'deliveryUnknown',
    ]);
    if (!allowed.has(current.state)) {
      throw new Error(`cannot record an observed stop from lane state ${current.state}`);
    }
    const record = { ...observation, fromState: current.state };
    const updated = {
      ...current,
      state: 'stopped',
      observedStops: [...(current.observedStops || []), record],
      lastVerifiedAt: observation.observedAt,
      updatedAt: new Date().toISOString(),
    };
    registry.lanes[laneId] = updated;
    writeRegistry(paths, registry);
    return updated;
  });
}

function mutateLane(repoRoot, laneId, callback, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = validateRegistry(readJson(paths.registry), paths.project);
    const current = registry.lanes[laneId];
    if (!current) throw new Error(`lane is not owned: ${laneId}`);
    const mutation = callback(structuredClone(current));
    if (!mutation || !mutation.patch) throw new Error('lane mutation callback must return a patch');
    for (const protectedKey of [
      'laneId', 'backend', 'providerId', 'providerIdentity', 'pendingOperationId', 'createdAt',
    ]) {
      if (mutation.patch[protectedKey] !== undefined &&
          mutation.patch[protectedKey] !== current[protectedKey]) {
        throw new Error(`cannot change immutable lane field ${protectedKey}`);
      }
    }
    for (const protectedKey of [
      'seat', 'seatIntent', 'runtime', 'ownership', 'observedStops', 'lineage', 'executionProfile',
    ]) {
      if (mutation.patch[protectedKey] !== undefined &&
          !sameJson(mutation.patch[protectedKey], current[protectedKey])) {
        throw new Error(`cannot change immutable lane field ${protectedKey}`);
      }
    }
    if (mutation.patch.state !== undefined) assertLaneTransition(current.state, mutation.patch.state);
    const updated = { ...current, ...mutation.patch, updatedAt: new Date().toISOString() };
    registry.lanes[laneId] = updated;
    writeRegistry(paths, registry);
    return { lane: updated, value: mutation.value };
  });
}

function updateLane(repoRoot, laneId, patch, env = process.env) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const registry = validateRegistry(readJson(paths.registry), paths.project);
    const current = registry.lanes[laneId];
    if (!current) throw new Error(`lane is not owned: ${laneId}`);
    for (const protectedKey of [
      'laneId', 'backend', 'providerId', 'providerIdentity', 'pendingOperationId', 'createdAt',
    ]) {
      if (patch[protectedKey] !== undefined && patch[protectedKey] !== current[protectedKey]) {
        throw new Error(`cannot change immutable lane field ${protectedKey}`);
      }
    }
    for (const protectedKey of [
      'seat', 'seatIntent', 'runtime', 'ownership', 'observedStops', 'lineage', 'executionProfile',
    ]) {
      if (patch[protectedKey] !== undefined && !sameJson(patch[protectedKey], current[protectedKey])) {
        throw new Error(`cannot change immutable lane field ${protectedKey}`);
      }
    }
    if (patch.state !== undefined) assertLaneTransition(current.state, patch.state);
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    registry.lanes[laneId] = updated;
    writeRegistry(paths, registry);
    return updated;
  });
}

function listLanes(repoRoot, env = process.env) {
  return Object.values(readRegistry(repoRoot, env).registry.lanes);
}

function ownedProviderLane(repoRoot, backend, providerId, env = process.env) {
  if (!providerId) return null;
  return listLanes(repoRoot, env).find((lane) =>
    lane.backend === backend && lane.providerId === providerId
  ) || null;
}

function requireOwnedLane(repoRoot, laneId, env = process.env) {
  if (!laneId) throw new Error('lane id is required');
  const lane = listLanes(repoRoot, env).find((entry) => entry.laneId === laneId);
  if (!lane) throw new Error(`NOT_OWNED: lane ${laneId}`);
  return lane;
}

function requireOwnedProviderLane(repoRoot, backend, providerId, env = process.env) {
  const lane = ownedProviderLane(repoRoot, backend, providerId, env);
  if (!lane) throw new Error(`NOT_OWNED: ${backend} resource ${providerId}`);
  return lane;
}

function activeLanes(repoRoot, backend, env = process.env) {
  return listLanes(repoRoot, env).filter((lane) =>
    lane.backend === backend && ACTIVE_LANE_STATES.has(lane.state) && !RETIRED_LANE_STATES.has(lane.state)
  );
}

module.exports = {
  ACTIVE_LANE_STATES,
  LANE_TRANSITIONS,
  RETIRED_LANE_STATES,
  SCHEMA_VERSION,
  TERMINAL_OPERATION_STATES,
  acquireLock,
  activeLanes,
  appendLaneExecutionEpoch,
  rebindClaudeRuntime,
  atomicWriteJson,
  beginLaneOperation,
  beginOperation,
  bindClaudeProviderIdentity,
  bindClaudeSpawnObservation,
  bindLaneSeat,
  bindLaneProvider,
  bindLaneProviderBridge,
  completeLaneOperation,
  ensureRegistry,
  listLanes,
  listOperations,
  mutateLane,
  observeLaneStopped,
  ownedProviderLane,
  pendingOperationForLane,
  processBirth,
  processMatches,
  projectPaths,
  readRegistry,
  registerLane,
  reserveLane,
  reserveSpawn,
  releaseLock,
  requireOwnedLane,
  requireOwnedProviderLane,
  resolveProject,
  settleTerminalLaneOperationPointer,
  stateRoot,
  updateLane,
  updateOperation,
  updatePendingLaneOperation,
  withLaneLease,
  withProjectLock,
};
