'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { main } = require('../scripts/lane');
const { retire: retireCodex, spawn: spawnCodex } = require('../scripts/lib/codex-adapter');
const {
  countEvents, createParentContext, pathsFor, reserveDispatch, listDispatches, recordEvent,
} = require('../scripts/lib/dispatch');
const {
  completeLaneOperation, ensureRegistry, listLanes, listOperations, pendingOperationForLane,
  registerLane, reserveSpawn, updateLane,
} = require('../scripts/lib/state');
const { verifySeat } = require('../scripts/lib/worktree');
const { NO_RESPONSE, startMockAppServer } = require('./helpers/mock-app-server');
const { createRepoWithSeat } = require('./helpers/repo-fixture');

const CATALOG = { data: [{
  id: 'sol-id',
  model: 'gpt-5.6-sol',
  displayName: 'GPT-5.6 Sol',
  description: 'Flagship',
  hidden: false,
  isDefault: true,
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Low' },
    { reasoningEffort: 'high', description: 'High' },
  ],
  defaultReasoningEffort: 'low',
  serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Premium fast speed' }],
  defaultServiceTier: null,
}], nextCursor: null };

function runtimeFor(url) {
  return {
    endpoint: new URL(url).toString(),
    codexHome: '/tmp/codex-home',
    platformFamily: 'unix',
    platformOs: 'test',
  };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function rewriteDispatch(env, dispatchId, patch) {
  const file = path.join(pathsFor(env).dispatches, `${dispatchId}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, `${JSON.stringify({ ...record, ...patch })}\n`, { mode: 0o600 });
}

test('parent wait observes every child each round so a busy child cannot starve a terminal one', async (t) => {
  const fixture = createRepoWithSeat(t);
  const parentContext = createParentContext({
    hostProvider: 'codex', hostApp: 'codex-desktop', displayName: 'Starvation parent',
  }, fixture.env);
  const cwd = fs.realpathSync(fixture.seat);
  let turnCounter = 0;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return { result: { thread: { id: 'thread-a', cwd, name: '::: chatty child', status: { type: 'idle' } } } };
    }
    if (request.method === 'thread/turns/list') {
      turnCounter += 1;
      return { result: { data: [{ id: `turn-${turnCounter}`, status: 'completed', items: [] }] } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());

  const laneA = crypto.randomUUID();
  const a = reserveDispatch({
    parentContext, repoRoot: fixture.repoRoot, laneId: laneA, targetProvider: 'codex',
    backend: 'codex-app-server', displayName: '::: chatty child', prompt: 'Chat.',
  }, fixture.env);
  registerLane(fixture.repoRoot, {
    laneId: laneA, backend: 'codex-app-server', target: 'codex', providerId: 'thread-a',
    displayName: '::: chatty child', state: 'idle', runtime: runtimeFor(server.url),
    seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot), lineage: a.lineage,
  }, fixture.env);

  await sleep(10);
  const laneB = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const b = reserveDispatch({
    parentContext, repoRoot: fixture.repoRoot, laneId: laneB, targetProvider: 'codex',
    backend: 'codex-app-server', displayName: '::: quiet child', prompt: 'Work.',
  }, fixture.env);
  reserveSpawn(fixture.repoRoot, {
    operation: { operationId, type: 'spawn', laneId: laneB, details: { dispatchId: b.dispatch.dispatchId } },
    lane: {
      laneId: laneB, backend: 'codex-app-server', target: 'codex', displayName: '::: quiet child',
      state: 'planned', operationId, runtime: runtimeFor(server.url), seat: null, lineage: b.lineage,
    },
  }, fixture.env);
  updateLane(fixture.repoRoot, laneB, { state: 'failed' }, fixture.env);
  completeLaneOperation(fixture.repoRoot, laneB, operationId, { state: 'notDelivered' }, fixture.env);

  const result = await main([
    'wait', '--parent-context-file', parentContext.file, '--repo-root', fixture.repoRoot, '--timeout-ms', '10000',
  ], fixture.env);
  const byDispatch = new Map(result.events.map((event) => [event.dispatchId, event.type]));
  assert.equal(byDispatch.get(a.dispatch.dispatchId), 'child.turn-completed');
  assert.equal(byDispatch.get(b.dispatch.dispatchId), 'child.failed');
});

test('a child whose repository disappeared is reported and raises one attention event', async (t) => {
  const fixture = createRepoWithSeat(t);
  const parentContext = createParentContext({
    hostProvider: 'codex', hostApp: 'codex-desktop', displayName: 'Two repo parent',
  }, fixture.env);
  const repoB = path.join(fixture.root, 'repo-b');
  fs.mkdirSync(repoB);
  execFileSync('git', ['init', '--quiet', repoB]);
  ensureRegistry(repoB, fixture.env);
  const reserve = (repoRoot, displayName) => reserveDispatch({
    parentContext, repoRoot, laneId: crypto.randomUUID(), targetProvider: 'codex',
    backend: 'codex-app-server', displayName, prompt: 'Do the work.',
  }, fixture.env);
  reserve(fixture.repoRoot, '::: child in repo a');
  const childB = reserve(repoB, '::: child in repo b');
  rewriteDispatch(fixture.env, childB.dispatch.dispatchId, {
    createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  });
  fs.rmSync(repoB, { recursive: true, force: true });

  const children = await main(['children', '--parent-context-file', parentContext.file], fixture.env);
  assert.equal(children.children.length, 2);
  const orphan = children.children.find((child) => child.dispatchId === childB.dispatch.dispatchId);
  assert.equal(orphan.laneObservation, 'repository-unavailable');

  const waited = await main([
    'wait', '--parent-context-file', parentContext.file, '--timeout-ms', '10000',
  ], fixture.env);
  assert.equal(waited.events.length, 1);
  assert.equal(waited.events[0].dispatchId, childB.dispatch.dispatchId);
  assert.equal(waited.events[0].type, 'child.needs-attention');
  await main(['ack', '--parent-context-file', parentContext.file, '--event', waited.events[0].eventId], fixture.env);
  await assert.rejects(() => main([
    'wait', '--parent-context-file', parentContext.file, '--timeout-ms', '2000',
  ], fixture.env), (error) => error.code === 'NO_EVENT');
  assert.equal(countEvents(parentContext, {}, fixture.env), 0);
});

test('an unresolved first-turn spawn wakes the parent once and can be retired without replay', async (t) => {
  const fixture = createRepoWithSeat(t);
  const parentContext = createParentContext({
    hostProvider: 'claude', hostApp: 'claude-desktop', displayName: 'Unresolved spawn parent',
  }, fixture.env);
  const cwd = fs.realpathSync(fixture.seat);
  let turnStarts = 0;
  let archives = 0;
  const server = await startMockAppServer((request) => {
    switch (request.method) {
      case 'model/list': return { result: CATALOG };
      case 'thread/start': return { result: { cwd, thread: { id: 'thread-unresolved', cwd } } };
      case 'turn/start': turnStarts += 1; return NO_RESPONSE;
      case 'thread/read':
        return { result: { thread: { id: 'thread-unresolved', cwd, name: cwd, status: { type: 'idle' } } } };
      case 'thread/turns/list': return { result: { data: [] } };
      case 'thread/items/list': return { result: { data: [], nextCursor: null } };
      case 'thread/archive': archives += 1; return { result: {} };
      case 'thread/list':
        return { result: { data: [{ id: 'thread-unresolved', cwd }], nextCursor: null } };
      default: throw new Error(`unexpected ${request.method}`);
    }
  });
  t.after(() => server.close());

  await assert.rejects(() => spawnCodex({
    repoRoot: fixture.repoRoot, worktrees: fixture.worktreesRoot, cwd: fixture.seat, url: server.url,
    allowProtocolOnly: true, name: 'unresolved', input: 'never lands', parentContext,
    turnStartTimeoutMs: 25,
  }, fixture.env), /timeout awaiting turn\/start/);
  assert.equal(turnStarts, 1);
  const lane = listLanes(fixture.repoRoot, fixture.env)[0];
  assert.equal(lane.state, 'deliveryUnknown');

  const waitFor = (timeoutMs) => [
    'wait', '--parent-context-file', parentContext.file, '--repo-root', fixture.repoRoot,
    '--timeout-ms', String(timeoutMs),
  ];
  const waitArgs = waitFor(10000);
  const first = await main(waitArgs, fixture.env);
  assert.deepEqual(first.events.map((event) => event.type), ['child.needs-attention']);
  await main(['ack', '--parent-context-file', parentContext.file, '--event', first.events[0].eventId], fixture.env);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).state, 'unknown');
  // Each no-event wait must still complete a full non-replaying reconciliation
  // round within its budget before it expires, so keep the deadline generous.
  await assert.rejects(() => main(waitFor(6000), fixture.env), (error) => error.code === 'NO_EVENT');
  await assert.rejects(() => main(waitFor(6000), fixture.env), (error) => error.code === 'NO_EVENT');

  const retired = await retireCodex({
    repoRoot: fixture.repoRoot, laneId: lane.laneId, url: server.url,
    harvestedOutputSha256: 'c'.repeat(64),
  }, fixture.env);
  assert.equal(retired.state, 'archivedVerified');
  assert.equal(turnStarts, 1);
  assert.equal(archives, 1);
  const operations = listOperations(fixture.repoRoot, fixture.env);
  const spawnOperation = operations.find((operation) => operation.type === 'spawn');
  assert.equal(spawnOperation.state, 'failed');
  assert.equal(spawnOperation.details.supersededBy, 'retire');
  assert.equal(spawnOperation.details.turnOutcome, 'notObserved');
  assert.equal(operations.find((operation) => operation.type === 'retire').state, 'complete');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);

  // The retirement was the parent's own command: its observation is recorded
  // already acknowledged, so nothing wakes the parent for what it just did.
  const third = await main(['wait', '--parent-context-file', parentContext.file, '--repo-root', fixture.repoRoot, '--timeout-ms', '3000'], fixture.env)
    .catch((error) => error);
  assert.equal(third.code, 'NO_EVENT');
  const children = await main(['children', '--parent-context-file', parentContext.file], fixture.env);
  assert.equal(children.children[0].state, 'archivedVerified');
  assert.equal(children.children[0].unacknowledgedEvents, 0);
});

test('a verified spawn whose parent event cannot be recorded reports the provider effect as verified', async (t) => {
  const fixture = createRepoWithSeat(t);
  const parentContext = createParentContext({
    hostProvider: 'codex', hostApp: 'codex-desktop', displayName: 'Broken event store parent',
  }, fixture.env);
  const eventDirectory = path.join(pathsFor(fixture.env).events, parentContext.parent.parentRef);
  fs.mkdirSync(eventDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(eventDirectory, `${crypto.randomUUID()}.json`), '{}\n', { mode: 0o600 });
  const cwd = fs.realpathSync(fixture.seat);
  const server = await startMockAppServer((request) => {
    switch (request.method) {
      case 'model/list': return { result: CATALOG };
      case 'thread/start': return { result: { cwd, thread: { id: 'thread-verified', cwd } } };
      case 'turn/start':
        return { result: { turn: { id: 'turn-verified', status: 'inProgress', items: [{
          id: 'user-1', type: 'userMessage', clientId: request.params.clientUserMessageId,
          content: request.params.input,
        }] } } };
      case 'thread/name/set': return { result: {} };
      case 'thread/read':
        return { result: { thread: {
          id: 'thread-verified', cwd, name: '::: verified child', status: { type: 'active', activeFlags: [] },
        } } };
      default: throw new Error(`unexpected ${request.method}`);
    }
  });
  t.after(() => server.close());

  await assert.rejects(() => spawnCodex({
    repoRoot: fixture.repoRoot, worktrees: fixture.worktreesRoot, cwd: fixture.seat, url: server.url,
    allowProtocolOnly: true, name: 'verified child', input: 'Do the work.', parentContext,
  }, fixture.env), (error) =>
    error.code === 'PARENT_EVENT_UNRECORDED' && error.details.providerMutation === 'verified' &&
    error.details.phase === 'parentEvent'
  );
  assert.equal(server.requests.filter((request) => request.method === 'turn/start').length, 1);
  const lane = listLanes(fixture.repoRoot, fixture.env)[0];
  assert.equal(lane.state, 'active');
  assert.equal(lane.providerId, 'thread-verified');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  assert.equal(listOperations(fixture.repoRoot, fixture.env)[0].state, 'complete');
});

test('parent wait names each child whose observation failed', async (t) => {
  const fixture = createRepoWithSeat(t);
  const parentContext = createParentContext({
    hostProvider: 'codex', hostApp: 'codex-desktop', displayName: 'Observation parent',
  }, fixture.env);
  const server = await startMockAppServer(() => { throw new Error('unexpected'); });
  const laneId = crypto.randomUUID();
  const dispatch = reserveDispatch({
    parentContext, repoRoot: fixture.repoRoot, laneId, targetProvider: 'codex',
    backend: 'codex-app-server', displayName: '::: unreachable child', prompt: 'Work.',
  }, fixture.env);
  registerLane(fixture.repoRoot, {
    laneId, backend: 'codex-app-server', target: 'codex', providerId: 'thread-gone',
    displayName: '::: unreachable child', state: 'idle', runtime: runtimeFor(server.url),
    seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot), lineage: dispatch.lineage,
  }, fixture.env);
  // The runtime this child was recorded on is gone, so its observation fails.
  server.close();
  await sleep(50);
  await assert.rejects(
    () => main([
      'wait', '--parent-context-file', parentContext.file, '--repo-root', fixture.repoRoot, '--timeout-ms', '3000',
    ], fixture.env),
    (error) => error.code === 'OBSERVATION_FAILED' && error.details.attempted === 1 &&
      error.details.failures.length === 1 && error.details.failures[0].dispatchId === dispatch.dispatch.dispatchId &&
      typeof error.details.failures[0].code === 'string',
  );
});

test('parent wait observes first, returns old and new events together, and honours --until', async (t) => {
  const fixture = createRepoWithSeat(t);
  const parentContext = createParentContext({
    hostProvider: 'claude', hostApp: 'claude-code', displayName: 'Kinds parent',
  }, fixture.env);
  const cwd = fs.realpathSync(fixture.seat);
  let turnId = 'turn-1';
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return { result: { thread: { id: 'thread-k', cwd, name: '::: kinds child', status: { type: 'idle' } } } };
    }
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{ id: turnId, status: 'completed', items: [] }] } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  const laneId = crypto.randomUUID();
  const dispatch = reserveDispatch({
    parentContext, repoRoot: fixture.repoRoot, laneId, targetProvider: 'codex',
    backend: 'codex-app-server', displayName: '::: kinds child', prompt: 'Work.',
  }, fixture.env);
  registerLane(fixture.repoRoot, {
    laneId, backend: 'codex-app-server', target: 'codex', providerId: 'thread-k',
    displayName: '::: kinds child', state: 'idle', runtime: runtimeFor(server.url),
    seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot), lineage: dispatch.lineage,
  }, fixture.env);
  const waitArgs = (extra) => [
    'wait', '--parent-context-file', parentContext.file, '--repo-root', fixture.repoRoot, ...extra,
  ];

  const first = await main(waitArgs(['--timeout-ms', '5000']), fixture.env);
  assert.equal(first.until, 'any');
  assert.deepEqual(first.events.map((event) => [event.type, event.kind, event.terminal]),
    [['child.turn-completed', 'complete', false]]);
  assert.deepEqual(first.observed.map((entry) => [entry.laneId, entry.phase]), [[laneId, 'idle']]);

  // The first event stays unacknowledged; a new turn must still surface.
  turnId = 'turn-2';
  const second = await main(waitArgs(['--timeout-ms', '5000']), fixture.env);
  assert.deepEqual(second.events.map((event) => event.type), ['child.turn-completed', 'child.turn-completed']);
  assert.notEqual(second.events[0].eventId, second.events[1].eventId);

  await assert.rejects(() => main(waitArgs(['--timeout-ms', '300', '--until', 'terminal']), fixture.env),
    (error) => error.code === 'NO_EVENT' && error.details.pending === 2 && error.details.until === 'terminal');
  await assert.rejects(() => main(waitArgs(['--timeout-ms', '0', '--until', 'bogus']), fixture.env),
    (error) => error.code === 'USAGE_ERROR');

  const drained = await main(waitArgs(['--timeout-ms', '0', '--until', 'complete']), fixture.env);
  assert.equal(drained.events.length, 2);
  assert.deepEqual(drained.observed, []);

  const children = await main([
    'children', '--parent-context-file', parentContext.file, '--repo-root', fixture.repoRoot, '--observe',
  ], fixture.env);
  assert.equal(children.children[0].phase, 'idle');
  assert.equal(children.children[0].unacknowledgedEvents, 2);
  assert.equal(children.children[0].latestEventKind, 'complete');
  assert.equal(children.unacknowledgedEvents, 2);
});

test('observation leaves an in-flight spawn journal alone until its spawner is gone', async (t) => {
  const { spawnInFlight } = require('../scripts/lib/observe');
  const fixture = createRepoWithSeat(t);
  const parentContext = createParentContext({
    hostProvider: 'claude', hostApp: 'claude-code', displayName: 'In-flight parent',
  }, fixture.env);
  const laneId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const reserved = reserveDispatch({
    parentContext, repoRoot: fixture.repoRoot, laneId, targetProvider: 'codex',
    backend: 'codex-app-server', displayName: '::: in-flight child', prompt: 'Work.',
  }, fixture.env);
  reserveSpawn(fixture.repoRoot, {
    operation: { operationId, type: 'spawn', laneId, details: { dispatchId: reserved.dispatch.dispatchId } },
    lane: {
      laneId, backend: 'codex-app-server', target: 'codex', displayName: '::: in-flight child',
      state: 'planned', operationId, runtime: runtimeFor('ws://127.0.0.1:1/'), seat: null, lineage: reserved.lineage,
    },
  }, fixture.env);
  const pending = pendingOperationForLane(fixture.repoRoot, laneId, fixture.env);
  assert.equal(pending.details.spawner.pid, process.pid, 'the reservation records its launcher');
  assert.equal(spawnInFlight(pending), true, 'a live launcher keeps the journal in flight');
  const { spawner: _spawner, ...unrecorded } = pending.details;
  const withoutLauncher = { ...pending, details: unrecorded };
  assert.equal(spawnInFlight(withoutLauncher), true, 'a fresh journal without a launcher record is in flight');
  assert.equal(spawnInFlight({ ...withoutLauncher, createdAt: new Date(Date.now() - 6 * 60_000).toISOString() }), false);
  const alive = { ...pending, details: { ...pending.details, spawner: { pid: process.pid, processBirth: 'x' } } };
  assert.equal(spawnInFlight(alive, { processBirth: () => 'x' }), true, 'a live spawner keeps it in flight regardless of age');
  const dead = { ...pending, details: { ...pending.details, spawner: { pid: 999999, processBirth: 'x' } } };
  assert.equal(spawnInFlight(dead, { kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } }), false);

  // A wait during the in-flight window records nothing for that child and does
  // not settle its journal; the lane stays planned for the launcher.
  await assert.rejects(() => main([
    'wait', '--parent-context-file', parentContext.file, '--repo-root', fixture.repoRoot, '--timeout-ms', '300',
  ], fixture.env), (error) => error.code === 'NO_EVENT');
  assert.equal(pendingOperationForLane(fixture.repoRoot, laneId, fixture.env).state, 'planned');
  assert.equal(listLanes(fixture.repoRoot, fixture.env).find((lane) => lane.laneId === laneId).state, 'planned');
});

test('a retirement that is still progressing does not raise attention until it stalls', () => {
  const { retireInFlight } = require('../scripts/lib/observe');
  const fresh = { type: 'retire', state: 'remoteArchived', updatedAt: new Date().toISOString() };
  assert.equal(retireInFlight(fresh), true);
  assert.equal(retireInFlight({ ...fresh, updatedAt: new Date(Date.now() - 3 * 60_000).toISOString() }), false);
  assert.equal(retireInFlight({ ...fresh, state: 'providerRetiredCleanupBlocked' }), false, 'a real block is never transient');
  assert.equal(retireInFlight({ ...fresh, state: 'cleanupDeferred' }), false, 'a deliberate deferral is reported at once');
  assert.equal(retireInFlight({ type: 'steer', state: 'unknown', updatedAt: fresh.updatedAt }), false);
});

test('a reserved dispatch whose lane never appeared fails after the launcher grace period', async (t) => {
  const fixture = createRepoWithSeat(t);
  const parentContext = createParentContext({
    hostProvider: 'claude', hostApp: 'claude-code', displayName: 'Crashed spawn parent',
  }, fixture.env);
  const reserved = reserveDispatch({
    parentContext, repoRoot: fixture.repoRoot, laneId: crypto.randomUUID(), targetProvider: 'codex',
    backend: 'codex-app-server', displayName: '::: never reserved a lane', prompt: 'Do the work.',
  }, fixture.env);
  rewriteDispatch(fixture.env, reserved.dispatch.dispatchId, {
    createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  });

  // Inside the grace period the parent is only asked to look.
  const early = await main([
    'wait', '--parent-context-file', parentContext.file, '--timeout-ms', '10000',
  ], fixture.env);
  assert.deepEqual(early.events.map((event) => event.type), ['child.needs-attention']);
  await main(['ack', '--parent-context-file', parentContext.file, '--event', early.events[0].eventId], fixture.env);

  rewriteDispatch(fixture.env, reserved.dispatch.dispatchId, {
    createdAt: new Date(Date.now() - 6 * 60_000).toISOString(),
  });
  const waited = await main([
    'wait', '--parent-context-file', parentContext.file, '--timeout-ms', '10000',
  ], fixture.env);
  assert.deepEqual(waited.events.map((event) => [event.type, event.kind, event.terminal]), [['child.failed', 'terminal', true]]);
  assert.deepEqual(waited.events[0].data, { state: 'failed', status: 'spawn-not-registered' });
  assert.equal(listDispatches(parentContext, fixture.env)[0].state, 'failed');
  const children = await main(['children', '--parent-context-file', parentContext.file], fixture.env);
  assert.equal(children.children[0].state, 'failed');
  assert.equal(children.children[0].unacknowledgedEvents, 1);
  await main(['ack', '--parent-context-file', parentContext.file, '--event', waited.events[0].eventId], fixture.env);
  await assert.rejects(() => main([
    'wait', '--parent-context-file', parentContext.file, '--timeout-ms', '2000',
  ], fixture.env), (error) => error.code === 'NO_EVENT');
  assert.equal(countEvents(parentContext, {}, fixture.env), 0);
});

test('ack --through acknowledges every pending event up to a sequence and nothing after it', async (t) => {
  const fixture = createRepoWithSeat(t);
  const parentContext = createParentContext({
    hostProvider: 'claude', hostApp: 'claude-code', displayName: 'Batch ack parent',
  }, fixture.env);
  const reserved = reserveDispatch({
    parentContext, repoRoot: fixture.repoRoot, laneId: crypto.randomUUID(), targetProvider: 'codex',
    backend: 'codex-app-server', displayName: '::: batch child', prompt: 'Do the work.',
  }, fixture.env);
  const record = (type, fingerprint, state) => recordEvent({
    dispatchId: reserved.dispatch.dispatchId, type, fingerprint, data: { state },
  }, fixture.env);
  const first = record('child.spawned', 'spawn:1', 'spawned');
  const second = record('child.turn-completed', 'turn:1', 'idle');
  const third = record('child.needs-attention', 'attention:1', 'needs-attention');
  assert.deepEqual([first.sequence, second.sequence, third.sequence], [1, 2, 3]);

  await assert.rejects(() => main(['ack', '--parent-context-file', parentContext.file, '--through', '0'], fixture.env),
    (error) => error.code === 'USAGE_ERROR');
  await assert.rejects(() => main(['ack', '--parent-context-file', parentContext.file, '--through', '2', '--event', first.eventId], fixture.env),
    (error) => error.code === 'USAGE_ERROR');
  const acked = await main(['ack', '--parent-context-file', parentContext.file, '--through', '2'], fixture.env);
  assert.deepEqual(acked, {
    version: 1, ok: true, operation: 'ack', through: 2, acknowledged: [first.eventId, second.eventId], count: 2,
  });
  assert.equal(countEvents(parentContext, {}, fixture.env), 1);
  const again = await main(['ack', '--parent-context-file', parentContext.file, '--through', '2'], fixture.env);
  assert.deepEqual(again.acknowledged, [], 'already acknowledged events are not repeated');
  const single = await main(['ack', '--parent-context-file', parentContext.file, '--event', third.eventId], fixture.env);
  assert.deepEqual([single.eventId, single.acknowledged, single.count], [third.eventId, [third.eventId], 1]);
  assert.equal(countEvents(parentContext, {}, fixture.env), 0);
});
