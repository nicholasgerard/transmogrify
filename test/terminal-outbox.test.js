'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const state = require('../scripts/lib/state');
const dispatch = require('../scripts/lib/dispatch');
const { outstandingDispatches, observeParentChildren } = require('../scripts/lib/observe');
const { retire, interrupt } = require('../scripts/lib/codex-adapter');
const { watchOnce } = require('../scripts/watch');
const { publicResult } = require('../scripts/lib/output-schema');
const { verifySeat } = require('../scripts/lib/worktree');
const { createRepoWithSeat } = require('./helpers/repo-fixture');

function child(t, active = false) {
  const fixture = createRepoWithSeat(t);
  const context = dispatch.createParentContext({
    hostProvider: 'claude', hostApp: 'claude-code', displayName: 'Outbox parent',
  }, fixture.env);
  dispatch.recordParentWake(context, {
    channel: 'claude-bridge', id: 'session_outboxBridge', cwd: null, receipt: { source: 'test' },
  }, fixture.env);
  const loaded = dispatch.loadParentContext(context.file, fixture.env);
  const laneId = crypto.randomUUID();
  const reservation = dispatch.reserveDispatch({
    parentContext: loaded, repoRoot: fixture.repoRoot, laneId, targetProvider: 'codex',
    backend: 'codex-app-server', displayName: '::: outbox child', prompt: 'Work.',
  }, fixture.env);
  const runtime = { endpoint: 'ws://127.0.0.1:1/', codexHome: '/tmp/outbox-home', platformFamily: 'unix', platformOs: 'test' };
  const lane = state.registerLane(fixture.repoRoot, {
    laneId, target: 'codex', backend: 'codex-app-server', providerId: 'outbox-thread',
    displayName: '::: outbox child', lineage: reservation.lineage, state: active ? 'active' : 'idle', runtime,
    seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot),
  }, fixture.env);
  const calls = [];
  let interrupted = false;
  const clientFactory = () => ({
    verifiedRuntime: true, runtimeIdentity: runtime,
    async connect() { return { userAgent: 'fixture' }; }, close() {},
    async call(method) {
      calls.push(method);
      if (method === 'thread/read') return { thread: { id: lane.providerId, cwd: lane.seat.path, status: { type: active && !interrupted ? 'active' : 'idle', activeFlags: [] } } };
      if (method === 'thread/turns/list') return { data: active ? [{ id: 'outbox-turn', items: [], status: interrupted ? 'interrupted' : 'inProgress' }] : [] };
      if (method === 'turn/interrupt') { interrupted = true; return {}; }
      if (method === 'thread/archive') return {};
      if (method === 'thread/list') return { data: [{ id: lane.providerId, cwd: lane.seat.path }], nextCursor: null };
      throw new Error(`unexpected provider call ${method}`);
    },
  });
  const options = { repoRoot: fixture.repoRoot, laneId, url: runtime.endpoint, clientFactory, harvestedOutputSha256: 'c'.repeat(64) };
  return { ...fixture, context: loaded, lane, options, calls };
}

test('retirement without parent context publishes a pending unsuppressed event before returning its ack command', async (t) => {
  const fixture = child(t);
  const result = await retire(fixture.options, fixture.env);
  const [event] = dispatch.listEvents(fixture.context, {}, fixture.env);
  assert.equal(event.type, 'child.retired');
  assert.equal(event.wakeSuppressed, undefined);
  assert.equal(result.receipt.eventSequence, event.sequence);
  assert.match(result.receipt.ackCommand, new RegExp(`ack .* --through ${event.sequence}$`));
  const projected = publicResult(result);
  assert.equal(projected.receipt.eventSequence, event.sequence);
  assert.equal(projected.receipt.ackCommand, result.receipt.ackCommand);
});

test('crash after completion before printing leaves the terminal event pending and unsuppressed', async (t) => {
  const fixture = child(t);
  await assert.rejects(async () => { await retire(fixture.options, fixture.env); throw new Error('crash before print'); }, /crash before print/);
  const events = dispatch.listEvents(fixture.context, {}, fixture.env);
  assert.equal(events.length, 1);
  assert.equal(events[0].wakeSuppressed, undefined);
  await observeParentChildren(fixture.context, {}, fixture.env, Date.now() + 5000);
  assert.deepEqual(dispatch.listEvents(fixture.context, {}, fixture.env), events);
});

test('crash between terminal event and journal completion recovers exactly once without archive replay', async (t) => {
  const fixture = child(t);
  const original = fs.renameSync;
  let crashed = false;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (!crashed && to.includes(`${path.sep}operations${path.sep}`)) {
      const record = JSON.parse(fs.readFileSync(from, 'utf8'));
      if (record.type === 'retire' && record.state === 'complete') {
        crashed = true;
        throw new Error('crash after event');
      }
    }
    return original(from, to);
  });
  await assert.rejects(() => retire(fixture.options, fixture.env), /crash after event/);
  mock.mock.restore();
  assert.equal(crashed, true);
  const [before] = dispatch.listEvents(fixture.context, {}, fixture.env);
  assert.equal(before.type, 'child.retired');
  assert.notEqual(state.pendingOperationForLane(fixture.repoRoot, fixture.lane.laneId, fixture.env).state, 'complete');
  await retire(fixture.options, fixture.env);
  assert.equal(fixture.calls.filter((method) => method === 'thread/archive').length, 1);
  assert.deepEqual(dispatch.listEvents(fixture.context, {}, fixture.env), [before]);
  assert.equal(state.pendingOperationForLane(fixture.repoRoot, fixture.lane.laneId, fixture.env), null);
});

test('completed journal with a missing terminal event remains outstanding and observation repairs it', async (t) => {
  const fixture = child(t);
  await retire(fixture.options, fixture.env);
  const [before] = dispatch.listEvents(fixture.context, {}, fixture.env);
  fs.unlinkSync(path.join(dispatch.pathsFor(fixture.env).events, fixture.context.parent.parentRef, `${before.eventId}.json`));
  assert.equal(outstandingDispatches(fixture.context, fixture.env).length, 1);
  await observeParentChildren(fixture.context, {}, fixture.env, Date.now() + 5000);
  const [repaired] = dispatch.listEvents(fixture.context, {}, fixture.env);
  assert.equal(repaired.observationFingerprint, before.observationFingerprint);
  assert.equal(repaired.wakeSuppressed, undefined);
  await observeParentChildren(fixture.context, {}, fixture.env, Date.now() + 5000);
  assert.deepEqual(dispatch.listEvents(fixture.context, {}, fixture.env), [repaired]);
  const ack = dispatch.acknowledgeEvent(fixture.context, repaired.eventId, fixture.env);
  assert.deepEqual(dispatch.acknowledgeEvent(fixture.context, repaired.eventId, fixture.env), ack);
  assert.equal(outstandingDispatches(fixture.context, fixture.env).length, 0);
});

for (const suppressed of [false, true]) {
  test(`watcher ${suppressed ? 'skips only the wake for a suppressed' : 'wakes for an unsuppressed'} terminal event and acknowledgement replay is idempotent`, async (t) => {
    const fixture = child(t);
    await retire({ ...fixture.options, ...(suppressed ? { parentContext: fixture.context } : {}) }, fixture.env);
    const [event] = dispatch.listEvents(fixture.context, {}, fixture.env);
    assert.deepEqual(event.wakeSuppressed, suppressed ? { reason: 'own-command', parentRef: fixture.context.parent.parentRef } : undefined);
    const wakes = [];
    await watchOnce(fixture.context, {}, fixture.env, { wakedEventIds: [] }, {
      deliver: async (...args) => { wakes.push(args); return { delivered: true }; },
    });
    assert.equal(wakes.length, suppressed ? 0 : 1);
    assert.deepEqual(dispatch.listEvents(fixture.context, {}, fixture.env), [event]);
    const ack = dispatch.acknowledgeEvent(fixture.context, event.eventId, fixture.env);
    assert.deepEqual(dispatch.acknowledgeEvent(fixture.context, event.eventId, fixture.env), ack);
    assert.equal(dispatch.listEvents(fixture.context, {}, fixture.env).length, 0);
  });
}

test('foreign parent context refuses retirement before any provider call', async (t) => {
  const fixture = child(t);
  const foreign = dispatch.createParentContext({ hostProvider: 'claude', hostApp: 'claude-code', displayName: 'Foreign parent' }, fixture.env);
  await assert.rejects(() => retire({ ...fixture.options, parentContext: foreign }, fixture.env), { code: 'NOT_OWNED' });
  assert.equal(fixture.calls.length, 0);
});

test('interrupt publishes its command event and later observations still inspect the live lane', async (t) => {
  const fixture = child(t, true);
  const result = await interrupt(fixture.options, fixture.env);
  const [event] = dispatch.listEvents(fixture.context, {}, fixture.env);
  assert.equal(event.data.state, 'interrupted');
  assert.equal(result.receipt.eventSequence, event.sequence);
  const priorReads = fixture.calls.length;
  await observeParentChildren(fixture.context, { clientFactory: fixture.options.clientFactory }, fixture.env, Date.now() + 5000);
  assert.ok(fixture.calls.length > priorReads);
  assert.ok(dispatch.listEvents(fixture.context, {}, fixture.env).some((item) => item.type === 'child.turn-completed'));
});

test('recordEvent accepts wake suppression only with the matching registered parent context file', (t) => {
  const fixture = child(t);
  const options = {
    dispatchId: fixture.lane.lineage.dispatchId, type: 'child.retired', fingerprint: 'context-validation',
    data: { state: 'retired' },
    wakeSuppressed: { reason: 'own-command', parentRef: fixture.context.parent.parentRef },
  };
  assert.throws(() => dispatch.recordEvent(options, fixture.env), { code: 'NOT_OWNED' });
  assert.throws(() => dispatch.recordEvent({ ...options, parentContext: { parent: fixture.context.parent } }, fixture.env), { code: 'NOT_OWNED' });
  const foreign = dispatch.createParentContext({ hostProvider: 'claude', hostApp: 'claude-code', displayName: 'Other context' }, fixture.env);
  assert.throws(() => dispatch.recordEvent({ ...options, parentContext: foreign }, fixture.env), { code: 'NOT_OWNED' });
  assert.equal(dispatch.listEvents(fixture.context, {}, fixture.env).length, 0);
  const event = dispatch.recordEvent({ ...options, parentContext: fixture.context }, fixture.env);
  assert.deepEqual(dispatch.listEvents(fixture.context, {}, fixture.env)[0].wakeSuppressed, event.wakeSuppressed);
});
