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
  cleanupStatus,
  createManagedSeat,
  isPermanentCleanupError,
  materializeManagedSeat,
  planManagedSeat,
  plannedProvisionedEntries,
  provisionSeat,
  requireIgnoredManagedRoot,
  removeProvisionedEntries,
  removeManagedSeat,
  validateProvisionedEntries,
  verifyRecordedSeat,
  verifyHarvestedSeatForCleanup,
  verifySeat,
} = require('../scripts/lib/worktree');
const { createRepoWithSeat } = require('./helpers/repo-fixture');

test('internal Git children receive no ambient credentials and disable hooks', (t) => {
  const clean = sanitizedGitEnv({
    HOME: '/tmp/home',
    PATH: '/usr/bin:/bin',
    API_TOKEN: 'secret-token',
    HTTPS_PROXY: 'https://user:password@example.invalid',
    SSH_AUTH_SOCK: '/tmp/private-agent.sock',
    GIT_DIR: '/tmp/redirected-git-dir',
  });
  assert.deepEqual(clean, {
    HOME: '/tmp/home',
    PATH: '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: clean.GIT_CONFIG_VALUE_0,
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'core.sshCommand',
    GIT_CONFIG_VALUE_2: '',
  });

  assert.deepEqual(fs.readdirSync(clean.GIT_CONFIG_VALUE_0), []);
  assert.equal(fs.statSync(clean.GIT_CONFIG_VALUE_0).mode & 0o077, 0);

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
  execFileSync('git', ['-C', fixture.repoRoot, 'fetch', '--no-tags', seat.path, `${seat.branchRef}:${seat.branchRef}`]);
  const removed = removeManagedSeat(fixture.repoRoot, lane.laneId, harvestReceipt, fixture.env);
  assert.equal(removed.lane.state, 'worktreeRemoved');
  assert.equal(fs.existsSync(seat.path), false);
  execFileSync('git', ['-C', fixture.repoRoot, 'show-ref', '--verify', '--quiet', seat.branchRef]);
});

test('managed seats provision exchange and shared dependencies without census dirt', (t) => {
  const fixture = createRepoWithSeat(t);
  fs.writeFileSync(path.join(fixture.repoRoot, 'package.json'), '{}\n');
  execFileSync('git', ['-C', fixture.repoRoot, 'add', 'package.json']);
  execFileSync('git', ['-C', fixture.repoRoot, 'commit', '-qm', 'add package manifest']);
  const dependencies = path.join(fixture.repoRoot, 'node_modules');
  fs.mkdirSync(dependencies);
  fs.writeFileSync(path.join(dependencies, 'shared.txt'), 'shared dependency\n');
  const publicIgnore = fs.readFileSync(path.join(fixture.repoRoot, '.gitignore'), 'utf8');

  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, crypto.randomUUID());
  assert.deepEqual(seat.provisioned.map((entry) => entry.name), ['.transmogrify', 'node_modules']);
  assert.deepEqual(validateProvisionedEntries(seat.provisioned).shape, 'receipts');
  assert.throws(
    () => verifyRecordedSeat(fixture.repoRoot, { ...seat, provisioned: ['../escape'] }),
    /safe top-level relative paths/,
  );
  assert.equal(fs.lstatSync(path.join(seat.path, 'node_modules')).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(path.join(seat.path, 'node_modules')), fs.realpathSync(dependencies));
  assert.equal(cleanupStatus(seat.path, seat.provisioned).clean, true);
  assert.equal(cleanupStatus(seat.path).clean, false, 'older records keep counting ignored files as dirt');

  const exclude = fs.readFileSync(path.join(seat.gitDir, 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split(/\r?\n/u).filter((line) => line === '.transmogrify/').length, 1);
  provisionSeat(fixture.repoRoot, seat);
  const repeated = fs.readFileSync(path.join(seat.gitDir, 'info', 'exclude'), 'utf8');
  assert.equal(fs.readFileSync(path.join(fixture.repoRoot, '.git', 'info', 'exclude'), 'utf8').includes('.transmogrify/'), false);
  assert.equal(repeated.split(/\r?\n/u).filter((line) => line === '.transmogrify/').length, 1);
  assert.equal(fs.readFileSync(path.join(fixture.repoRoot, '.gitignore'), 'utf8'), publicIgnore);
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

test('managed seat intent is durable and a retry without provision receipts is refused', (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = crypto.randomUUID();
  const intent = planManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  assert.equal(fs.existsSync(intent.path), false);
  assert.equal(intent.branchRef, `refs/heads/transmogrify/${laneId}`);
  const first = materializeManagedSeat(fixture.repoRoot, intent);
  assert.throws(
    () => materializeManagedSeat(fixture.repoRoot, intent),
    /pre-existing lane provision without a creation receipt/,
  );
  assert.deepEqual(verifyRecordedSeat(
    fixture.repoRoot,
    JSON.parse(JSON.stringify(first)),
  ), first);
  assert.throws(() => materializeManagedSeat(fixture.repoRoot, {
    ...intent,
    baseCommit: 'f'.repeat(intent.baseCommit.length),
  }), /does not match its durable intent/);
});

test('an external seat with a pre-existing exchange directory is never adopted', (t) => {
  const fixture = createRepoWithSeat(t);
  const exchange = path.join(fixture.seat, '.transmogrify');
  fs.mkdirSync(exchange);
  fs.writeFileSync(path.join(exchange, 'owner-output.txt'), 'preserve me\n');
  const external = {
    ...verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot),
    provisioned: plannedProvisionedEntries(fixture.repoRoot),
  };

  assert.throws(
    () => provisionSeat(fixture.repoRoot, external),
    /pre-existing lane provision without a creation receipt/,
  );
  assert.equal(fs.readFileSync(path.join(exchange, 'owner-output.txt'), 'utf8'), 'preserve me\n');
});

test('a replaced dependency provision is dirt and is never removed', (t) => {
  const fixture = createRepoWithSeat(t);
  fs.writeFileSync(path.join(fixture.repoRoot, 'package.json'), '{}\n');
  execFileSync('git', ['-C', fixture.repoRoot, 'add', 'package.json']);
  execFileSync('git', ['-C', fixture.repoRoot, 'commit', '-qm', 'add package manifest']);
  fs.mkdirSync(path.join(fixture.repoRoot, 'node_modules'));
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, crypto.randomUUID());
  const dependency = path.join(seat.path, 'node_modules');
  fs.unlinkSync(dependency);
  fs.mkdirSync(dependency);
  const output = path.join(dependency, 'child-output.txt');
  fs.writeFileSync(output, 'preserve child output\n');

  assert.equal(cleanupStatus(seat.path, seat.provisioned).clean, false);
  assert.throws(
    () => removeProvisionedEntries(seat),
    (error) => isPermanentCleanupError(error) && /changed provisioned entry/.test(error.message),
  );
  assert.equal(fs.readFileSync(output, 'utf8'), 'preserve child output\n');
});

test('an exchange directory with extra output blocks provision cleanup', (t) => {
  const fixture = createRepoWithSeat(t);
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, crypto.randomUUID());
  const output = path.join(seat.path, '.transmogrify', 'unexpected.txt');
  fs.writeFileSync(output, 'preserve unexpected output\n');

  assert.throws(
    () => removeProvisionedEntries(seat),
    (error) => isPermanentCleanupError(error) && /unexpected output/.test(error.message),
  );
  assert.equal(fs.readFileSync(output, 'utf8'), 'preserve unexpected output\n');
});

test('version 0.6.0 name-only provisions stay on manual cleanup', (t) => {
  const fixture = createRepoWithSeat(t);
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, crypto.randomUUID());
  const legacy = seat.provisioned.map((entry) => entry.name);
  assert.equal(validateProvisionedEntries(legacy).shape, 'legacy-names');
  assert.equal(cleanupStatus(seat.path, legacy).clean, false);
  assert.deepEqual(removeProvisionedEntries({ ...seat, provisioned: legacy }), []);
  assert.equal(fs.existsSync(path.join(seat.path, '.transmogrify')), true);
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
  execFileSync('git', ['-C', fixture.repoRoot, 'fetch', '--no-tags', seat.path, `${seat.branchRef}:${seat.branchRef}`]);
  fs.rmSync(seat.path, { recursive: true });
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

test('clone seats keep independent Git metadata and dissociate small measured repositories', (t) => {
  const fixture = createRepoWithSeat(t);
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, crypto.randomUUID());
  assert.equal(seat.kind, 'clone');
  assert.equal(seat.gitDir, path.join(seat.path, '.git'));
  assert.equal(fs.lstatSync(seat.gitDir).isDirectory(), true);
  assert.equal(seat.gitInode, fs.statSync(seat.gitDir).ino);
  assert.equal(seat.objectStorage.mode, 'dissociate');
  assert.equal(seat.objectStorage.maxKiB, 32768);
  assert.ok(seat.objectStorage.sizeKiB <= 32768);
  assert.match(seat.objectStorage.measurement, /^count: /);
  assert.equal(seat.alternates.content, null);
  assert.equal(fs.existsSync(seat.alternates.path), false);
  assert.equal(execFileSync('git', ['-C', seat.path, 'config', 'user.name'], { encoding: 'utf8' }).trim(), 'Test');
  assert.equal(execFileSync('git', ['-C', seat.path, 'config', 'user.email'], { encoding: 'utf8' }).trim(), 'test@example.invalid');
  assert.equal(execFileSync('git', ['-C', fixture.repoRoot, 'worktree', 'list'], { encoding: 'utf8' }).includes(seat.path), false);
});

test('reference clone receipts pin alternates and local objects survive an operator repack', (t) => {
  const fixture = createRepoWithSeat(t);
  // A zero duplication budget exercises the large-repository branch using
  // the producer's real measurement and real clone output.
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, crypto.randomUUID(), { dissociateMaxKiB: 0 });
  assert.equal(seat.objectStorage.mode, 'reference');
  assert.ok(seat.objectStorage.sizeKiB > seat.objectStorage.maxKiB);
  assert.equal(seat.alternates.path, path.join(seat.gitDir, 'objects', 'info', 'alternates'));
  assert.equal(seat.alternates.content, `${path.join(seat.gitCommonDir, 'objects')}\n`);
  const object = path.join(seat.gitCommonDir, 'objects', seat.baseCommit.slice(0, 2), seat.baseCommit.slice(2));
  const copied = path.join(seat.gitDir, 'objects', seat.baseCommit.slice(0, 2), seat.baseCommit.slice(2));
  assert.notEqual(fs.statSync(object).ino, fs.statSync(copied).ino, 'clone must not hardlink the shared object store');
  execFileSync('git', ['-C', fixture.repoRoot, 'repack', '-ad']);
  execFileSync('git', ['-C', fixture.repoRoot, 'prune-packed']);
  assert.equal(verifyRecordedSeat(fixture.repoRoot, seat).head, seat.head);
  assert.equal(fs.existsSync(copied), true);
  fs.writeFileSync(seat.alternates.path, `${seat.gitCommonDir}\n`);
  assert.throws(() => verifyRecordedSeat(fixture.repoRoot, seat), /alternates entry changed/);
  fs.unlinkSync(seat.alternates.path);
  assert.throws(() => verifyRecordedSeat(fixture.repoRoot, seat), /alternates entry changed/);
  fs.symlinkSync(object, seat.alternates.path);
  assert.throws(() => verifyRecordedSeat(fixture.repoRoot, seat), /bounded regular file/);
});

test('clone verification refuses origin, branch, Git directory identity, and added alternates drift', (t) => {
  const fixture = createRepoWithSeat(t);
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, crypto.randomUUID());
  execFileSync('git', ['-C', seat.path, 'remote', 'set-url', 'origin', fixture.root]);
  assert.throws(() => verifyRecordedSeat(fixture.repoRoot, seat), /clone origin/);
  execFileSync('git', ['-C', seat.path, 'remote', 'set-url', 'origin', fs.realpathSync(fixture.repoRoot)]);
  execFileSync('git', ['-C', seat.path, 'checkout', '-qb', 'unexpected-branch']);
  assert.throws(() => verifyRecordedSeat(fixture.repoRoot, seat), /identity changed/);
  execFileSync('git', ['-C', seat.path, 'checkout', '-q', seat.branchRef.slice('refs/heads/'.length)]);
  fs.writeFileSync(seat.alternates.path, `${path.join(seat.gitCommonDir, 'objects')}\n`);
  assert.throws(() => verifyRecordedSeat(fixture.repoRoot, seat), /alternates entry changed/);
  fs.unlinkSync(seat.alternates.path);
  const original = `${seat.gitDir}.original`;
  fs.renameSync(seat.gitDir, original);
  fs.cpSync(original, seat.gitDir, { recursive: true });
  assert.throws(() => verifyRecordedSeat(fixture.repoRoot, seat), /identity changed \(gitInode\)/);
});

test('clone cleanup preserves the entire seat when HEAD has not been fetched', (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = crypto.randomUUID();
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  const receipt = captureHarvestReceipt(fixture.repoRoot, seat, 'a'.repeat(64));
  registerLane(fixture.repoRoot, {
    laneId, backend: 'test', providerId: 'unfetched-clone', displayName: '::: unfetched clone',
    state: 'archivedVerified', seat,
  }, fixture.env);
  assert.throws(() => removeManagedSeat(fixture.repoRoot, laneId, receipt, fixture.env), /has not been fetched/);
  assert.equal(fs.existsSync(path.join(seat.path, '.transmogrify')), true);
  assert.equal(fs.existsSync(seat.gitDir), true);
});

test('earlier managed worktree seats retain registration verification and Git removal', (t) => {
  const fixture = createRepoWithSeat(t);
  // The fixture creates a real linked worktree, as releases before clone seats did.
  const legacy = { ...verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot), managed: true };
  assert.equal(legacy.kind, undefined);
  assert.equal(fs.lstatSync(path.join(legacy.path, '.git')).isFile(), true);
  assert.deepEqual(verifyRecordedSeat(fixture.repoRoot, legacy), legacy);
  const receipt = captureHarvestReceipt(fixture.repoRoot, legacy, 'f'.repeat(64));
  const lane = registerLane(fixture.repoRoot, {
    backend: 'test', providerId: 'legacy-worktree', displayName: '::: legacy worktree',
    state: 'archivedVerified', seat: legacy,
  }, fixture.env);
  removeManagedSeat(fixture.repoRoot, lane.laneId, receipt, fixture.env);
  assert.equal(fs.existsSync(legacy.path), false);
  assert.equal(execFileSync('git', ['-C', fixture.repoRoot, 'worktree', 'list'], { encoding: 'utf8' }).includes(legacy.path), false);
  assert.equal(execFileSync('git', ['-C', fixture.repoRoot, 'rev-parse', legacy.branchRef], { encoding: 'utf8' }).trim(), legacy.head);
});
