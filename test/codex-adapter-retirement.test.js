'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { recover, retire, spawn } = require('../scripts/lib/codex-adapter');
const {
  listLanes, listOperations, pendingOperationForLane, registerLane,
} = require('../scripts/lib/state');
const { createManagedSeat } = require('../scripts/lib/worktree');
const { NO_RESPONSE, startMockAppServer } = require('./helpers/mock-app-server');
const { createRepoWithSeat } = require('./helpers/repo-fixture');

function spawnOptions(fixture, url) {
  return {
    repoRoot: fixture.repoRoot,
    worktrees: fixture.worktreesRoot,
    cwd: fixture.seat,
    url,
    allowProtocolOnly: true,
    name: 'unresolved first turn',
    input: 'Return one short sentence without using tools.',
    turnStartTimeoutMs: 25,
  };
}

function unresolvedServer(fixture, overrides = {}) {
  const cwd = fs.realpathSync(fixture.seat);
  const counters = { turnStarts: 0, archives: 0 };
  let clientUserMessageId;
  let dispatchedInput;
  const server = startMockAppServer((request) => {
    if (overrides[request.method]) {
      return overrides[request.method](request, { cwd, clientUserMessageId, dispatchedInput });
    }
    switch (request.method) {
      case 'thread/start': return { result: { cwd, thread: { id: 'thread-unresolved', cwd } } };
      case 'turn/start':
        counters.turnStarts += 1;
        clientUserMessageId = request.params.clientUserMessageId;
        dispatchedInput = request.params.input;
        return NO_RESPONSE;
      case 'thread/read':
        return { result: { thread: { id: 'thread-unresolved', cwd, name: cwd, status: { type: 'idle' } } } };
      case 'thread/turns/list': return { result: { data: [] } };
      case 'thread/items/list': return { result: { data: [], nextCursor: null } };
      case 'thread/archive': counters.archives += 1; return { result: {} };
      case 'thread/list':
        return { result: { data: [{ id: 'thread-unresolved', cwd }], nextCursor: null } };
      default: throw new Error(`unexpected ${request.method}`);
    }
  });
  return { server, counters };
}

test('Codex retire closes an unresolved first-turn spawn journal without replaying input', async (t) => {
  const fixture = createRepoWithSeat(t);
  const { server: pending, counters } = unresolvedServer(fixture);
  const server = await pending;
  t.after(() => server.close());

  await assert.rejects(() => spawn(spawnOptions(fixture, server.url), fixture.env), /timeout awaiting turn\/start/);
  const lane = listLanes(fixture.repoRoot, fixture.env)[0];
  assert.equal(lane.state, 'deliveryUnknown');
  const recovered = await recover({ repoRoot: fixture.repoRoot, url: server.url }, fixture.env);
  assert.equal(recovered.ok, false);
  assert.equal(recovered.recovered[0].pendingOperation, 'spawn');
  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot, laneId: lane.laneId, url: server.url,
  }, fixture.env), (error) => error.code === 'USAGE_ERROR');

  const retired = await retire({
    repoRoot: fixture.repoRoot, laneId: lane.laneId, url: server.url,
    harvestedOutputSha256: 'c'.repeat(64),
  }, fixture.env);
  assert.equal(retired.state, 'archivedVerified');
  assert.equal(retired.receipt.archived, true);
  assert.equal(counters.turnStarts, 1);
  assert.equal(counters.archives, 1);
  const operations = listOperations(fixture.repoRoot, fixture.env);
  const spawnOperation = operations.find((operation) => operation.type === 'spawn');
  assert.equal(spawnOperation.state, 'failed');
  assert.equal(spawnOperation.details.supersededBy, 'retire');
  assert.equal(spawnOperation.details.turnOutcome, 'notObserved');
  assert.equal(spawnOperation.details.inputSha256.length, 64);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  const after = await recover({ repoRoot: fixture.repoRoot, url: server.url }, fixture.env);
  assert.equal(after.ok, true);
});

test('Codex retire refuses to close an unresolved spawn while the newest turn is active', async (t) => {
  const fixture = createRepoWithSeat(t);
  const { server: pending, counters } = unresolvedServer(fixture, {
    'thread/turns/list': () => ({ result: { data: [{ id: 'turn-late', status: 'inProgress', items: [] }] } }),
    'thread/read': (request, { cwd }) => ({ result: { thread: {
      id: 'thread-unresolved', cwd, name: cwd, status: { type: 'active', activeFlags: [] },
    } } }),
  });
  const server = await pending;
  t.after(() => server.close());

  await assert.rejects(() => spawn(spawnOptions(fixture, server.url), fixture.env), /timeout awaiting turn\/start/);
  const lane = listLanes(fixture.repoRoot, fixture.env)[0];
  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot, laneId: lane.laneId, url: server.url,
    harvestedOutputSha256: 'c'.repeat(64),
  }, fixture.env), (error) => error.code === 'TARGET_ACTIVE');
  assert.equal(counters.archives, 0);
  assert.equal(counters.turnStarts, 1);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).state, 'unknown');
  assert.equal(listOperations(fixture.repoRoot, fixture.env)[0].type, 'spawn');
});

test('Codex retire completes an unresolved spawn journal when the persisted input receipt exists', async (t) => {
  const fixture = createRepoWithSeat(t);
  const { server: pending, counters } = unresolvedServer(fixture, {
    'thread/turns/list': () => ({ result: { data: [{ id: 'turn-landed', status: 'completed', items: [] }] } }),
    'thread/items/list': (request, { clientUserMessageId, dispatchedInput }) => ({ result: { data: [{
      turnId: 'turn-landed',
      item: { id: 'user-landed', type: 'userMessage', clientId: clientUserMessageId, content: dispatchedInput },
    }], nextCursor: null } }),
  });
  const server = await pending;
  t.after(() => server.close());

  await assert.rejects(() => spawn(spawnOptions(fixture, server.url), fixture.env), /timeout awaiting turn\/start/);
  const lane = listLanes(fixture.repoRoot, fixture.env)[0];
  const retired = await retire({
    repoRoot: fixture.repoRoot, laneId: lane.laneId, url: server.url,
    harvestedOutputSha256: 'c'.repeat(64),
  }, fixture.env);
  assert.equal(retired.state, 'archivedVerified');
  assert.equal(counters.turnStarts, 1);
  assert.equal(counters.archives, 1);
  const spawnOperation = listOperations(fixture.repoRoot, fixture.env).find((operation) => operation.type === 'spawn');
  assert.equal(spawnOperation.state, 'complete');
  assert.equal(spawnOperation.details.recoveredTurnId, 'turn-landed');
});

test('Codex retire completes a blocked managed seat only after exact manual-removal acknowledgement', async (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = '77777777-7777-4777-8777-777777777777';
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  fs.writeFileSync(`${seat.path}/.gitignore`, 'ignored/\n');
  execFileSync('git', ['-C', seat.path, 'add', '.gitignore']);
  execFileSync('git', ['-C', seat.path, 'commit', '-qm', 'ignore cleanup fixture']);
  let archiveCalls = 0;
  const changed = `${seat.path}/ignored/changed-after-harvest.txt`;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return { result: { thread: { id: 'thread-manual', cwd: seat.path, status: { type: 'idle' } } } };
    }
    if (request.method === 'thread/turns/list') return { result: { data: [] } };
    if (request.method === 'thread/archive') {
      archiveCalls += 1;
      fs.mkdirSync(`${seat.path}/ignored`, { recursive: true });
      fs.writeFileSync(changed, 'post-harvest change\n');
      return { result: {} };
    }
    if (request.method === 'thread/list') {
      return { result: { data: [{ id: 'thread-manual', cwd: seat.path }], nextCursor: null } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  registerLane(fixture.repoRoot, {
    laneId,
    backend: 'codex-app-server',
    providerId: 'thread-manual',
    displayName: '[test] manual removal',
    state: 'idle',
    runtime: {
      endpoint: new URL(server.url).toString(),
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
    },
    seat,
  }, fixture.env);

  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot, laneId, url: server.url,
    harvestedOutputSha256: 'd'.repeat(64), archiveVerifyAttempts: 1,
  }, fixture.env), (error) => error.code === 'CLEANUP_BLOCKED' && error.details.providerRetired === true);
  assert.equal(pendingOperationForLane(fixture.repoRoot, laneId, fixture.env).details.cleanupBlocked, true);

  // The acknowledgement flag is refused while the seat entry still exists.
  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot, laneId, url: server.url, acceptManualSeatRemoval: true,
  }, fixture.env), (error) => error.code === 'CLEANUP_BLOCKED');
  assert.equal(fs.existsSync(seat.path), true);

  execFileSync('git', ['-C', fixture.repoRoot, 'worktree', 'remove', '--force', '--', seat.path]);
  fs.symlinkSync(path.join(fixture.root, 'missing-seat-target'), seat.path);
  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot, laneId, url: server.url, acceptManualSeatRemoval: true,
  }, fixture.env), (error) => error.code === 'CLEANUP_BLOCKED');
  fs.unlinkSync(seat.path);
  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot, laneId, url: server.url,
  }, fixture.env), (error) => error.code === 'CLEANUP_BLOCKED');
  const requestsBefore = server.requests.length;

  const reviewed = await retire({
    repoRoot: fixture.repoRoot, laneId, url: server.url, acceptManualSeatRemoval: true,
  }, fixture.env);
  assert.equal(reviewed.state, 'worktreeRemoved');
  assert.equal(reviewed.receipt.worktreeRemoved, true);
  assert.equal(archiveCalls, 1);
  assert.equal(server.requests.length, requestsBefore);
  assert.equal(pendingOperationForLane(fixture.repoRoot, laneId, fixture.env), null);
  const lane = listLanes(fixture.repoRoot, fixture.env).find((entry) => entry.laneId === laneId);
  assert.equal(lane.state, 'worktreeRemoved');
  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot, laneId: '66666666-6666-4666-8666-666666666666', url: server.url,
    acceptManualSeatRemoval: true,
  }, fixture.env), (error) => /NOT_OWNED/.test(error.message) || error.code === 'NOT_OWNED');
});
