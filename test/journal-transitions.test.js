'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const state = require('../scripts/lib/state');
const { createStateFixture } = require('./helpers/state-fixture');

for (const [type, graph] of state.OPERATION_TRANSITIONS) {
  test(`${type} journal permits each declared edge and refuses every undeclared or terminal edge`, (t) => {
    const fixture = createStateFixture(t);
    for (const [from, destinations] of graph) {
      const original = state.beginOperation(fixture.repoRoot, { type, state: from }, fixture.env);
      const file = path.join(state.projectPaths(fixture.repoRoot, fixture.env).operations, `${original.operationId}.json`);
      for (const to of graph.keys()) {
        fs.writeFileSync(file, JSON.stringify(original), { mode: 0o600 });
        const write = () => state.updateOperation(fixture.repoRoot, original.operationId, {
          state: to, expectedRevision: original.revision,
        }, fixture.env);
        if (destinations.has(to)) {
          const updated = write();
          assert.equal(updated.state, to, `${from} -> ${to}`);
          assert.equal(updated.revision, original.revision + 1);
        } else {
          assert.throws(write, { code: state.TERMINAL_OPERATION_STATES.has(from)
            ? 'TERMINAL_OPERATION_IMMUTABLE' : 'INVALID_OPERATION_TRANSITION' }, `${from} -> ${to}`);
          assert.deepEqual(JSON.parse(fs.readFileSync(file)), original);
        }
      }
    }
  });
}

for (const writer of ['updateOperation', 'updatePendingLaneOperation', 'completeLaneOperation']) {
  test(`${writer} refuses a stale revision without changing journal or lane`, (t) => {
    const fixture = createStateFixture(t);
    const lane = state.registerLane(fixture.repoRoot, {
      backend: 'codex-app-server', providerId: 'revision-thread', displayName: '::: revision child', state: 'active',
    }, fixture.env);
    const original = state.beginLaneOperation(fixture.repoRoot, lane.laneId, { type: 'interrupt' }, fixture.env);
    const advanced = state.updatePendingLaneOperation(fixture.repoRoot, lane.laneId, original.operationId, {
      state: 'dispatching', expectedRevision: original.revision,
    }, fixture.env);
    const args = writer === 'updateOperation' ? [fixture.repoRoot, original.operationId]
      : [fixture.repoRoot, lane.laneId, original.operationId];
    assert.throws(() => state[writer](...args, {
      state: 'complete', expectedRevision: original.revision,
    }, fixture.env), { code: 'STALE_OPERATION_REVISION' });
    assert.deepEqual(state.pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), advanced);
    assert.throws(() => state[writer](...args, { state: 'complete' }, fixture.env), { code: 'STALE_OPERATION_REVISION' });
  });
}

test('legacy journals acquire a revision on their next validated write', (t) => {
  const fixture = createStateFixture(t);
  const original = state.beginOperation(fixture.repoRoot, { type: 'steer' }, fixture.env);
  const file = path.join(state.projectPaths(fixture.repoRoot, fixture.env).operations, `${original.operationId}.json`);
  const { revision, schemaVersion, ...legacy } = original;
  fs.writeFileSync(file, JSON.stringify(legacy));
  const loaded = state.listOperations(fixture.repoRoot, fixture.env)[0];
  const updated = state.updateOperation(fixture.repoRoot, loaded.operationId, {
    state: 'dispatching', expectedRevision: loaded.revision ?? 0,
  }, fixture.env);
  assert.equal(updated.revision, 1);
  assert.equal(updated.schemaVersion, schemaVersion);
});

test('terminal completion retry repairs only the pointer and refuses detail enrichment', (t) => {
  const fixture = createStateFixture(t);
  const lane = state.registerLane(fixture.repoRoot, {
    backend: 'codex-app-server', providerId: 'immutable-thread', displayName: '::: immutable child', state: 'active',
  }, fixture.env);
  const original = state.beginLaneOperation(fixture.repoRoot, lane.laneId, { type: 'stop' }, fixture.env);
  const complete = state.updatePendingLaneOperation(fixture.repoRoot, lane.laneId, original.operationId, {
    state: 'complete', expectedRevision: original.revision,
  }, fixture.env);
  const file = path.join(state.projectPaths(fixture.repoRoot, fixture.env).operations, `${original.operationId}.json`);
  const bytes = fs.readFileSync(file, 'utf8');
  assert.throws(() => state.updatePendingLaneOperation(fixture.repoRoot, lane.laneId, complete.operationId, {
    expectedRevision: complete.revision, details: { extra: true },
  }, fixture.env), { code: 'TERMINAL_OPERATION_IMMUTABLE' });
  assert.throws(() => state.completeLaneOperation(fixture.repoRoot, lane.laneId, complete.operationId, {
    expectedRevision: complete.revision, details: { extra: true },
  }, fixture.env), { code: 'TERMINAL_OPERATION_IMMUTABLE' });
  state.settleTerminalLaneOperationPointer(fixture.repoRoot, lane.laneId, fixture.env);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(state.pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
});
