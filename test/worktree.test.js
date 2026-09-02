'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { sanitizedGitEnv } = require('../scripts/lib/git-env');
const { registerLane, updateLane } = require('../scripts/lib/state');
const {
  containsPath,
  captureHarvestReceipt,
  createManagedSeat,
  isPermanentCleanupError,
  materializeManagedSeat,
  planManagedSeat,
  requireIgnoredManagedRoot,
  removeManagedSeat,
  verifyRecordedSeat,
  verifyHarvestedSeatForCleanup,
  verifySeat,
} = require('../scripts/lib/worktree');
const { createRepoWithSeat } = require('./helpers/repo-fixture');

test('internal Git children receive no ambient credentials and disable hooks', (t) => {
  assert.deepEqual(sanitizedGitEnv({
    HOME: '/tmp/home',
    PATH: '/usr/bin:/bin',
    API_TOKEN: 'secret-token',
    HTTPS_PROXY: 'https://user:password@example.invalid',
    SSH_AUTH_SOCK: '/tmp/private-agent.sock',
    GIT_DIR: '/tmp/redirected-git-dir',
  }), {
    HOME: '/tmp/home',
    PATH: '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
  });

  const fixture = createRepoWithSeat(t);
  const hookOutput = path.join(fixture.root, 'post-checkout-ran');
  const hook = path.join(fixture.repoRoot, '.git', 'hooks', 'post-checkout');
  fs.writeFileSync(hook, `#!/bin/sh\nprintf '%s' "$TRANSMOGRIFY_TEST_SECRET" > ${JSON.stringify(hookOutput)}\n`);
  fs.chmodSync(hook, 0o700);
  const previous = process.env.TRANSMOGRIFY_TEST_SECRET;
  process.env.TRANSMOGRIFY_TEST_SECRET = 'must-not-reach-git';
  try {
    createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, crypto.randomUUID());
  } finally {
    if (previous === undefined) delete process.env.TRANSMOGRIFY_TEST_SECRET;
    else process.env.TRANSMOGRIFY_TEST_SECRET = previous;
  }
  assert.equal(fs.existsSync(hookOutput), false);
});

test('cleanup failure classification blocks only invariant violations', () => {
  assert.equal(isPermanentCleanupError(Object.assign(new Error('unsafe'), {
    code: 'UNSAFE_CLEANUP_STATE',
  })), true);
  assert.equal(isPermanentCleanupError(new Error('transient Git lock failure')), false);
});

test('cleanup inspection failures remain retryable while observed seat drift is permanent', (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = crypto.randomUUID();
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  const receipt = captureHarvestReceipt(fixture.repoRoot, seat, 'f'.repeat(64));

  const originalPath = process.env.PATH;
  let inspectionError;
  try {
    process.env.PATH = '/definitely-missing-transmogrify-test-path';
    verifyHarvestedSeatForCleanup(fixture.repoRoot, seat, receipt);
  } catch (error) {
    inspectionError = error;
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
  assert.equal(inspectionError instanceof Error, true);
  assert.equal(isPermanentCleanupError(inspectionError), false);

  assert.throws(
    () => verifyHarvestedSeatForCleanup(
      fixture.repoRoot,
      { ...seat, inode: seat.inode + 1 },
      receipt,
    ),
    (error) => isPermanentCleanupError(error) && /identity changed/.test(error.message),
  );
});

test('seat verification binds an exact worktree, branch, and Git common directory', (t) => {
  const fixture = createRepoWithSeat(t);
  const seat = verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot);
  assert.equal(seat.path, fs.realpathSync(fixture.seat));
  assert.equal(seat.branchRef, 'refs/heads/lane/test');
  assert.equal(seat.managed, false);
});

test('seat verification refuses the operator checkout and sibling-prefix escapes', (t) => {
  const fixture = createRepoWithSeat(t);
  assert.throws(() => {
    verifySeat(fixture.repoRoot, fixture.repoRoot, fixture.worktreesRoot);
  }, /outside WORKTREES|operator checkout/);
  assert.equal(containsPath('/tmp/worktrees', '/tmp/worktrees-foreign/lane'), false);
});

test('seat verification refuses a symlinked seat path', (t) => {
  const fixture = createRepoWithSeat(t);
  const linked = path.join(fixture.worktreesRoot, 'linked');
  fs.symlinkSync(fixture.seat, linked);
  assert.throws(() => verifySeat(fixture.repoRoot, linked, fixture.worktreesRoot), /symlink/);
});

test('an unrelated prunable worktree does not block exact seat verification', (t) => {
  const fixture = createRepoWithSeat(t);
  const stale = path.join(fixture.worktreesRoot, 'stale');
  execFileSync('git', ['-C', fixture.repoRoot, 'worktree', 'add', '-q', '-b', 'lane/stale', stale]);
  fs.rmSync(stale, { recursive: true, force: true });
  assert.equal(
    verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot).path,
    fs.realpathSync(fixture.seat),
  );
});

test('managed seats are created with exact identity and clean seats are removable', (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = crypto.randomUUID();
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  const harvestReceipt = captureHarvestReceipt(fixture.repoRoot, seat, 'a'.repeat(64));
  assert.equal(seat.managed, true);
  assert.equal(seat.branchRef, `refs/heads/transmogrify/${laneId}`);
  assert.deepEqual(verifyRecordedSeat(fixture.repoRoot, seat), seat);

  const lane = registerLane(fixture.repoRoot, {
    backend: 'test',
    providerId: 'provider-clean',
    displayName: '[test] clean managed seat',
    state: 'archivedVerified',
    seat,
  }, fixture.env);
  const removed = removeManagedSeat(fixture.repoRoot, lane.laneId, harvestReceipt, fixture.env);
  assert.equal(removed.lane.state, 'worktreeRemoved');
  assert.equal(fs.existsSync(seat.path), false);
  execFileSync('git', ['-C', fixture.repoRoot, 'show-ref', '--verify', '--quiet', seat.branchRef]);
});

test('managed seat mutation ignores ambient Git repository redirection', (t) => {
  const fixture = createRepoWithSeat(t);
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
    const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, crypto.randomUUID());
    assert.equal(seat.gitCommonDir, fs.realpathSync(path.join(fixture.repoRoot, '.git')));
    assert.equal(fs.existsSync(seat.path), true);
    assert.equal(execFileSync('git', ['-C', other, 'worktree', 'list'], { encoding: 'utf8' })
      .includes(seat.path), false);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('managed seat creation refuses a public pre-existing WORKTREES root', (t) => {
  const fixture = createRepoWithSeat(t);
  fs.chmodSync(fixture.worktreesRoot, 0o755);
  assert.throws(
    () => createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, crypto.randomUUID()),
    /non-private managed WORKTREES/,
  );
});

test('managed seat planning refuses a public existing WORKTREES ancestor', (t) => {
  const fixture = createRepoWithSeat(t);
  const shared = path.join(fixture.root, 'shared-worktrees-parent');
  fs.mkdirSync(shared);
  fs.chmodSync(shared, 0o777);
  const worktrees = path.join(shared, 'private-leaf', 'worktrees');
  assert.throws(
    () => planManagedSeat(fixture.repoRoot, worktrees, crypto.randomUUID()),
    /non-owner-controlled WORKTREES ancestor/,
  );
  assert.equal(fs.existsSync(path.join(shared, 'private-leaf')), false);
});

test('managed roots inside a repository must be ignored while outside roots remain valid', (t) => {
  const fixture = createRepoWithSeat(t);
  assert.doesNotThrow(() => requireIgnoredManagedRoot(fixture.repoRoot, fixture.worktreesRoot));

  fs.writeFileSync(path.join(fixture.repoRoot, '.gitignore'), '');
  assert.throws(
    () => verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot),
    /must be ignored by Git/,
  );
  assert.throws(
    () => planManagedSeat(fixture.repoRoot, fixture.worktreesRoot, crypto.randomUUID()),
    /must be ignored by Git/,
  );

  fs.writeFileSync(path.join(fixture.repoRoot, '.gitignore'), '.worktrees/\n');
  const intent = planManagedSeat(fixture.repoRoot, fixture.worktreesRoot, crypto.randomUUID());
  fs.writeFileSync(path.join(fixture.repoRoot, '.gitignore'), '');
  assert.throws(
    () => materializeManagedSeat(fixture.repoRoot, intent),
    /must be ignored by Git/,
  );
  assert.equal(fs.existsSync(intent.path), false);

  const outside = path.join(fs.realpathSync(fixture.root), 'outside-worktrees');
  assert.doesNotThrow(() => planManagedSeat(fixture.repoRoot, outside, crypto.randomUUID()));
});

test('external managed roots cannot dirty another Git worktree', (t) => {
  const fixture = createRepoWithSeat(t);
  const otherRepo = path.join(fs.realpathSync(fixture.root), 'other-repo');
  fs.mkdirSync(otherRepo);
  execFileSync('git', ['-C', otherRepo, 'init', '-q']);
  execFileSync('git', ['-C', otherRepo, 'config', 'user.email', 'tests@example.com']);
  execFileSync('git', ['-C', otherRepo, 'config', 'user.name', 'Test Runner']);
  fs.writeFileSync(path.join(otherRepo, 'README.md'), 'other repository\n');
  execFileSync('git', ['-C', otherRepo, 'add', 'README.md']);
  execFileSync('git', ['-C', otherRepo, 'commit', '-qm', 'initial']);

  assert.throws(
    () => planManagedSeat(
      fixture.repoRoot,
      path.join(otherRepo, '.transmogrify-worktrees'),
      crypto.randomUUID(),
    ),
    /outside every other Git worktree/,
  );
  assert.equal(execFileSync('git', ['-C', otherRepo, 'status', '--short'], {
    encoding: 'utf8',
  }), '');

  assert.throws(
    () => planManagedSeat(
      fixture.repoRoot,
      path.join(fixture.seat, '.transmogrify-worktrees'),
      crypto.randomUUID(),
    ),
    /outside every other Git worktree/,
  );
});

test('a missing ignored root is accepted and Git metadata roots are refused', (t) => {
  const fixture = createRepoWithSeat(t);
  const missingRoot = path.join(fixture.repoRoot, '.fresh-worktrees');
  fs.appendFileSync(path.join(fixture.repoRoot, '.gitignore'), '.fresh-worktrees/\n');
  const intent = planManagedSeat(fixture.repoRoot, missingRoot, crypto.randomUUID());
  assert.equal(intent.worktreesRoot, path.join(fs.realpathSync(fixture.repoRoot), '.fresh-worktrees'));
  assert.equal(fs.existsSync(missingRoot), false);

  assert.throws(
    () => planManagedSeat(
      fixture.repoRoot,
      path.join(fixture.repoRoot, '.git', 'transmogrify-seats'),
      crypto.randomUUID(),
    ),
    /outside the Git common directory/,
  );
});

test('managed seat intent is durable before materialization and exact retry is idempotent', (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = crypto.randomUUID();
  const intent = planManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  assert.equal(fs.existsSync(intent.path), false);
  assert.equal(intent.branchRef, `refs/heads/transmogrify/${laneId}`);
  const first = materializeManagedSeat(fixture.repoRoot, intent);
  const retry = materializeManagedSeat(fixture.repoRoot, intent);
  assert.deepEqual(retry, first);
  assert.throws(() => materializeManagedSeat(fixture.repoRoot, {
    ...intent,
    baseCommit: 'f'.repeat(intent.baseCommit.length),
  }), /does not match its durable intent/);
});

test('managed cleanup verifies an already-removed exact seat after a crash boundary', (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = crypto.randomUUID();
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  const harvestReceipt = captureHarvestReceipt(fixture.repoRoot, seat, 'b'.repeat(64));
  const lane = registerLane(fixture.repoRoot, {
    laneId,
    backend: 'test',
    providerId: 'provider-already-removed',
    displayName: '[test] already removed managed seat',
    state: 'archivedVerified',
    seat,
  }, fixture.env);
  execFileSync('git', ['-C', fixture.repoRoot, 'worktree', 'remove', '--', seat.path]);
  const removed = removeManagedSeat(fixture.repoRoot, lane.laneId, harvestReceipt, fixture.env);
  assert.equal(removed.lane.state, 'worktreeRemoved');
  assert.equal(removed.value.alreadyRemoved, true);
});

test('managed cleanup refuses dirty, replaced, external, and active seats', (t) => {
  const fixture = createRepoWithSeat(t);
  const dirtyId = crypto.randomUUID();
  const dirty = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, dirtyId);
  const dirtyHarvest = captureHarvestReceipt(fixture.repoRoot, dirty, 'c'.repeat(64));
  fs.writeFileSync(path.join(dirty.path, 'untracked.txt'), 'do not delete\n');
  const dirtyLane = registerLane(fixture.repoRoot, {
    backend: 'test',
    providerId: 'provider-dirty',
    displayName: '[test] dirty managed seat',
    state: 'active',
    seat: dirty,
  }, fixture.env);
  assert.throws(() => {
    removeManagedSeat(fixture.repoRoot, dirtyLane.laneId, dirtyHarvest, fixture.env);
  }, /verified provider retirement/);
  updateLane(fixture.repoRoot, dirtyLane.laneId, { state: 'retireRequested' }, fixture.env);
  updateLane(fixture.repoRoot, dirtyLane.laneId, { state: 'archivedVerified' }, fixture.env);
  assert.throws(() => {
    removeManagedSeat(fixture.repoRoot, dirtyLane.laneId, dirtyHarvest, fixture.env);
  }, /dirty managed worktree/);

  const replacedId = crypto.randomUUID();
  const replaced = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, replacedId);
  const replacedHarvest = captureHarvestReceipt(fixture.repoRoot, replaced, 'd'.repeat(64));
  const replacedLane = registerLane(fixture.repoRoot, {
    backend: 'test',
    providerId: 'provider-replaced',
    displayName: '[test] replaced managed seat',
    state: 'archivedVerified',
    seat: { ...replaced, inode: replaced.inode + 1 },
  }, fixture.env);
  assert.throws(() => {
    removeManagedSeat(fixture.repoRoot, replacedLane.laneId, replacedHarvest, fixture.env);
  }, /identity changed/);

  const external = verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot);
  const externalLane = registerLane(fixture.repoRoot, {
    backend: 'test',
    providerId: 'provider-external',
    displayName: '[test] external seat',
    state: 'archivedVerified',
    seat: external,
  }, fixture.env);
  assert.throws(() => {
    removeManagedSeat(fixture.repoRoot, externalLane.laneId, null, fixture.env);
  }, /not operator-managed/);

  assert.throws(() => {
    removeManagedSeat(fixture.repoRoot, 'unowned-lane', null, fixture.env);
  }, /not owned/);
});

test('harvest receipts bind output digest, branch, and HEAD before cleanup', (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = crypto.randomUUID();
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  const receipt = captureHarvestReceipt(fixture.repoRoot, seat, 'a'.repeat(64));
  assert.equal(receipt.seat.clean, true);
  assert.equal(verifyHarvestedSeatForCleanup(fixture.repoRoot, seat, receipt).path, seat.path);
  fs.writeFileSync(path.join(seat.path, 'dirty.txt'), 'preserve\n');
  assert.throws(
    () => verifyHarvestedSeatForCleanup(fixture.repoRoot, seat, receipt),
    /dirty managed worktree/,
  );
  fs.unlinkSync(path.join(seat.path, 'dirty.txt'));
  fs.writeFileSync(path.join(seat.path, 'committed.txt'), 'new head\n');
  execFileSync('git', ['-C', seat.path, 'add', 'committed.txt']);
  execFileSync('git', ['-C', seat.path, 'commit', '-qm', 'advance after harvest']);
  assert.throws(
    () => verifyHarvestedSeatForCleanup(fixture.repoRoot, seat, receipt),
    /HEAD changed after output harvest/,
  );
});

test('managed removal rechecks the harvested HEAD inside the removal primitive', (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = crypto.randomUUID();
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  const receipt = captureHarvestReceipt(fixture.repoRoot, seat, 'e'.repeat(64));
  const lane = registerLane(fixture.repoRoot, {
    laneId,
    backend: 'test',
    providerId: 'provider-head-race',
    displayName: '[test] cleanup head race',
    state: 'archivedVerified',
    seat,
  }, fixture.env);
  fs.writeFileSync(path.join(seat.path, 'preserved.txt'), 'new committed work\n');
  execFileSync('git', ['-C', seat.path, 'add', 'preserved.txt']);
  execFileSync('git', ['-C', seat.path, 'commit', '-qm', 'advance before removal']);

  assert.throws(
    () => removeManagedSeat(fixture.repoRoot, lane.laneId, receipt, fixture.env),
    /HEAD changed after output harvest/,
  );
  assert.equal(fs.existsSync(seat.path), true);
  assert.equal(fs.readFileSync(path.join(seat.path, 'preserved.txt'), 'utf8'), 'new committed work\n');
});

test('a seat dirty at harvest never becomes cleanup-eligible later', (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = crypto.randomUUID();
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  const dirty = path.join(seat.path, 'preserve.txt');
  fs.writeFileSync(dirty, 'not harvested cleanly\n');
  const receipt = captureHarvestReceipt(fixture.repoRoot, seat, 'b'.repeat(64));
  assert.equal(receipt.seat.clean, false);
  fs.unlinkSync(dirty);
  assert.throws(
    () => verifyHarvestedSeatForCleanup(fixture.repoRoot, seat, receipt),
    /not clean when output was harvested/,
  );
});

test('ignored files make a managed seat ineligible and remain preserved', (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = crypto.randomUUID();
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  fs.writeFileSync(path.join(seat.path, '.gitignore'), 'ignored/\n');
  execFileSync('git', ['-C', seat.path, 'add', '.gitignore']);
  execFileSync('git', ['-C', seat.path, 'commit', '-qm', 'ignore generated data']);
  const receipt = captureHarvestReceipt(fixture.repoRoot, seat, '1'.repeat(64));
  assert.equal(receipt.seat.clean, true);
  const ignoredDirectory = path.join(seat.path, 'ignored');
  const ignoredFile = path.join(ignoredDirectory, 'data.txt');
  fs.mkdirSync(ignoredDirectory);
  fs.writeFileSync(ignoredFile, 'preserve ignored output\n');
  const lane = registerLane(fixture.repoRoot, {
    laneId,
    backend: 'test',
    providerId: 'provider-ignored-data',
    displayName: '[test] ignored data',
    state: 'archivedVerified',
    seat,
  }, fixture.env);

  assert.throws(
    () => removeManagedSeat(fixture.repoRoot, lane.laneId, receipt, fixture.env),
    (error) => isPermanentCleanupError(error) && /dirty managed worktree/.test(error.message),
  );
  assert.equal(fs.readFileSync(ignoredFile, 'utf8'), 'preserve ignored output\n');

  fs.unlinkSync(ignoredFile);
  const dirtyAtHarvest = path.join(ignoredDirectory, 'at-harvest.txt');
  fs.writeFileSync(dirtyAtHarvest, 'ignored before harvest\n');
  const dirtyReceipt = captureHarvestReceipt(fixture.repoRoot, seat, '2'.repeat(64));
  assert.equal(dirtyReceipt.seat.clean, false);
  fs.unlinkSync(dirtyAtHarvest);
  assert.throws(
    () => verifyHarvestedSeatForCleanup(fixture.repoRoot, seat, dirtyReceipt),
    /not clean when output was harvested/,
  );
});
