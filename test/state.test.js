'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const test = require('node:test');
const {
  ABANDONABLE_OPERATION_TYPES,
  LANE_TRANSITIONS,
  OPERATION_SCHEMA_VERSION,
  OPERATION_STATES,
  OPERATION_TYPES,
  abandonPendingLaneOperation,
  appendLaneExecutionEpoch,
  ensureRegistry,
  acquireLock,
  beginLaneOperation,
  beginOperation,
  bindClaudeSpawnObservation,
  bindLaneSeat,
  bindLaneProvider,
  completeLaneOperation,
  listLanes,
  listOperations,
  mutateLane,
  observeLaneStopped,
  pendingOperationForLane,
  processMatches,
  projectPaths,
  readRegistry,
  resolveProject,
  rebindClaudeRuntime,
  registerLane,
  releaseLock,
  reserveSpawn,
  requireOwnedLane,
  requireOwnedProviderLane,
  settleTerminalLaneOperationPointer,
  updateLane,
  updateOperation,
  updatePendingLaneOperation,
} = require('../scripts/lib/state');
const { createStateFixture } = require('./helpers/state-fixture');

function claudeSpawnIntent(operationId, displayName, suffix) {
  return {
    operationId,
    spawnNonce: `${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}-${suffix}${suffix}${suffix}${suffix}-4${suffix}${suffix}${suffix}-8${suffix}${suffix}${suffix}-${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}`,
    displayName,
    promptSha256: 'a'.repeat(64),
    promptMarkerSha256: 'b'.repeat(64),
    preflightSessionIds: [],
    stdoutPath: `/tmp/${suffix}-stdout`,
    stderrPath: `/tmp/${suffix}-stderr`,
  };
}

function claudeRuntimeReceipt() {
  return {
    protocolGeneration: 1,
    platform: 'darwin',
    arch: 'arm64',
    cliPath: '/tmp/claude-test',
    cliVersion: '2.1.258',
    cliSha256: 'c'.repeat(64),
    configDir: '/tmp/claude-config',
    configDevice: 1,
    configInode: 2,
    projectsDirectory: '/tmp/claude-config/projects',
    projectsDevice: 1,
    projectsInode: 3,
    accountFingerprint: 'd'.repeat(64),
  };
}

test('registry is outside the repository and binds to canonical Git identity', (t) => {
  const fixture = createStateFixture(t);
  const { paths, registry } = ensureRegistry(fixture.repoRoot, fixture.env);
  assert.equal(paths.registry.startsWith(`${fixture.repoRoot}${path.sep}`), false);
  assert.equal(registry.project.root, fs.realpathSync(fixture.repoRoot));
  assert.equal(registry.project.commonDir, fs.realpathSync(path.join(fixture.repoRoot, '.git')));
});

test('repository identity ignores ambient Git repository redirection', (t) => {
  const fixture = createStateFixture(t);
  const other = path.join(fixture.root, 'other-repo');
  fs.mkdirSync(other);
  execFileSync('git', ['init', '--quiet', other]);
  const poisoned = {
    GIT_DIR: path.join(other, '.git'),
    GIT_WORK_TREE: fixture.repoRoot,
    GIT_COMMON_DIR: path.join(other, '.git'),
    GIT_INDEX_FILE: path.join(other, '.git', 'index'),
    GIT_OBJECT_DIRECTORY: path.join(other, '.git', 'objects'),
  };
  const original = Object.fromEntries(Object.keys(poisoned).map((key) => [key, process.env[key]]));
  Object.assign(process.env, poisoned);
  try {
    const project = resolveProject(fixture.repoRoot);
    assert.equal(project.root, fs.realpathSync(fixture.repoRoot));
    assert.equal(project.commonDir, fs.realpathSync(path.join(fixture.repoRoot, '.git')));
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('exact backend and provider id establish ownership; names and prefixes do not', (t) => {
  const fixture = createStateFixture(t);
  const lane = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'thread-123456',
    displayName: '[test] collision-friendly name',
    state: 'active',
  }, fixture.env);
  assert.equal(
    requireOwnedProviderLane(fixture.repoRoot, 'codex-app-server', 'thread-123456', fixture.env).laneId,
    lane.laneId,
  );
  assert.throws(() => {
    requireOwnedProviderLane(fixture.repoRoot, 'codex-app-server', 'thread-123', fixture.env);
  }, /NOT_OWNED/);
  assert.throws(() => {
    requireOwnedProviderLane(fixture.repoRoot, 'codex-native', 'thread-123456', fixture.env);
  }, /NOT_OWNED/);
});

test('lane provider identity is immutable and state updates are atomic', (t) => {
  const fixture = createStateFixture(t);
  const lane = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'thread-1',
    displayName: '[test] lane',
  }, fixture.env);
  updateLane(fixture.repoRoot, lane.laneId, { state: 'retireRequested' }, fixture.env);
  const updated = updateLane(fixture.repoRoot, lane.laneId, {
    state: 'archivedVerified',
    lastVerifiedAt: '2026-09-01T00:00:00.000Z',
  }, fixture.env);
  assert.equal(updated.state, 'archivedVerified');
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'archivedVerified');
  assert.throws(() => {
    updateLane(fixture.repoRoot, lane.laneId, { providerId: 'thread-2' }, fixture.env);
  }, /immutable/);
});

test('two live lane records cannot claim the same worktree seat', (t) => {
  const fixture = createStateFixture(t);
  const seat = { path: '/tmp/exact-seat', managed: true };
  registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'thread-a',
    displayName: '[test] lane a',
    seat,
  }, fixture.env);
  assert.throws(() => registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'thread-b',
    displayName: '[test] lane b',
    seat,
  }, fixture.env), /seat is already owned/);
});

test('state paths inside the repository and symlinked state files are rejected', (t) => {
  const fixture = createStateFixture(t);
  assert.throws(() => ensureRegistry(fixture.repoRoot, {
    ...fixture.env,
    TRANSMOGRIFY_STATE_DIR: path.join(fixture.repoRoot, '.transmogrify-state'),
  }), /outside the repository/);

  const { registry } = projectPaths(fixture.repoRoot, fixture.env);
  const external = path.join(fixture.root, 'external-registry.json');
  fs.copyFileSync(registry, external);
  fs.chmodSync(external, 0o600);
  fs.unlinkSync(registry);
  fs.symlinkSync(external, registry);
  assert.throws(() => readRegistry(fixture.repoRoot, fixture.env), /unsafe JSON state file/);
});

test('state directories and JSON receipts must remain private and owner-controlled', (t) => {
  const fixture = createStateFixture(t);
  const paths = projectPaths(fixture.repoRoot, fixture.env);
  fs.chmodSync(fixture.stateDir, 0o777);
  assert.throws(
    () => projectPaths(fixture.repoRoot, fixture.env),
    /non-(?:private state directory|owner-controlled state ancestor)/,
  );
  fs.chmodSync(fixture.stateDir, 0o700);

  fs.chmodSync(paths.registry, 0o644);
  assert.throws(() => readRegistry(fixture.repoRoot, fixture.env), /non-private JSON state file/);
  fs.chmodSync(paths.registry, 0o600);

  fs.rmSync(paths.operations, { recursive: true });
  const external = path.join(fixture.root, 'external-operations');
  fs.mkdirSync(external, { mode: 0o700 });
  fs.symlinkSync(external, paths.operations);
  assert.throws(() => beginOperation(fixture.repoRoot, {
    type: 'status',
    laneId: null,
  }, fixture.env), /symlinked state directory/);
});

test('state creation refuses a group/world-writable existing ancestor', (t) => {
  const fixture = createStateFixture(t);
  const shared = path.join(fixture.root, 'shared-state-parent');
  fs.mkdirSync(shared);
  fs.chmodSync(shared, 0o777);
  assert.throws(() => ensureRegistry(fixture.repoRoot, {
    ...fixture.env,
    TRANSMOGRIFY_STATE_DIR: path.join(shared, 'private-leaf', 'state'),
  }), /non-owner-controlled state ancestor/);
  assert.equal(fs.existsSync(path.join(shared, 'private-leaf')), false);
});

test('ownership locks remain usable without ps and never reap an unverified live pid', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-lock-no-ps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDirectory = path.join(root, 'lock');
  const selfStartMs = 1_777_777_777_000;
  const owner = acquireLock(lockDirectory, {
    dependencies: {
      processBirth: () => null,
      selfPid: process.pid,
      selfStartMs,
    },
  });
  assert.equal(owner.processBirth, `self-start-ms:${selfStartMs}`);
  releaseLock(lockDirectory, owner);

  assert.equal(processMatches({
    pid: 44444,
    processBirth: 'unavailable-birth',
  }, {
    kill() {},
    processBirth: () => null,
    selfPid: process.pid,
  }), true);
  assert.equal(processMatches({
    pid: 55555,
    processBirth: 'dead-birth',
  }, {
    kill() { const error = new Error('gone'); error.code = 'ESRCH'; throw error; },
    processBirth: () => null,
  }), false);
});

test('operation journal records intent before provider identity is known', (t) => {
  const fixture = createStateFixture(t);
  const operation = beginOperation(fixture.repoRoot, {
    type: 'spawn',
    laneId: 'lane-planned',
    details: { name: '[test] planned lane' },
  }, fixture.env);
  assert.equal(operation.state, 'planned');
  assert.equal(operation.providerId, null);
  const updated = updateOperation(fixture.repoRoot, operation.operationId, {
    state: 'providerCreated',
    providerId: 'thread-created',
  }, fixture.env);
  assert.equal(updated.providerId, 'thread-created');
  assert.equal(updateOperation(fixture.repoRoot, operation.operationId, {
    providerId: 'thread-created',
  }, fixture.env).providerId, 'thread-created');
  assert.throws(() => updateOperation(fixture.repoRoot, operation.operationId, {
    providerId: 'thread-replacement',
  }, fixture.env), /immutable operation field providerId/);
  assert.throws(() => updateOperation(fixture.repoRoot, operation.operationId, {
    details: { name: '[test] rewritten lane' },
  }, fixture.env), /immutable operation detail name/);
  assert.equal(updateOperation(fixture.repoRoot, operation.operationId, {
    details: { ...operation.details, providerReceiptSha256: 'd'.repeat(64) },
  }, fixture.env).details.providerReceiptSha256, 'd'.repeat(64));
  assert.equal(listOperations(fixture.repoRoot, fixture.env).length, 1);
});

test('spawn reservation is durable before managed seat materialization and seat binds once', (t) => {
  const fixture = createStateFixture(t);
  const laneId = '12121212-1212-4121-8121-121212121212';
  const operationId = '34343434-3434-4343-8343-343434343434';
  const seatIntent = {
    version: 1,
    laneId,
    path: '/tmp/transmogrify-worktrees/lane-one',
    worktreesRoot: '/tmp/transmogrify-worktrees',
    gitCommonDir: '/tmp/repository/.git',
    branchRef: 'refs/heads/transmogrify/lane-one',
    baseCommit: 'a'.repeat(40),
    managed: true,
  };
  const reserved = reserveSpawn(fixture.repoRoot, {
    operation: {
      operationId,
      type: 'spawn',
      laneId,
      details: { target: 'codex', name: '[test] pre-seat' },
    },
    lane: {
      laneId,
      backend: 'codex-app-server',
      displayName: '[test] pre-seat',
      operationId,
      seatIntent,
    },
  }, fixture.env);
  assert.equal(reserved.operation.state, 'planned');
  assert.equal(reserved.lane.seat, null);
  assert.deepEqual(reserved.lane.seatIntent, seatIntent);
  assert.equal(reserved.lane.pendingOperationId, operationId);
  assert.equal(pendingOperationForLane(fixture.repoRoot, laneId, fixture.env).operationId, operationId);

  assert.throws(() => reserveSpawn(fixture.repoRoot, {
    operation: {
      operationId: '56565656-5656-4565-8565-565656565656',
      type: 'spawn',
      laneId: '78787878-7878-4787-8787-787878787878',
    },
    lane: {
      laneId: '78787878-7878-4787-8787-787878787878',
      backend: 'codex-app-server',
      displayName: '[test] collision',
      operationId: '56565656-5656-4565-8565-565656565656',
      seatIntent: { ...seatIntent, laneId: '78787878-7878-4787-8787-787878787878' },
    },
  }, fixture.env), /seat is already owned/);

  const seat = {
    path: seatIntent.path,
    worktreesRoot: seatIntent.worktreesRoot,
    gitCommonDir: seatIntent.gitCommonDir,
    branchRef: seatIntent.branchRef,
    head: seatIntent.baseCommit,
    device: 1,
    inode: 2,
    managed: true,
  };
  assert.throws(() => bindLaneSeat(
    fixture.repoRoot, laneId, operationId, { ...seat, head: 'b'.repeat(40) }, fixture.env,
  ), /baseCommit/);
  const seated = bindLaneSeat(fixture.repoRoot, laneId, operationId, seat, fixture.env);
  assert.deepEqual(seated.seat, seat);
  assert.deepEqual(bindLaneSeat(
    fixture.repoRoot, laneId, operationId, seat, fixture.env,
  ).seat, seat);
  assert.throws(() => bindLaneSeat(
    fixture.repoRoot, laneId, operationId, { ...seat, inode: 3 }, fixture.env,
  ), /immutable lane field seat/);
  const operation = pendingOperationForLane(fixture.repoRoot, laneId, fixture.env);
  assert.equal(operation.state, 'seatReady');
  assert.deepEqual(operation.details.seat, seat);
});

test('pending lane operation pointers reject stale writers and clear only after durable completion', (t) => {
  const fixture = createStateFixture(t);
  const lane = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'pointer-provider',
    displayName: '[test] pointer lane',
    state: 'active',
  }, fixture.env);
  const operationId = '90909090-9090-4909-8909-909090909090';
  const operation = beginLaneOperation(fixture.repoRoot, lane.laneId, {
    operationId,
    type: 'steer',
    details: { inputSha256: 'c'.repeat(64) },
  }, fixture.env);
  assert.equal(operation.laneId, lane.laneId);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).operationId, operationId);
  assert.throws(() => beginLaneOperation(fixture.repoRoot, lane.laneId, {
    type: 'steer',
  }, fixture.env), /already has pending operation/);
  assert.throws(() => updateOperation(fixture.repoRoot, operationId, {
    laneId: 'another-lane',
  }, fixture.env), /immutable operation field laneId/);
  assert.throws(() => updatePendingLaneOperation(
    fixture.repoRoot, lane.laneId, 'abababab-abab-4aba-8aba-abababababab', { state: 'queued' }, fixture.env,
  ), /not pending/);
  assert.equal(updatePendingLaneOperation(
    fixture.repoRoot, lane.laneId, operationId, { state: 'queued' }, fixture.env,
  ).state, 'queued');
  const completed = completeLaneOperation(
    fixture.repoRoot, lane.laneId, operationId, { state: 'complete' }, fixture.env,
  );
  assert.equal(completed.state, 'complete');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  assert.equal(completeLaneOperation(
    fixture.repoRoot, lane.laneId, operationId, { state: 'complete' }, fixture.env,
  ).state, 'complete');
});

test('terminal operation pointer reconciliation closes the durable write-order crash boundary', (t) => {
  const fixture = createStateFixture(t);
  const lane = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'terminal-pointer-provider',
    displayName: '[test] terminal pointer lane',
    state: 'idle',
  }, fixture.env);
  const operation = beginLaneOperation(fixture.repoRoot, lane.laneId, {
    type: 'steer',
    details: { inputSha256: 'd'.repeat(64) },
  }, fixture.env);
  updatePendingLaneOperation(fixture.repoRoot, lane.laneId, operation.operationId, {
    state: 'complete',
    details: { ...operation.details, responseVerified: true },
  }, fixture.env);
  assert.equal(pendingOperationForLane(
    fixture.repoRoot, lane.laneId, fixture.env,
  ).state, 'complete');

  const settled = settleTerminalLaneOperationPointer(
    fixture.repoRoot, lane.laneId, fixture.env,
  );
  assert.equal(settled.state, 'complete');
  assert.equal(settled.details.responseVerified, true);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  assert.equal(settleTerminalLaneOperationPointer(
    fixture.repoRoot, lane.laneId, fixture.env,
  ), null);
});

test('Claude provider identity binds exact handles once and records immutable epochs', (t) => {
  const fixture = createStateFixture(t);
  const displayName = '[test] Claude lane';
  const operationId = '43214321-4321-4321-8321-432143214321';
  const laneId = '56785678-5678-4678-8678-567856785678';
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const identity = {
    version: 1,
    sessionId: null,
    jobId: null,
    bridgeId: null,
    executionEpochs: [],
    runtimeEpochs: [],
  };
  const initialRuntime = {
    protocolGeneration: 1,
    platform: 'darwin',
    arch: 'arm64',
    cliPath: '/tmp/claude-2.1.257',
    cliVersion: '2.1.257',
    cliSha256: 'c'.repeat(64),
    configDir: '/tmp/claude-config',
    configDevice: 1,
    configInode: 2,
    projectsDirectory: '/tmp/claude-config/projects',
    projectsDevice: 1,
    projectsInode: 3,
    accountFingerprint: 'd'.repeat(64),
  };
  const spawnIntent = claudeSpawnIntent(operationId, displayName, '4');
  const epoch = {
    epochId: '22222222-2222-4222-8222-222222222222',
    pid: 123,
    processBirth: 'Tue Sep  1 15:00:00 2026',
    socket: {
      path: '/tmp/transmogrify-owned/claude.sock',
      device: 1,
      inode: 2,
      uid: 501,
      mode: 0o600,
    },
    observedAt: '2026-09-01T19:00:00.000Z',
  };
  const reserved = reserveSpawn(fixture.repoRoot, {
    operation: { operationId, type: 'spawn', laneId, state: 'dispatching', details: { target: 'claude' } },
    lane: {
      laneId, backend: 'claude-code', displayName, operationId,
      runtime: initialRuntime, providerIdentity: identity, spawnIntent,
    },
  }, fixture.env).lane;
  assert.equal(reserved.providerId, null);
  assert.deepEqual(reserved.providerIdentity, identity);
  assert.deepEqual(reserved.ownership.spawnIntent, spawnIntent);

  const creationReceipt = { stdoutSha256: 'a'.repeat(64) };
  const bridgeReceipt = { source: 'owned-session-metadata' };
  const observation = {
    sessionId, jobId: '11111111', bridgeId: 'session_testBridge', creationReceipt, bridgeReceipt, epoch,
  };
  const bound = bindClaudeSpawnObservation(fixture.repoRoot, reserved.laneId, observation, fixture.env);
  assert.equal(bound.providerId, sessionId);
  assert.equal(bound.providerIdentity.jobId, '11111111');
  assert.equal(bound.providerIdentity.bridgeId, 'session_testBridge');
  assert.deepEqual(bound.ownership.creationReceipt, creationReceipt);
  assert.equal(bindClaudeSpawnObservation(fixture.repoRoot, reserved.laneId, observation, fixture.env).providerId, sessionId);
  assert.throws(() => bindClaudeSpawnObservation(fixture.repoRoot, reserved.laneId, {
    ...observation, sessionId: '55555555-5555-4555-8555-555555555555', jobId: '55555555',
  }, fixture.env), Error);
  assert.throws(() => bindClaudeSpawnObservation(fixture.repoRoot, reserved.laneId, {
    ...observation, bridgeId: 'session_replacement',
  }, fixture.env), Error);

  const recorded = appendLaneExecutionEpoch(fixture.repoRoot, reserved.laneId, epoch, fixture.env);
  assert.equal(recorded.providerIdentity.executionEpochs[0].ordinal, 1);
  assert.equal(appendLaneExecutionEpoch(
    fixture.repoRoot, reserved.laneId, epoch, fixture.env,
  ).providerIdentity.executionEpochs.length, 1);
  assert.throws(() => appendLaneExecutionEpoch(fixture.repoRoot, reserved.laneId, {
    ...epoch,
    pid: 124,
  }, fixture.env), /immutable Claude execution epoch/);
  assert.throws(() => appendLaneExecutionEpoch(fixture.repoRoot, reserved.laneId, {
    ...epoch,
    epochId: '66666666-6666-4666-8666-666666666666',
    socket: { ...epoch.socket, token: 'secret' },
  }, fixture.env), /unsupported field token/);

  const nextRuntime = {
    ...initialRuntime,
    cliPath: '/tmp/claude-2.1.258',
    cliVersion: '2.1.258',
    cliSha256: 'e'.repeat(64),
  };
  const transition = {
    transitionId: '77777777-7777-4777-8777-777777777777',
    fromCliSha256: initialRuntime.cliSha256,
    runtime: nextRuntime,
    worker: { path: nextRuntime.cliPath, sha256: nextRuntime.cliSha256 },
    epoch: {
      ...epoch,
      epochId: '77777777-7777-4777-8777-777777777777',
      pid: 124,
      processBirth: 'Tue Sep  1 15:01:00 2026',
      socket: { ...epoch.socket, path: '/tmp/transmogrify-owned/claude-2.sock', inode: 3 },
    },
    observedAt: '2026-09-01T19:01:00.000Z',
  };
  const rebound = rebindClaudeRuntime(
    fixture.repoRoot, reserved.laneId, transition, fixture.env,
  );
  assert.equal(rebound.providerIdentity.runtimeEpochs[0].ordinal, 1);
  assert.equal(rebound.providerIdentity.runtimeEpochs[0].executionEpochOrdinal, 2);
  assert.equal(rebound.providerIdentity.executionEpochs[1].pid, 124);
  assert.equal(rebindClaudeRuntime(
    fixture.repoRoot, reserved.laneId, transition, fixture.env,
  ).providerIdentity.runtimeEpochs.length, 1);
  assert.throws(() => rebindClaudeRuntime(fixture.repoRoot, reserved.laneId, {
    ...transition,
    transitionId: '88888888-8888-4888-8888-888888888888',
    fromCliSha256: nextRuntime.cliSha256,
    runtime: { ...nextRuntime, accountFingerprint: 'f'.repeat(64), cliSha256: '0'.repeat(64) },
    worker: { path: nextRuntime.cliPath, sha256: '0'.repeat(64) },
    epoch: { ...transition.epoch, epochId: '88888888-8888-4888-8888-888888888888' },
  }, fixture.env), /immutable provider identity/);

  assert.throws(() => updateLane(fixture.repoRoot, reserved.laneId, {
    providerIdentity: identity,
  }, fixture.env), /immutable lane field providerIdentity/);
  assert.throws(() => mutateLane(fixture.repoRoot, reserved.laneId, () => ({
    patch: { providerIdentity: identity },
  }), fixture.env), /immutable lane field providerIdentity/);
  const protectedBefore = requireOwnedLane(fixture.repoRoot, reserved.laneId, fixture.env);
  mutateLane(fixture.repoRoot, reserved.laneId, (draft) => {
    draft.providerIdentity.executionEpochs.length = 0;
    draft.ownership.spawnIntent.displayName = '[test] rewritten';
    return { patch: { lastVerifiedAt: '2026-09-01T20:00:00.000Z' } };
  }, fixture.env);
  const protectedAfter = requireOwnedLane(fixture.repoRoot, reserved.laneId, fixture.env);
  assert.deepEqual(protectedAfter.providerIdentity, protectedBefore.providerIdentity);
  assert.deepEqual(protectedAfter.ownership, protectedBefore.ownership);
  assert.equal(requireOwnedProviderLane(
    fixture.repoRoot, 'claude-code', sessionId, fixture.env,
  ).laneId, reserved.laneId);
  assert.throws(() => requireOwnedProviderLane(
    fixture.repoRoot, 'claude-code', '11111111', fixture.env,
  ), /NOT_OWNED/);
});

test('terminal Claude receipts preserve legacy project-directory identity shape', (t) => {
  const fixture = createStateFixture(t);
  const initialRuntime = {
    protocolGeneration: 1,
    platform: 'darwin',
    arch: 'arm64',
    cliPath: '/tmp/claude-2.1.257',
    cliVersion: '2.1.257',
    cliSha256: 'c'.repeat(64),
    configDir: '/tmp/claude-config',
    configDevice: 1,
    configInode: 2,
    projectsDirectory: '/tmp/claude-config/projects',
    projectsDevice: 1,
    projectsInode: 3,
    accountFingerprint: 'd'.repeat(64),
  };
  const nextRuntime = {
    ...initialRuntime,
    cliPath: '/tmp/claude-2.1.258',
    cliVersion: '2.1.258',
    cliSha256: 'e'.repeat(64),
  };
  const sessionId = '12121212-1212-4212-8212-121212121212';
  const operationId = '78787878-7878-4787-8787-787878787878';
  const lane = registerLane(fixture.repoRoot, {
    backend: 'claude-code',
    providerId: sessionId,
    displayName: '::: legacy terminal receipt',
    state: 'worktreeRemoved',
    operationId,
    runtime: initialRuntime,
  }, fixture.env);

  const registryPath = projectPaths(fixture.repoRoot, fixture.env).registry;
  const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  raw.lanes[lane.laneId].providerIdentity = {
      version: 1,
      sessionId,
      jobId: '12121212',
      bridgeId: 'session_legacyTerminal',
      executionEpochs: [{
        epochId: '34343434-3434-4434-8434-343434343434',
        ordinal: 1,
        pid: 123,
        processBirth: 'Tue Sep  1 15:00:00 2026',
        socket: {
          path: '/tmp/transmogrify-owned/legacy.sock',
          device: 1,
          inode: 2,
          uid: 501,
          mode: 0o600,
        },
        observedAt: '2026-09-01T19:00:00.000Z',
      }],
      runtimeEpochs: [{
        transitionId: '56565656-5656-4565-8565-565656565656',
        ordinal: 1,
        fromCliSha256: initialRuntime.cliSha256,
        runtime: nextRuntime,
        worker: { path: nextRuntime.cliPath, sha256: nextRuntime.cliSha256 },
        executionEpochOrdinal: 1,
        observedAt: '2026-09-01T19:01:00.000Z',
      }],
    };
  raw.lanes[lane.laneId].ownership.spawnIntent =
    claudeSpawnIntent(operationId, lane.displayName, '9');
  for (const runtime of [
    raw.lanes[lane.laneId].runtime,
    raw.lanes[lane.laneId].providerIdentity.runtimeEpochs[0].runtime,
  ]) {
    delete runtime.projectsDevice;
    delete runtime.projectsInode;
  }
  fs.writeFileSync(registryPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  assert.equal(readRegistry(fixture.repoRoot, fixture.env).registry.lanes[lane.laneId].state,
    'worktreeRemoved');

  raw.lanes[lane.laneId].state = 'active';
  fs.writeFileSync(registryPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  assert.throws(() => readRegistry(fixture.repoRoot, fixture.env), /projectsDevice is invalid/);

  raw.lanes[lane.laneId].providerIdentity.runtimeEpochs = [];
  fs.writeFileSync(registryPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  assert.throws(() => readRegistry(fixture.repoRoot, fixture.env), /projectsDevice is invalid/);
});

test('Claude spawn intent validates a recorded model selector and preserves legacy omission', (t) => {
  const fixture = createStateFixture(t);
  const displayName = '[test] Claude model selector';
  const laneId = 'claude-model-selector';
  const operationId = '71717171-7171-4717-8717-717171717171';
  reserveSpawn(fixture.repoRoot, {
    operation: { operationId, type: 'spawn', laneId, details: {} },
    lane: {
      laneId,
      backend: 'claude-code',
      displayName,
      operationId,
      runtime: {
        protocolGeneration: 1,
        platform: 'darwin',
        arch: 'arm64',
        cliPath: '/tmp/claude-2.1.258',
        cliVersion: '2.1.258',
        cliSha256: 'c'.repeat(64),
        configDir: '/tmp/claude-config',
        configDevice: 1,
        configInode: 2,
        projectsDirectory: '/tmp/claude-config/projects',
        projectsDevice: 1,
        projectsInode: 3,
        accountFingerprint: 'd'.repeat(64),
      },
      providerIdentity: {
        version: 1, sessionId: null, jobId: null, bridgeId: null,
        executionEpochs: [], runtimeEpochs: [],
      },
      spawnIntent: {
        ...claudeSpawnIntent(operationId, displayName, '7'),
        modelSelector: 'claude-opus-5',
      },
    },
  }, fixture.env);
  assert.equal(
    readRegistry(fixture.repoRoot, fixture.env).registry.lanes[laneId]
      .ownership.spawnIntent.modelSelector,
    'claude-opus-5',
  );

  const { registry } = projectPaths(fixture.repoRoot, fixture.env);
  const raw = JSON.parse(fs.readFileSync(registry, 'utf8'));
  raw.lanes[laneId].ownership.spawnIntent.modelSelector = '--unsafe';
  fs.writeFileSync(registry, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  assert.throws(() => readRegistry(fixture.repoRoot, fixture.env), /spawn intent model is invalid/);

  // Existing Claude fixtures in this suite omit modelSelector and continue to
  // validate as serialized version-1 spawn intents.
});

test('Claude spawn observation atomically binds all stable handles, receipts, and first epoch', (t) => {
  const fixture = createStateFixture(t);
  const laneId = '13571357-1357-4357-8357-135713571357';
  const operationId = '24682468-2468-4468-8468-246824682468';
  const displayName = '[test] atomic Claude observation';
  reserveSpawn(fixture.repoRoot, {
    operation: {
      operationId,
      type: 'spawn',
      laneId,
      state: 'dispatching',
      details: { target: 'claude' },
    },
    lane: {
      laneId,
      backend: 'claude-code',
      displayName,
      operationId,
      runtime: claudeRuntimeReceipt(),
      providerIdentity: {
        version: 1,
        sessionId: null,
        jobId: null,
        bridgeId: null,
        executionEpochs: [],
      },
      spawnIntent: claudeSpawnIntent(operationId, displayName, 'e'),
    },
  }, fixture.env);
  const observation = {
    sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    jobId: 'eeeeeeee',
    bridgeId: 'session_atomicBridge',
    creationReceipt: { source: 'agents-census', transcriptMarkerSha256: 'd'.repeat(64) },
    bridgeReceipt: { source: 'owned-session-metadata' },
    epoch: {
      epochId: '35793579-3579-4579-8579-357935793579',
      pid: 456,
      processBirth: 'Tue Sep  1 16:00:00 2026',
      socket: {
        path: '/tmp/transmogrify-owned/atomic.sock',
        device: 3,
        inode: 4,
        uid: 501,
        mode: 0o600,
      },
      observedAt: '2026-09-01T20:00:00.000Z',
    },
  };
  const bound = bindClaudeSpawnObservation(
    fixture.repoRoot, laneId, observation, fixture.env,
  );
  assert.equal(bound.state, 'created');
  assert.equal(bound.providerId, observation.sessionId);
  assert.equal(bound.providerIdentity.bridgeId, observation.bridgeId);
  assert.equal(bound.providerIdentity.executionEpochs.length, 1);
  assert.equal(bound.providerIdentity.executionEpochs[0].ordinal, 1);
  const operation = pendingOperationForLane(fixture.repoRoot, laneId, fixture.env);
  assert.equal(operation.providerId, observation.sessionId);
  assert.equal(operation.state, 'providerObserved');

  updateLane(fixture.repoRoot, laneId, { state: 'active' }, fixture.env);
  assert.equal(bindClaudeSpawnObservation(
    fixture.repoRoot, laneId, observation, fixture.env,
  ).state, 'active');
  assert.throws(() => bindClaudeSpawnObservation(fixture.repoRoot, laneId, {
    ...observation,
    bridgeReceipt: { source: 'replacement' },
  }, fixture.env), /immutable Claude spawn observation receipts/);
});

test('Claude provider handle collisions and corrupt identities fail closed', (t) => {
  const fixture = createStateFixture(t);
  const identity = {
    version: 1,
    sessionId: null,
    jobId: null,
    bridgeId: null,
    executionEpochs: [],
  };
  const operationIds = {
    'claude-a': 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
    'claude-b': 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2',
  };
  for (const laneId of ['claude-a', 'claude-b']) {
    const operationId = operationIds[laneId];
    reserveSpawn(fixture.repoRoot, {
      operation: { operationId, type: 'spawn', laneId, details: {} },
      lane: {
        laneId,
        backend: 'claude-code',
        displayName: `[test] ${laneId}`,
        operationId,
        runtime: claudeRuntimeReceipt(),
        providerIdentity: identity,
        spawnIntent: claudeSpawnIntent(operationId, `[test] ${laneId}`, laneId === 'claude-a' ? 'a' : 'b'),
      },
    }, fixture.env);
  }
  bindClaudeSpawnObservation(fixture.repoRoot, 'claude-a', {
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    jobId: 'aaaaaaaa',
    bridgeId: 'session_testA',
    creationReceipt: { source: 'test-a' },
    bridgeReceipt: { source: 'test-a-bridge' },
    epoch: {
      epochId: 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3',
      pid: 111,
      processBirth: 'Tue Sep  1 15:00:00 2026',
      socket: {
        path: '/tmp/transmogrify-owned/claude-a.sock',
        device: 1,
        inode: 2,
        uid: 501,
        mode: 0o600,
      },
      observedAt: '2026-09-01T19:00:00.000Z',
    },
  }, fixture.env);
  assert.throws(() => bindClaudeSpawnObservation(fixture.repoRoot, 'claude-b', {
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    jobId: 'aaaaaaaa',
    bridgeId: 'session_testB',
    creationReceipt: { source: 'test-b' },
    bridgeReceipt: { source: 'test-b-bridge' },
    epoch: {
      epochId: 'b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4',
      pid: 222,
      processBirth: 'Tue Sep  1 15:00:00 2026',
      socket: {
        path: '/tmp/transmogrify-owned/claude-b.sock',
        device: 1,
        inode: 2,
        uid: 501,
        mode: 0o600,
      },
      observedAt: '2026-09-01T19:00:00.000Z',
    },
  }, fixture.env), /already owned/);

  const { registry } = projectPaths(fixture.repoRoot, fixture.env);
  const corrupt = JSON.parse(fs.readFileSync(registry, 'utf8'));
  corrupt.lanes['claude-a'].providerIdentity.jobId = 'bbbbbbbb';
  fs.writeFileSync(registry, `${JSON.stringify(corrupt)}\n`);
  assert.throws(() => readRegistry(fixture.repoRoot, fixture.env), /job id does not match/);
});

test('Claude identity reservation requires exact backend, intent, receipts, and lifecycle', (t) => {
  const fixture = createStateFixture(t);
  const identity = {
    version: 1,
    sessionId: null,
    jobId: null,
    bridgeId: null,
    executionEpochs: [],
  };
  const invalidOperationId = 'c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5';
  assert.throws(() => reserveSpawn(fixture.repoRoot, {
    operation: { operationId: invalidOperationId, type: 'spawn', laneId: 'claude-invalid', details: {} },
    lane: {
      laneId: 'claude-invalid',
      backend: 'codex-app-server',
      displayName: '[test] invalid backend',
      operationId: invalidOperationId,
      providerIdentity: identity,
      spawnIntent: claudeSpawnIntent(invalidOperationId, '[test] invalid backend', 'c'),
    },
  }, fixture.env), /carries a provider identity for backend/);

  const validOperationId = 'd6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6';
  const { lane } = reserveSpawn(fixture.repoRoot, {
    operation: { operationId: validOperationId, type: 'spawn', laneId: 'claude-valid', details: {} },
    lane: {
      laneId: 'claude-valid',
      backend: 'claude-code',
      displayName: '[test] valid lifecycle',
      operationId: validOperationId,
      runtime: claudeRuntimeReceipt(),
      providerIdentity: identity,
      spawnIntent: claudeSpawnIntent(validOperationId, '[test] valid lifecycle', 'd'),
    },
  }, fixture.env);
  const validBridgeId = 'session_testValid';
  const validEpoch = {
    epochId: 'd7d7d7d7-d7d7-4d7d-8d7d-d7d7d7d7d7d7',
    pid: 333,
    processBirth: 'Tue Sep  1 15:00:00 2026',
    socket: {
      path: '/tmp/transmogrify-owned/claude-valid.sock',
      device: 1,
      inode: 2,
      uid: 501,
      mode: 0o600,
    },
    observedAt: '2026-09-01T19:00:00.000Z',
  };
  assert.throws(() => bindClaudeSpawnObservation(fixture.repoRoot, lane.laneId, {
    sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    jobId: 'dddddddd',
    bridgeId: validBridgeId,
    bridgeReceipt: { source: 'test-valid-bridge' },
    epoch: validEpoch,
  }, fixture.env), /creation receipt is required/);
  assert.throws(() => bindClaudeSpawnObservation(fixture.repoRoot, lane.laneId, {
    sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    jobId: 'dddddddd',
    bridgeId: validBridgeId,
    creationReceipt: { accessToken: 'must-not-persist' },
    bridgeReceipt: { source: 'test-valid-bridge' },
    epoch: validEpoch,
  }, fixture.env), /secret-bearing field accessToken/);
  updateLane(fixture.repoRoot, lane.laneId, { state: 'failed' }, fixture.env);
  assert.throws(() => bindClaudeSpawnObservation(fixture.repoRoot, lane.laneId, {
    sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    jobId: 'dddddddd',
    bridgeId: validBridgeId,
    creationReceipt: { source: 'too-late' },
    bridgeReceipt: { source: 'test-valid-bridge' },
    epoch: validEpoch,
  }, fixture.env), /from lane state failed/);
});

test('registry rejects duplicate canonical providers, mismatched lane keys, and mixed-case Claude ids', (t) => {
  const fixture = createStateFixture(t);
  const first = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'provider-one',
    displayName: '[test] one',
  }, fixture.env);
  const second = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'provider-two',
    displayName: '[test] two',
  }, fixture.env);
  const { registry } = projectPaths(fixture.repoRoot, fixture.env);
  let corrupt = JSON.parse(fs.readFileSync(registry, 'utf8'));
  corrupt.lanes[second.laneId].providerId = first.providerId;
  fs.writeFileSync(registry, `${JSON.stringify(corrupt)}\n`);
  assert.throws(() => readRegistry(fixture.repoRoot, fixture.env), /already owned/);

  corrupt = JSON.parse(fs.readFileSync(registry, 'utf8'));
  corrupt.lanes[second.laneId].providerId = 'provider-two';
  corrupt.lanes[second.laneId].laneId = 'different-key';
  fs.writeFileSync(registry, `${JSON.stringify(corrupt)}\n`);
  assert.throws(() => readRegistry(fixture.repoRoot, fixture.env), /invalid canonical identity/);
});

test('Claude stop and recover lifecycle transitions are explicit', (t) => {
  const fixture = createStateFixture(t);
  const lane = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'transition-provider',
    displayName: '[test] transitions',
    state: 'active',
  }, fixture.env);
  updateLane(fixture.repoRoot, lane.laneId, { state: 'stopRequested' }, fixture.env);
  updateLane(fixture.repoRoot, lane.laneId, { state: 'stopped' }, fixture.env);
  updateLane(fixture.repoRoot, lane.laneId, { state: 'recoverRequested' }, fixture.env);
  assert.equal(updateLane(
    fixture.repoRoot, lane.laneId, { state: 'idle' }, fixture.env,
  ).state, 'idle');
});

test('provider disappearance can stop a live lane only with an immutable observation receipt', (t) => {
  const fixture = createStateFixture(t);
  const lane = registerLane(fixture.repoRoot, {
    backend: 'claude-code-test-double',
    providerId: 'observed-stop-provider',
    displayName: '[test] observed stop',
    state: 'active',
  }, fixture.env);
  const observation = {
    observationId: '46804680-4680-4680-8680-468046804680',
    observedAt: '2026-09-01T21:00:00.000Z',
    receipt: { source: 'exact-owned-agent-census', present: false },
  };
  const stopped = observeLaneStopped(fixture.repoRoot, lane.laneId, observation, fixture.env);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.observedStops[0].fromState, 'active');
  assert.equal(stopped.lastVerifiedAt, observation.observedAt);
  assert.equal(observeLaneStopped(
    fixture.repoRoot, lane.laneId, observation, fixture.env,
  ).observedStops.length, 1);
  assert.throws(() => observeLaneStopped(fixture.repoRoot, lane.laneId, {
    ...observation,
    receipt: { source: 'changed' },
  }, fixture.env), /immutable observed-stop record/);
  assert.throws(() => updateLane(fixture.repoRoot, lane.laneId, {
    observedStops: [],
  }, fixture.env), /immutable lane field observedStops/);

  updateLane(fixture.repoRoot, lane.laneId, { state: 'recoverRequested' }, fixture.env);
  assert.equal(updateLane(
    fixture.repoRoot, lane.laneId, { state: 'stopRequested' }, fixture.env,
  ).state, 'stopRequested');
});

test('Codex-only records omit Claude provider identity', (t) => {
  const fixture = createStateFixture(t);
  const lane = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'codex-thread',
    displayName: '[test] Codex-only lane',
  }, fixture.env);
  assert.equal(Object.hasOwn(lane, 'providerIdentity'), false);
  assert.equal(Object.hasOwn(readRegistry(fixture.repoRoot, fixture.env).registry.lanes[lane.laneId], 'providerIdentity'), false);
});

test('corrupt registry state fails closed', (t) => {
  const fixture = createStateFixture(t);
  const { registry } = projectPaths(fixture.repoRoot, fixture.env);
  fs.writeFileSync(registry, '{truncated');
  assert.throws(() => readRegistry(fixture.repoRoot, fixture.env), /refusing corrupt JSON state/);
});

test('ownership lock serializes concurrent writers', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDirectory = path.join(root, 'lock');
  const eventsFile = path.join(root, 'events');
  const worker = path.join(__dirname, 'helpers', 'lock-worker.js');

  const children = Array.from({ length: 20 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, lockDirectory, eventsFile, String(index)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  }));
  await Promise.all(children);

  let inside = 0;
  for (const event of fs.readFileSync(eventsFile, 'utf8').trim().split('\n')) {
    if (event.startsWith('enter ')) inside += 1;
    else inside -= 1;
    assert.ok(inside === 0 || inside === 1, `lock overlap at ${event}`);
  }
  assert.equal(inside, 0);
});

test('ownership lock refuses symlinks and another owner cannot release it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-lock-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDirectory = path.join(root, 'lock');
  const owner = acquireLock(lockDirectory);
  assert.throws(() => {
    releaseLock(lockDirectory, { ...owner, token: 'not-the-owner' });
  }, /owned by another process/);
  releaseLock(lockDirectory, owner);

  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, lockDirectory);
  assert.throws(() => acquireLock(lockDirectory), /unsafe ownership lock path/);
});

test('concurrent stale-lock reapers do not steal the replacement owner', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-stale-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDirectory = path.join(root, 'lock');
  const eventsFile = path.join(root, 'events');
  fs.mkdirSync(lockDirectory);
  fs.writeFileSync(path.join(lockDirectory, 'owner.json'), `${JSON.stringify({
    token: 'dead-owner',
    pid: 999999,
    processBirth: 'not-running',
    createdAt: '2020-01-01T00:00:00.000Z',
  })}\n`, { mode: 0o600 });
  const old = new Date('2020-01-01T00:00:00.000Z');
  fs.utimesSync(path.join(lockDirectory, 'owner.json'), old, old);
  fs.utimesSync(lockDirectory, old, old);

  const worker = path.join(__dirname, 'helpers', 'lock-worker.js');
  const children = Array.from({ length: 12 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, lockDirectory, eventsFile, String(index), '1000'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  }));
  await Promise.all(children);
  const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
  assert.equal(events.filter((entry) => entry.startsWith('enter ')).length, 12);
  assert.equal(fs.existsSync(lockDirectory), false);
  assert.equal(fs.existsSync(`${lockDirectory}.reaper`), false);
});

test('a crashed stale-lock reaper is itself receipt-reclaimed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-reaper-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDirectory = path.join(root, 'lock');
  const reaperDirectory = `${lockDirectory}.reaper`;
  const old = new Date('2020-01-01T00:00:00.000Z');
  for (const [directory, token] of [
    [lockDirectory, 'dead-lock-owner'],
    [reaperDirectory, 'dead-reaper-owner'],
  ]) {
    fs.mkdirSync(directory);
    const ownerFile = path.join(directory, 'owner.json');
    fs.writeFileSync(ownerFile, `${JSON.stringify({
      token,
      pid: 999999,
      processBirth: 'not-running',
      hostname: 'test',
      createdAt: old.toISOString(),
    })}\n`, { mode: 0o600 });
    fs.utimesSync(ownerFile, old, old);
    fs.utimesSync(directory, old, old);
  }

  const owner = acquireLock(lockDirectory, {
    waitMs: 1000,
    pollMs: 5,
    ownerlessGraceMs: 1,
  });
  assert.equal(fs.existsSync(reaperDirectory), false);
  releaseLock(lockDirectory, owner);
  assert.equal(fs.existsSync(lockDirectory), false);
});

test('a live stale-lock reaper is not stolen and contenders still time out', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-live-reaper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDirectory = path.join(root, 'lock');
  const reaperDirectory = `${lockDirectory}.reaper`;
  fs.mkdirSync(lockDirectory);
  fs.writeFileSync(path.join(lockDirectory, 'owner.json'), `${JSON.stringify({
    token: 'dead-owner',
    pid: 999999,
    processBirth: 'not-running',
    createdAt: '2020-01-01T00:00:00.000Z',
  })}\n`, { mode: 0o600 });
  const old = new Date('2020-01-01T00:00:00.000Z');
  fs.utimesSync(path.join(lockDirectory, 'owner.json'), old, old);
  fs.utimesSync(lockDirectory, old, old);

  const reaperOwner = acquireLock(reaperDirectory);
  assert.throws(() => acquireLock(lockDirectory, {
    waitMs: 30,
    pollMs: 5,
    ownerlessGraceMs: 1,
  }), /timed out waiting/);
  releaseLock(reaperDirectory, reaperOwner);
});

test('operation journals accept only the states enumerated for their type', (t) => {
  const fixture = createStateFixture(t);
  const lane = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'enum-provider',
    displayName: '[test] enum lane',
    state: 'active',
  }, fixture.env);
  assert.throws(() => beginLaneOperation(fixture.repoRoot, lane.laneId, {
    type: 'teleport',
  }, fixture.env), /unknown operation type: teleport/);
  assert.throws(() => beginLaneOperation(fixture.repoRoot, lane.laneId, {
    type: 'steer', state: 'providerRetired',
  }, fixture.env), /providerRetired is not valid for a steer operation/);
  const operation = beginLaneOperation(fixture.repoRoot, lane.laneId, { type: 'steer' }, fixture.env);
  assert.equal(operation.schemaVersion, OPERATION_SCHEMA_VERSION);
  assert.equal(operation.state, 'planned');
  assert.throws(() => updatePendingLaneOperation(
    fixture.repoRoot, lane.laneId, operation.operationId, { state: 'materialized' }, fixture.env,
  ), /materialized is not valid for a steer operation/);
  assert.throws(() => completeLaneOperation(
    fixture.repoRoot, lane.laneId, operation.operationId, { state: 'done' }, fixture.env,
  ), /done is not valid for a steer operation/);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).state, 'planned');
  for (const type of OPERATION_TYPES) {
    const states = OPERATION_STATES.get(type);
    assert.ok(states.has('planned') && states.has('complete') && states.has('failed') && states.has('notDelivered'),
      `${type} must allow planned and every terminal state`);
  }
  assert.ok(!ABANDONABLE_OPERATION_TYPES.has('retire'));
});

test('operation records tolerate an absent schema version and refuse a newer one', (t) => {
  const fixture = createStateFixture(t);
  const lane = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'schema-provider',
    displayName: '[test] schema lane',
    state: 'active',
  }, fixture.env);
  const operation = beginLaneOperation(fixture.repoRoot, lane.laneId, { type: 'steer' }, fixture.env);
  const paths = projectPaths(fixture.repoRoot, fixture.env);
  const file = path.join(paths.operations, `${operation.operationId}.json`);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.schemaVersion, 1);
  delete stored.schemaVersion;
  fs.writeFileSync(file, JSON.stringify(stored));
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).operationId, operation.operationId);
  const rewritten = updatePendingLaneOperation(
    fixture.repoRoot, lane.laneId, operation.operationId, { state: 'dispatching' }, fixture.env,
  );
  assert.equal(rewritten.schemaVersion, 1);
  fs.writeFileSync(file, JSON.stringify({ ...stored, schemaVersion: 2 }));
  assert.throws(() => pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env),
    /operation record schema 2 is not supported/);
});

test('a registry written by a newer schema is refused with an upgrade instruction', (t) => {
  const fixture = createStateFixture(t);
  registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'newer-provider',
    displayName: '[test] newer registry',
    state: 'active',
  }, fixture.env);
  const paths = projectPaths(fixture.repoRoot, fixture.env);
  const registry = JSON.parse(fs.readFileSync(paths.registry, 'utf8'));
  fs.writeFileSync(paths.registry, JSON.stringify({ ...registry, schemaVersion: registry.schemaVersion + 1 }));
  assert.throws(() => listLanes(fixture.repoRoot, fixture.env), /written by a newer Transmogrify/);
  fs.writeFileSync(paths.registry, JSON.stringify({ ...registry, schemaVersion: 0 }));
  assert.throws(() => listLanes(fixture.repoRoot, fixture.env), /unsupported or corrupt registry schema: 0/);
});

test('abandon closes a stranded operation as failed without touching a bound lane', (t) => {
  const fixture = createStateFixture(t);
  const lane = registerLane(fixture.repoRoot, {
    backend: 'claude-code-remote-control',
    providerId: 'abandon-provider',
    displayName: '[test] abandon lane',
    state: 'active',
  }, fixture.env);
  assert.throws(() => abandonPendingLaneOperation(
    fixture.repoRoot, lane.laneId, { reason: 'nothing pending' }, fixture.env,
  ), /no pending operation to abandon/);
  const operation = beginLaneOperation(fixture.repoRoot, lane.laneId, {
    type: 'steer', details: { inputSha256: 'd'.repeat(64) },
  }, fixture.env);
  updatePendingLaneOperation(fixture.repoRoot, lane.laneId, operation.operationId, { state: 'unknown' }, fixture.env);
  assert.throws(() => abandonPendingLaneOperation(
    fixture.repoRoot, lane.laneId, { reason: '' }, fixture.env,
  ), /single-line reason/);
  assert.throws(() => abandonPendingLaneOperation(
    fixture.repoRoot, lane.laneId, { reason: 'two\nlines' }, fixture.env,
  ), /single-line reason/);
  const result = abandonPendingLaneOperation(
    fixture.repoRoot, lane.laneId, { reason: 'operator crashed mid-steer' }, fixture.env,
  );
  assert.equal(result.operation.state, 'failed');
  assert.equal(result.operation.details.inputSha256, 'd'.repeat(64));
  assert.equal(result.operation.details.abandoned.reason, 'operator crashed mid-steer');
  assert.equal(result.operation.details.abandoned.fromState, 'unknown');
  assert.equal(result.operation.details.providerOutcome, 'unknown');
  assert.equal(result.lane.state, 'active');
  assert.equal(result.lane.providerId, 'abandon-provider');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  const next = beginLaneOperation(fixture.repoRoot, lane.laneId, { type: 'retire' }, fixture.env);
  assert.throws(() => abandonPendingLaneOperation(
    fixture.repoRoot, lane.laneId, { reason: 'retire stuck' }, fixture.env,
  ), /retire operation cannot be abandoned/);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).operationId, next.operationId);
});

// Journal writers in the adapters and the state module. A state literal in the
// first argument object after one of these calls must belong to some journal
// enum; states chosen through variables are covered by the adapter suites.
const JOURNAL_WRITERS = /\b(?:updatePending|completePending|updateOperationJournal|completeOperationJournal|beginOperation|operationForType|beginLaneOperation|updatePendingLaneOperation|completeLaneOperation|reserveSpawn)\(/gu;

test('every operation state literal handed to a journal writer belongs to an enumerated journal type', () => {
  const journalStates = new Set();
  for (const states of OPERATION_STATES.values()) for (const state of states) journalStates.add(state);
  const unknown = [];
  for (const file of ['codex-adapter.js', 'claude-adapter.js', 'state.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', file), 'utf8');
    for (const call of source.matchAll(JOURNAL_WRITERS)) {
      const window = source.slice(call.index, source.indexOf(');', call.index) + 1);
      const state = /\bstate: '([A-Za-z]+)'/u.exec(window);
      if (state && !journalStates.has(state[1])) unknown.push(`${file}: ${state[1]}`);
    }
  }
  assert.deepEqual(unknown, []);
  assert.ok(LANE_TRANSITIONS.get('planned').has('failed'), 'an unbound abandoned spawn lane must be able to fail');
});

test('a spawn reservation records its launcher and the crash repair spares a live one', (t) => {
  const fixture = createStateFixture(t);
  const laneId = '77887788-7788-4788-8788-778877887788';
  const operationId = '88998899-8899-4899-8899-889988998899';
  const seatIntent = {
    version: 1, laneId, path: '/tmp/transmogrify-worktrees/launcher', worktreesRoot: '/tmp/transmogrify-worktrees',
    gitCommonDir: '/tmp/repository/.git', branchRef: 'refs/heads/transmogrify/launcher', baseCommit: 'a'.repeat(40), managed: true,
  };
  const reserved = reserveSpawn(fixture.repoRoot, {
    operation: { operationId, type: 'spawn', laneId, details: { target: 'codex', name: '[test] launcher' } },
    lane: { laneId, backend: 'codex-app-server', displayName: '[test] launcher', operationId, seatIntent },
  }, fixture.env);
  assert.equal(reserved.operation.details.spawner.pid, process.pid);
  assert.equal(typeof reserved.operation.details.spawner.processBirth, 'string');
  const { repairUnstartedSpawn } = require('../scripts/lib/state');
  assert.equal(repairUnstartedSpawn(fixture.repoRoot, laneId, null, fixture.env), null, 'this process is the launcher and is alive');
  const dead = { kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } };
  const repaired = repairUnstartedSpawn(fixture.repoRoot, laneId, null, fixture.env, dead);
  assert.deepEqual(repaired.repaired, ['unstartedSpawnState', 'unstartedSpawnOperation']);
  assert.equal(repaired.lane.state, 'failed');
  // An explicit launcher on the reservation is kept as supplied.
  const explicitLane = '99aa99aa-99aa-499a-899a-99aa99aa99aa';
  const explicitOp = 'aabbaabb-aabb-4abb-8abb-aabbaabbaabb';
  const explicit = reserveSpawn(fixture.repoRoot, {
    operation: { operationId: explicitOp, type: 'spawn', laneId: explicitLane, details: { target: 'codex', spawner: { pid: 4242, processBirth: 'x' } } },
    lane: { laneId: explicitLane, backend: 'codex-app-server', displayName: '[test] explicit launcher', operationId: explicitOp, seatIntent: { ...seatIntent, laneId: explicitLane, path: '/tmp/transmogrify-worktrees/explicit', branchRef: 'refs/heads/transmogrify/explicit' } },
  }, fixture.env);
  assert.deepEqual(explicit.operation.details.spawner, { pid: 4242, processBirth: 'x' });
});
