'use strict';

// scripts/lib/retention.js: the conservative, recoverable retention pass.
// Every test isolates HOME so a run never touches this machine's real
// installer backups, and drives runRetention() directly the way maintain.js
// does for `--retention`.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  BACKUP_ENTRY_PATTERN, DEFAULT_KEEP_BACKUPS, DEFAULT_KEEP_DAYS, backupRoots, runRetention,
} = require('../scripts/lib/retention');
const { beginOperation, projectPaths, registerLane } = require('../scripts/lib/state');
const { createStateFixture } = require('./helpers/state-fixture');

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

// Rewrite an operation journal's updatedAt on disk, bypassing the monotonic
// patch rules updateOperation enforces, so a test can simulate an old record
// without waiting real time. Mirrors the ask in the deliverable description.
function ageOperationFile(repoRoot, env, operationId, daysAgo) {
  const paths = projectPaths(repoRoot, env);
  const file = path.join(paths.operations, `${operationId}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.updatedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

function retiredLane(fixture, providerId) {
  return registerLane(fixture.repoRoot, {
    backend: 'codex-app-server', providerId, displayName: '[test] retired lane', state: 'worktreeRemoved',
  }, fixture.env);
}

// A HOME directory with no `.claude`/`.agents` backup roots at all, so the
// backups pass always sees ENOENT and reports zero candidates unless a test
// populates it deliberately. Never process.env.HOME: a retention pass must
// never be able to reach this machine's real installer backups.
function isolatedHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-retention-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('a terminal, worktree-released journal past the keep-days window is a dry-run candidate and then moves to recoverable trash', (t) => {
  const fixture = createStateFixture(t);
  const env = { ...fixture.env, HOME: isolatedHome(t) };
  const lane = retiredLane(fixture, 'codex-old-terminal');
  const operation = beginOperation(fixture.repoRoot, {
    type: 'retire', state: 'complete', laneId: lane.laneId, details: {},
  }, env);
  ageOperationFile(fixture.repoRoot, env, operation.operationId, 40);
  const paths = projectPaths(fixture.repoRoot, env);
  const originalFile = path.join(paths.operations, `${operation.operationId}.json`);

  const dryRun = runRetention({ repoRoot: fixture.repoRoot, dryRun: true, keepDays: 30 }, env);
  assert.deepEqual(dryRun.operations, { candidates: 1, moved: 0 });
  assert.equal(dryRun.trashDir, false);
  assert.equal(fs.existsSync(originalFile), true, 'a dry run must not move anything');

  const real = runRetention({ repoRoot: fixture.repoRoot, dryRun: false, keepDays: 30 }, env);
  assert.deepEqual(real.operations, { candidates: 1, moved: 1 });
  assert.equal(real.trashDir, true);
  assert.equal(fs.existsSync(originalFile), false, 'the journal must be moved out of its live location');

  const trashDirectory = path.join(paths.directory, 'trash', isoToday(), 'operations');
  const trashedFile = path.join(trashDirectory, `${operation.operationId}.json`);
  assert.equal(fs.existsSync(trashedFile), true, 'the journal must reappear, recoverable, under trash');
  for (const directory of [
    path.join(paths.directory, 'trash'),
    path.join(paths.directory, 'trash', isoToday()),
    trashDirectory,
  ]) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700, `${directory} must be owner-only`);
  }
  const recovered = JSON.parse(fs.readFileSync(trashedFile, 'utf8'));
  assert.equal(recovered.operationId, operation.operationId);
  assert.equal(recovered.type, 'retire');
  assert.equal(recovered.laneId, lane.laneId);

  // Nothing left to reclaim on a second pass.
  const again = runRetention({ repoRoot: fixture.repoRoot, dryRun: false, keepDays: 30 }, env);
  assert.deepEqual(again.operations, { candidates: 0, moved: 0 });
});

test('a too-recent journal, a non-terminal journal, and a journal whose lane still holds its seat are never candidates', (t) => {
  const fixture = createStateFixture(t);
  const env = { ...fixture.env, HOME: isolatedHome(t) };
  const paths = projectPaths(fixture.repoRoot, env);

  const recentLane = retiredLane(fixture, 'codex-recent');
  const recentOp = beginOperation(fixture.repoRoot, {
    type: 'retire', state: 'complete', laneId: recentLane.laneId, details: {},
  }, env); // left at its natural just-created updatedAt: inside the keep-days window

  const activeLane = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server', providerId: 'codex-still-active', displayName: '[test] still active', state: 'active',
  }, env);
  const activeOp = beginOperation(fixture.repoRoot, {
    type: 'retire', state: 'complete', laneId: activeLane.laneId, details: {},
  }, env);
  ageOperationFile(fixture.repoRoot, env, activeOp.operationId, 40); // old and terminal, but the lane kept its seat

  const nonTerminalLane = retiredLane(fixture, 'codex-non-terminal');
  const nonTerminalOp = beginOperation(fixture.repoRoot, {
    type: 'retire', state: 'dispatching', laneId: nonTerminalLane.laneId, details: {},
  }, env);
  ageOperationFile(fixture.repoRoot, env, nonTerminalOp.operationId, 40); // old and worktree-released, but not terminal

  const result = runRetention({ repoRoot: fixture.repoRoot, dryRun: false, keepDays: 30 }, env);
  assert.deepEqual(result.operations, { candidates: 0, moved: 0 });
  for (const operation of [recentOp, activeOp, nonTerminalOp]) {
    assert.equal(fs.existsSync(path.join(paths.operations, `${operation.operationId}.json`)), true);
  }
});

test('retention never touches parent events', (t) => {
  // dispatch.js derives an event's id from a digest of its full content,
  // including its own per-parent sequence number, and re-scans every event
  // file physically present under a parent -- acknowledged or not -- to find
  // a semantic duplicate before minting a new one. Reaping an acknowledged
  // event file would make that idempotent-redelivery match dependent on
  // retention timing rather than deterministic, and dispatch.js exports no
  // per-parent pruning primitive that already accounts for that. This pass
  // deliberately never touches events; see scripts/lib/retention.js.
  const fixture = createStateFixture(t);
  const env = { ...fixture.env, HOME: isolatedHome(t) };
  const result = runRetention({ repoRoot: fixture.repoRoot, dryRun: false }, env);
  assert.deepEqual(result.events, { candidates: 0, moved: 0 });
});

test('installer backups beyond the newest keep-backups per root move to trash; unrelated and .failed- entries never do', (t) => {
  const fixture = createStateFixture(t);
  const home = isolatedHome(t);
  const env = { ...fixture.env, HOME: home };
  const claudeRoot = path.join(home, '.claude', 'transmogrify-backups');
  const agentsRoot = path.join(home, '.agents', 'transmogrify-backups');
  fs.mkdirSync(claudeRoot, { recursive: true });
  fs.mkdirSync(agentsRoot, { recursive: true });
  const now = Date.now();
  ['a', 'b', 'c', 'd'].forEach((name, index) => {
    const entry = path.join(claudeRoot, `transmogrify.backup-${name}`);
    fs.mkdirSync(entry);
    const stamp = new Date(now + index * 1000);
    fs.utimesSync(entry, stamp, stamp);
  });
  fs.mkdirSync(path.join(claudeRoot, 'transmogrify.failed-x'));
  fs.mkdirSync(path.join(claudeRoot, 'codex-operator.legacy-unrelated'));

  const dryRun = runRetention({ repoRoot: fixture.repoRoot, dryRun: true, keepBackups: 2 }, env);
  assert.deepEqual(dryRun.backups, { candidates: 2, moved: 0 });
  assert.equal(fs.existsSync(path.join(claudeRoot, 'transmogrify.backup-a')), true, 'dry run must not move anything');

  const real = runRetention({ repoRoot: fixture.repoRoot, dryRun: false, keepBackups: 2 }, env);
  assert.deepEqual(real.backups, { candidates: 2, moved: 2 });
  // The two oldest (a, b) are gone from the live root; the two newest (c, d)
  // and every non-matching entry are untouched.
  assert.equal(fs.existsSync(path.join(claudeRoot, 'transmogrify.backup-a')), false);
  assert.equal(fs.existsSync(path.join(claudeRoot, 'transmogrify.backup-b')), false);
  assert.equal(fs.existsSync(path.join(claudeRoot, 'transmogrify.backup-c')), true);
  assert.equal(fs.existsSync(path.join(claudeRoot, 'transmogrify.backup-d')), true);
  assert.equal(fs.existsSync(path.join(claudeRoot, 'transmogrify.failed-x')), true);
  assert.equal(fs.existsSync(path.join(claudeRoot, 'codex-operator.legacy-unrelated')), true);
  assert.equal(fs.existsSync(path.join(claudeRoot, 'trash', isoToday(), 'transmogrify.backup-a')), true);
  assert.equal(fs.existsSync(path.join(claudeRoot, 'trash', isoToday(), 'transmogrify.backup-b')), true);
  assert.equal(fs.statSync(path.join(claudeRoot, 'trash')).mode & 0o777, 0o700);

  // An empty or missing backup root is not an error and contributes zero.
  fs.rmSync(agentsRoot, { recursive: true, force: true });
  const afterRemovedRoot = runRetention({ repoRoot: fixture.repoRoot, dryRun: true, keepBackups: 2 }, env);
  assert.deepEqual(afterRemovedRoot.backups, { candidates: 0, moved: 0 });
});

test('retention defaults and the backup-root/entry-name rules match install.js', (t) => {
  const home = isolatedHome(t);
  assert.deepEqual(backupRoots({ HOME: home }), [
    path.join(home, '.claude', 'transmogrify-backups'),
    path.join(home, '.agents', 'transmogrify-backups'),
  ]);
  assert.equal(DEFAULT_KEEP_DAYS, 30);
  assert.equal(DEFAULT_KEEP_BACKUPS, 3);
  assert.ok(BACKUP_ENTRY_PATTERN.test('transmogrify.backup-20260101T000000000Z-1-11111111-1111-4111-8111-111111111111'));
  assert.equal(BACKUP_ENTRY_PATTERN.test('transmogrify.failed-x'), false);
  assert.equal(BACKUP_ENTRY_PATTERN.test('codex-operator.legacy-20260902T215412Z'), false);
});

test('retention output never carries a lane id, provider id, or repository path', (t) => {
  const fixture = createStateFixture(t);
  const env = { ...fixture.env, HOME: isolatedHome(t) };
  const lane = retiredLane(fixture, 'codex-secret-provider-id');
  const operation = beginOperation(fixture.repoRoot, {
    type: 'retire', state: 'complete', laneId: lane.laneId, details: {},
  }, env);
  ageOperationFile(fixture.repoRoot, env, operation.operationId, 40);
  const result = runRetention({ repoRoot: fixture.repoRoot, dryRun: false, keepDays: 30 }, env);
  const serialized = JSON.stringify(result);
  for (const secret of [lane.laneId, operation.operationId, 'codex-secret-provider-id', fixture.repoRoot]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});
