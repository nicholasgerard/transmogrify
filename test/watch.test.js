'use strict';

// The watcher observes through the same path wait uses and wakes the parent
// at most once per event. These tests inject the observer, the wake
// delivery, the process table, and the detached launcher, so no child, no
// session, and no runtime is touched.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  createParentContext, loadParentContext, recordEvent, recordParentWake, reserveDispatch, acknowledgeEvent,
} = require('../scripts/lib/dispatch');
const { registerLane } = require('../scripts/lib/state');
const {
  ensureWatcher, main, outstandingChildren, runWatcher, runningWatcher, watchOnce, watcherPaths,
} = require('../scripts/watch');
const { createStateFixture } = require('./helpers/state-fixture');

const BRIDGE = 'session_watchBridge1';

function parentWithChild(t, options = {}) {
  const fixture = createStateFixture(t);
  const context = createParentContext({ hostProvider: 'claude', hostApp: 'claude-code', displayName: 'Watched parent' }, fixture.env);
  if (options.wake !== 'none') {
    recordParentWake(context, { channel: 'claude-bridge', id: BRIDGE, cwd: null, receipt: { source: 'test' } }, fixture.env);
  }
  const laneId = crypto.randomUUID();
  const reserved = reserveDispatch({
    parentContext: context, repoRoot: fixture.repoRoot, laneId, targetProvider: 'codex',
    backend: 'codex-app-server', displayName: '::: watched child', prompt: 'Work.',
  }, fixture.env);
  registerLane(fixture.repoRoot, {
    laneId, backend: 'codex-app-server', target: 'codex', providerId: 'thread-w', displayName: '::: watched child',
    state: options.laneState || 'active', runtime: { endpoint: 'ws://127.0.0.1:1/' }, lineage: reserved.lineage,
  }, fixture.env);
  return { fixture, context: loadParentContext(context.file, fixture.env), dispatch: reserved.dispatch, laneId };
}

// A process table where only the pids in `alive` exist, all born at the same time.
function processTable(alive) {
  return {
    kill: (pid) => { if (!alive.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
    processBirth: () => 'Tue Sep  1 15:00:00 2026',
  };
}

test('ensureWatcher starts one detached watcher per parent and reuses a live one', (t) => {
  const { fixture, context } = parentWithChild(t);
  const launches = [];
  const alive = new Set([4242]);
  const deps = { ...processTable(alive), spawnDetached: (executable, args) => { launches.push({ executable, args }); return 4242; } };
  const first = ensureWatcher(context.file, { repoRoot: fixture.repoRoot }, fixture.env, deps);
  assert.deepEqual(first, { running: true, started: true, pid: 4242 });
  assert.equal(launches.length, 1);
  assert.ok(launches[0].args.includes('--parent-context-file') && launches[0].args.includes(context.file));
  assert.equal(runningWatcher(context.parent.parentRef, fixture.env, deps), null, 'no record until the watcher itself writes one');

  // The watcher writes its record; a later ensure sees it running.
  const paths = watcherPaths(context.parent.parentRef, fixture.env);
  require('node:fs').mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  require('node:fs').writeFileSync(paths.record, JSON.stringify({ pid: 4242, processBirth: 'Tue Sep  1 15:00:00 2026', parentRef: context.parent.parentRef }));
  const second = ensureWatcher(context.file, {}, fixture.env, deps);
  assert.deepEqual(second, { running: true, started: false, pid: 4242 });
  assert.equal(launches.length, 1);

  // A dead pid's record is stale and a new watcher starts.
  alive.delete(4242);
  const third = ensureWatcher(context.file, {}, fixture.env, deps);
  assert.equal(third.started, true);
  assert.equal(launches.length, 2);
});

test('watchOnce wakes the parent once per event of a kind that needs it and keeps observing', async (t) => {
  const { fixture, context, dispatch } = parentWithChild(t);
  const delivered = [];
  const deliver = async (wake, text, options) => {
    delivered.push({ channel: wake.channel, bridgeId: wake.bridgeId, text, clientUserMessageId: options.clientUserMessageId });
    return { channel: 'claude-bridge', delivered: true };
  };
  const observe = async () => {
    recordEvent({ dispatchId: dispatch.dispatchId, type: 'child.spawned', fingerprint: 'spawn:1', data: { state: 'spawned' } }, fixture.env);
    recordEvent({ dispatchId: dispatch.dispatchId, type: 'child.turn-completed', fingerprint: 'turn:1', data: { state: 'idle' } }, fixture.env);
    return { dispatches: [dispatch], errors: [], observed: [{ dispatchId: dispatch.dispatchId, phase: 'idle' }] };
  };
  const state = { wakedEventIds: [] };
  const first = await watchOnce(context, {}, fixture.env, state, { observe, deliver });
  assert.equal(first.wakes.length, 1, 'progress events never wake; completion does');
  assert.equal(first.wakes[0].kind, 'complete');
  assert.equal(first.wakes[0].delivered, true);
  assert.equal(delivered[0].bridgeId, BRIDGE);
  assert.match(delivered[0].text, /completed its task and is idle/);
  assert.match(delivered[0].text, new RegExp(`--parent-context-file "${context.file}"`));
  assert.equal(delivered[0].clientUserMessageId, first.wakes[0].eventId);
  assert.equal(first.working, false);

  const second = await watchOnce(context, {}, fixture.env, state, { observe, deliver });
  assert.equal(second.wakes.length, 0, 'the same event is never delivered twice');
  assert.equal(delivered.length, 1);

  const failing = async () => { throw Object.assign(new Error('bridge gone'), { code: 'WAKE_UNDELIVERED' }); };
  const observeMore = async () => {
    recordEvent({ dispatchId: dispatch.dispatchId, type: 'child.failed', fingerprint: 'fail:1', data: { state: 'failed' } }, fixture.env);
    return { dispatches: [dispatch], errors: [], observed: [] };
  };
  const third = await watchOnce(context, {}, fixture.env, state, { observe: observeMore, deliver: failing });
  assert.deepEqual(third.wakes.map((wake) => [wake.kind, wake.delivered, wake.code]), [['terminal', false, 'WAKE_UNDELIVERED']]);
});

test('a parent without a wake channel is observed but never messaged', async (t) => {
  const { fixture, context, dispatch } = parentWithChild(t, { wake: 'none' });
  let delivered = 0;
  const observe = async () => {
    recordEvent({ dispatchId: dispatch.dispatchId, type: 'child.turn-completed', fingerprint: 'turn:1', data: { state: 'idle' } }, fixture.env);
    return { dispatches: [dispatch], errors: [], observed: [] };
  };
  const pass = await watchOnce(context, {}, fixture.env, { wakedEventIds: [] }, { observe, deliver: async () => { delivered += 1; } });
  assert.deepEqual(pass.wakes.map((wake) => wake.code), ['WAKE_UNAVAILABLE']);
  assert.equal(delivered, 0);
});

test('outstanding children are those with pending events or lanes still running', (t) => {
  const { fixture, context, dispatch, laneId } = parentWithChild(t, { laneState: 'worktreeRemoved' });
  assert.equal(outstandingChildren(context, fixture.env).length, 0, 'a retired child with nothing pending is settled');
  const event = recordEvent({ dispatchId: dispatch.dispatchId, type: 'child.retired', fingerprint: 'retired:1', data: { state: 'retired' } }, fixture.env);
  assert.equal(outstandingChildren(context, fixture.env).length, 1, 'an unacknowledged event keeps it outstanding');
  acknowledgeEvent(context, event.eventId, fixture.env);
  assert.equal(outstandingChildren(context, fixture.env).length, 0);
  const active = parentWithChild(t);
  assert.equal(outstandingChildren(active.context, active.fixture.env).length, 1, 'an active lane is outstanding');
  void laneId;
});

test('runWatcher records itself, runs bounded rounds, and reports through --status', async (t) => {
  const { fixture, context, dispatch } = parentWithChild(t);
  const observe = async () => ({ dispatches: [dispatch], errors: [], observed: [{ dispatchId: dispatch.dispatchId, phase: 'working' }] });
  const deps = { observe, deliver: async () => ({ delivered: true }), processBirth: () => 'birth', sleep: async () => {}, maxRounds: 2 };
  const result = await runWatcher({ parentContextFile: context.file, idleExitMs: 1 }, fixture.env, deps);
  assert.equal(result.operation, 'watch');
  assert.equal(result.outcome, 'roundsExhausted');
  assert.equal(result.rounds, 2);
  const status = await main(['--parent-context-file', context.file, '--status'], fixture.env);
  assert.equal(status.outcome, 'stopped');
  await assert.rejects(() => main(['--parent-context-file', 'relative/path'], fixture.env), (error) => error.code === 'USAGE_ERROR');
});
