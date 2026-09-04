'use strict';

// scripts/lib/observe.js: which observations only confirm the parent's own
// completed command and are therefore recorded already acknowledged.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { OWN_COMMAND_WINDOW_MS, recentOwnCommand } = require('../scripts/lib/observe');
const { beginOperation, projectPaths, registerLane } = require('../scripts/lib/state');
const { createStateFixture } = require('./helpers/state-fixture');

// Rewrite a journal's updatedAt on disk so a test can simulate an old record
// without waiting real time (updateOperation enforces monotonic patches).
function ageOperationFile(fixture, operationId, ageMs) {
  const file = path.join(projectPaths(fixture.repoRoot, fixture.env).operations, `${operationId}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.updatedAt = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

function settledLane(fixture, providerId, state) {
  return registerLane(fixture.repoRoot, {
    backend: 'codex-app-server', providerId, displayName: '[test] settled lane', state,
  }, fixture.env);
}

function completedJournal(fixture, lane, type, ageMs) {
  const operation = beginOperation(fixture.repoRoot, {
    type, state: 'complete', laneId: lane.laneId, details: {},
  }, fixture.env);
  ageOperationFile(fixture, operation.operationId, ageMs);
  return operation;
}

test('a completed retirement confirms child.retired however late the observation lands', (t) => {
  const fixture = createStateFixture(t);
  const lane = settledLane(fixture, 'codex-retired-late', 'worktreeRemoved');
  const retire = completedJournal(fixture, lane, 'retire', 3 * OWN_COMMAND_WINDOW_MS);

  const own = recentOwnCommand(fixture.repoRoot, lane.laneId, fixture.env, Date.now(), 'child.retired');
  assert.equal(own?.operationId, retire.operationId);
  // Only the matching terminal event is confirmed by an old journal.
  assert.equal(recentOwnCommand(fixture.repoRoot, lane.laneId, fixture.env, Date.now(), 'child.turn-completed'), null);
  assert.equal(recentOwnCommand(fixture.repoRoot, lane.laneId, fixture.env, Date.now(), 'child.stopped'), null);
});

test('a completed stop confirms child.stopped of any age, and an old interrupt confirms nothing', (t) => {
  const fixture = createStateFixture(t);
  const stopped = settledLane(fixture, 'claude-stopped-late', 'stopped');
  const stop = completedJournal(fixture, stopped, 'stop', 3 * OWN_COMMAND_WINDOW_MS);
  assert.equal(
    recentOwnCommand(fixture.repoRoot, stopped.laneId, fixture.env, Date.now(), 'child.stopped')?.operationId,
    stop.operationId,
  );

  const interrupted = settledLane(fixture, 'codex-interrupted-late', 'archivedVerified');
  completedJournal(fixture, interrupted, 'interrupt', 3 * OWN_COMMAND_WINDOW_MS);
  assert.equal(recentOwnCommand(fixture.repoRoot, interrupted.laneId, fixture.env, Date.now(), 'child.turn-completed'), null);
  assert.equal(recentOwnCommand(fixture.repoRoot, interrupted.laneId, fixture.env, Date.now(), 'child.retired'), null);
});

test('a fresh interrupt still confirms the turn it completed, within the window only', (t) => {
  const fixture = createStateFixture(t);
  const lane = settledLane(fixture, 'codex-interrupted-fresh', 'archivedVerified');
  const interrupt = completedJournal(fixture, lane, 'interrupt', 1000);
  assert.equal(
    recentOwnCommand(fixture.repoRoot, lane.laneId, fixture.env, Date.now(), 'child.turn-completed')?.operationId,
    interrupt.operationId,
  );
  assert.equal(
    recentOwnCommand(fixture.repoRoot, lane.laneId, fixture.env, Date.now() + OWN_COMMAND_WINDOW_MS + 1, 'child.turn-completed'),
    null,
  );
});
