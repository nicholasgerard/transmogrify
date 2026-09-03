'use strict';

// The provider-adapter contract: every adapter publishes the same descriptor
// shape, implements every operation it lists, throws the shared coded error,
// and settles the shared crash-repair rows identically. A third adapter must
// pass this file unchanged.

const assert = require('node:assert/strict');
const test = require('node:test');
const codex = require('../scripts/lib/codex-adapter');
const claude = require('../scripts/lib/claude-adapter');
const { AdapterError, laneResult } = require('../scripts/lib/adapter-kit');
const {
  listOperations, pendingOperationForLane, requireOwnedLane, reserveSpawn,
} = require('../scripts/lib/state');
const { createStateFixture } = require('./helpers/state-fixture');

const ADAPTERS = [codex, claude];
const LIFECYCLE = ['spawn', 'status', 'steer', 'recover', 'retire', 'reconcile'];

test('every adapter publishes a complete descriptor and implements what it lists', () => {
  const targets = new Set();
  for (const adapter of ADAPTERS) {
    const { descriptor } = adapter;
    assert.ok(descriptor && Object.isFrozen(descriptor), 'descriptor is frozen');
    assert.match(descriptor.target, /^[a-z]+$/);
    assert.match(descriptor.backend, /^[a-z-]+$/);
    assert.ok(!targets.has(descriptor.target), 'targets are unique');
    targets.add(descriptor.target);
    assert.ok(descriptor.operations instanceof Set && descriptor.options instanceof Set);
    assert.equal(typeof descriptor.recoverAcceptsInput, 'boolean');
    for (const operation of LIFECYCLE) {
      assert.ok(descriptor.operations.has(operation), `${descriptor.target} lists ${operation}`);
    }
    for (const operation of descriptor.operations) {
      assert.equal(typeof adapter[operation], 'function', `${descriptor.target} implements ${operation}`);
    }
    assert.equal(typeof adapter.executionCapabilities, 'function');
  }
});

test('adapter failures share one coded error class', () => {
  assert.equal(codex.TransmogrifyError, AdapterError);
  const claudeError = new claude.ClaudeTransmogrifyError('NOT_OWNED', 'x', { laneId: 'l' });
  assert.ok(claudeError instanceof AdapterError);
  assert.equal(claudeError.code, 'NOT_OWNED');
  assert.deepEqual(claudeError.details, { laneId: 'l' });
});

test('lane results share one envelope regardless of adapter', () => {
  const base = {
    laneId: 'lane-1', operationId: 'op-1', backend: 'codex-app-server', providerId: 'thread-1',
    state: 'active', capabilities: { midTurnSteer: true },
  };
  const withVisibility = laneResult('status', { ...base, visibility: { surface: 'codex' } });
  assert.deepEqual(Object.keys(withVisibility), [
    'version', 'ok', 'operation', 'operationId', 'laneId', 'adapter', 'providerId', 'state', 'capabilities', 'visibility',
  ]);
  const withoutVisibility = laneResult('status', { ...base, backend: 'claude-code', providerId: null }, { phase: 'idle' });
  assert.equal(withoutVisibility.providerId, null);
  assert.equal(withoutVisibility.visibility, undefined);
  assert.equal(withoutVisibility.phase, 'idle');
});

// The shared crash-repair row: a spawn reservation that never reached its
// provider request settles as notDelivered with the lane failed, through
// either adapter, without any provider contact.
const UNSTARTED_LANE_ID = '12121212-1212-4121-8121-121212121212';
const UNSTARTED_OPERATION_ID = '34343434-3434-4343-8343-343434343434';
function reserveUnstartedSpawn(fixture, adapter) {
  reserveSpawn(fixture.repoRoot, {
    operation: {
      operationId: UNSTARTED_OPERATION_ID, type: 'spawn', laneId: UNSTARTED_LANE_ID,
      details: {
        target: adapter.descriptor.target, name: '[test] unstarted',
        spawner: { pid: 999999, processBirth: 'gone' },
      },
    },
    lane: {
      laneId: UNSTARTED_LANE_ID,
      backend: adapter.descriptor.backend,
      displayName: '[test] unstarted',
      operationId: UNSTARTED_OPERATION_ID,
      seatIntent: {
        version: 1,
        laneId: UNSTARTED_LANE_ID,
        path: '/tmp/transmogrify-worktrees/unstarted',
        worktreesRoot: '/tmp/transmogrify-worktrees',
        gitCommonDir: '/tmp/repository/.git',
        branchRef: 'refs/heads/transmogrify/unstarted',
        baseCommit: 'a'.repeat(40),
        managed: true,
      },
    },
  }, fixture.env);
}
function reconcileUnstartedSpawn(fixture, adapter) {
  return adapter.reconcile({
    repoRoot: fixture.repoRoot, laneId: UNSTARTED_LANE_ID,
    url: 'ws://127.0.0.1:1', claudeBin: '/nonexistent/claude',
  }, { ...fixture.env, TRANSMOGRIFY_URL: 'ws://127.0.0.1:1' });
}
for (const adapter of ADAPTERS) {
  test(`${adapter.descriptor.target} reconcile settles an unstarted spawn locally`, async (t) => {
    const fixture = createStateFixture(t);
    reserveUnstartedSpawn(fixture, adapter);
    assert.equal(pendingOperationForLane(fixture.repoRoot, UNSTARTED_LANE_ID, fixture.env).state, 'planned');
    const result = await reconcileUnstartedSpawn(fixture, adapter);
    const entry = result.results[0];
    assert.ok(entry, JSON.stringify(result));
    assert.equal(entry.laneId, UNSTARTED_LANE_ID);
    assert.equal(entry.state, 'failed');
    assert.equal(entry.delivery, 'notDelivered');
    assert.deepEqual(entry.repaired, ['unstartedSpawnState', 'unstartedSpawnOperation']);
    assert.equal(entry.pendingOperation, null);
    assert.equal(requireOwnedLane(fixture.repoRoot, UNSTARTED_LANE_ID, fixture.env).state, 'failed');
    assert.equal(pendingOperationForLane(fixture.repoRoot, UNSTARTED_LANE_ID, fixture.env), null);
    const journal = listOperations(fixture.repoRoot, fixture.env)
      .find((op) => op.operationId === UNSTARTED_OPERATION_ID);
    assert.equal(journal.state, 'notDelivered');
  });
}

// One reconcile result shape for both adapters (ROADMAP.md priority 2): the
// same unstarted-spawn crash row, settled by each adapter on its own fixture,
// must carry the same top-level and entry keys even though the two adapters
// give that row different outcome labels (Codex: unstartedSpawnSettled,
// Claude: spawnNotDelivered) and a different adapter/backend identity.
test('codex and claude reconcile results share one top-level and entry key shape', async (t) => {
  const results = {};
  for (const adapter of ADAPTERS) {
    const fixture = createStateFixture(t);
    reserveUnstartedSpawn(fixture, adapter);
    results[adapter.descriptor.target] = await reconcileUnstartedSpawn(fixture, adapter);
  }
  const { codex: codexResult, claude: claudeResult } = results;
  assert.deepEqual(Object.keys(codexResult).sort(), Object.keys(claudeResult).sort());
  for (const key of ['version', 'ok', 'operation']) {
    assert.equal(codexResult[key], claudeResult[key], key);
  }
  assert.deepEqual(codexResult.receipt, claudeResult.receipt);
  const codexEntry = codexResult.results[0];
  const claudeEntry = claudeResult.results[0];
  assert.deepEqual(Object.keys(codexEntry).sort(), Object.keys(claudeEntry).sort());
  for (const key of ['state', 'delivery', 'pendingOperation']) {
    assert.equal(codexEntry[key], claudeEntry[key], key);
  }
  assert.notEqual(codexEntry.outcome, claudeEntry.outcome);
  assert.equal(codexEntry.outcome, 'unstartedSpawnSettled');
  assert.equal(claudeEntry.outcome, 'spawnNotDelivered');
});
