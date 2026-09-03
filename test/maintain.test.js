'use strict';

// scripts/maintain.js: the bounded maintenance runner (doctor plus each
// available provider's exact-owned reconcile) and its --retention mode.
// Provider I/O is always faked through dependency injection; only usage
// errors and one fully isolated retention pass are exercised as a real
// spawned process, so this file never needs a live Codex runtime or Claude
// CLI and never touches this machine's real installer backups.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { main } = require('../scripts/maintain');
const { beginLaneOperation, registerLane } = require('../scripts/lib/state');
const { createStateFixture } = require('./helpers/state-fixture');
const { runNodeScript } = require('./helpers/run-cli');

function fakeDoctor(providers, setup = { ready: true, ownerActions: [] }) {
  return async () => ({
    version: 1,
    ok: true,
    mode: 'read-only-provider-probe',
    providerMutationsAttempted: false,
    registry: { state: 'ready', outsideRepository: true, ownership: {} },
    providers,
    setup,
    nextSafeMaintenanceCommands: [],
  });
}

const BOTH_AVAILABLE = {
  codex: { requested: true, available: true, reusable: true },
  claude: { requested: true, available: true, reusable: true },
};

test('maintain reconciles every available provider and reports aggregate registry counts without leaking identity', async (t) => {
  const fixture = createStateFixture(t);
  const laneActive = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server', providerId: 'codex-active-secret', displayName: '[test] active codex', state: 'active',
  }, fixture.env);
  registerLane(fixture.repoRoot, {
    backend: 'claude-code', providerId: 'claude-created-secret', displayName: '[test] created claude', state: 'created',
  }, fixture.env);
  registerLane(fixture.repoRoot, {
    backend: 'claude-code', providerId: 'claude-stopped-secret', displayName: '[test] stopped claude', state: 'stopped',
  }, fixture.env);
  const laneSteer = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server', providerId: 'codex-steer-secret', displayName: '[test] pending steer', state: 'active',
  }, fixture.env);
  beginLaneOperation(fixture.repoRoot, laneSteer.laneId, { type: 'steer', details: {} }, fixture.env);
  const laneRetireBlocked = registerLane(fixture.repoRoot, {
    backend: 'claude-code', providerId: 'claude-retire-blocked-secret', displayName: '[test] retire blocked', state: 'retireRequested',
  }, fixture.env);
  beginLaneOperation(fixture.repoRoot, laneRetireBlocked.laneId, {
    type: 'retire', details: { cleanupBlocked: true },
  }, fixture.env);
  const laneRetireClean = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server', providerId: 'codex-retire-clean-secret', displayName: '[test] retire clean', state: 'retireRequested',
  }, fixture.env);
  beginLaneOperation(fixture.repoRoot, laneRetireClean.laneId, { type: 'retire', details: {} }, fixture.env);
  registerLane(fixture.repoRoot, {
    backend: 'codex-app-server', providerId: 'codex-removed-secret', displayName: '[test] worktree removed', state: 'worktreeRemoved',
  }, fixture.env);

  const calls = [];
  const result = await main(['--repo-root', fixture.repoRoot, '--target', 'all'], fixture.env, {
    doctor: fakeDoctor(BOTH_AVAILABLE),
    codexReconcile: async (options) => {
      calls.push({ target: 'codex', options });
      return {
        version: 1, ok: true, operation: 'reconcile', adapter: 'codex-app-server',
        recovered: [{ laneId: 'x', state: 'active', outcome: 'ok' }],
      };
    },
    claudeReconcile: async (options) => {
      calls.push({ target: 'claude', options });
      return {
        version: 1, ok: true, operation: 'reconcile', adapter: 'claude-code',
        results: [{ laneId: 'y', state: 'idle' }, { laneId: 'z', error: 'boom', code: 'SOME_CODE' }],
      };
    },
  });

  assert.equal(result.version, 1);
  assert.equal(result.operation, 'maintain');
  assert.equal(result.dryRun, false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.providers.codex, { available: true, reconciled: true, results: 1, notOk: 0, skipped: null });
  assert.deepEqual(result.providers.claude, { available: true, reconciled: true, results: 2, notOk: 1, skipped: null });
  assert.deepEqual(result.counts, {
    ownedActive: 3,
    ownedStopped: 1,
    pendingOperations: 3,
    pendingRetirements: 2,
    cleanupBlocked: 1,
    unattendedChildren: 0,
  });
  assert.deepEqual(result.setup, { ready: true, ownerActions: [] });
  assert.deepEqual(calls.map((call) => call.target), ['codex', 'claude']);
  assert.equal(calls[0].options.repoRoot, fixture.repoRoot);
  assert.equal(calls[1].options.repoRoot, fixture.repoRoot);

  const serialized = JSON.stringify(result);
  for (const secret of [
    laneActive.laneId, laneSteer.laneId, laneRetireBlocked.laneId, laneRetireClean.laneId,
    'codex-active-secret', 'claude-retire-blocked-secret', 'codex-retire-clean-secret', fixture.repoRoot,
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('an unavailable or unrequested provider is skipped with a reason, and its reconcile is never invoked', async (t) => {
  const fixture = createStateFixture(t);
  const result = await main(['--repo-root', fixture.repoRoot, '--target', 'all'], fixture.env, {
    doctor: fakeDoctor({
      codex: { requested: true, available: false, reusable: false },
      claude: { requested: false, available: null, reusable: null },
    }),
    codexReconcile: async () => { throw new Error('must not be called: codex is unavailable'); },
    claudeReconcile: async () => { throw new Error('must not be called: claude was not requested'); },
  });
  assert.equal(result.ok, true, 'no available provider failed to reconcile');
  assert.deepEqual(result.providers.codex, {
    available: false, reconciled: false, results: 0, notOk: 0, skipped: 'provider-unavailable',
  });
  assert.deepEqual(result.providers.claude, {
    available: null, reconciled: false, results: 0, notOk: 0, skipped: 'not-requested',
  });
});

test('a provider reconcile that returns ok:false, or that throws, fails the overall result', async (t) => {
  const fixture = createStateFixture(t);
  const result = await main(['--repo-root', fixture.repoRoot, '--target', 'all'], fixture.env, {
    doctor: fakeDoctor(BOTH_AVAILABLE),
    codexReconcile: async () => ({
      version: 1, ok: false, operation: 'reconcile', adapter: 'codex-app-server',
      recovered: [{ laneId: 'x', error: 'boom', code: 'RUNTIME_MISMATCH' }],
    }),
    claudeReconcile: async () => {
      throw Object.assign(new Error('transport failed'), { code: 'TRANSPORT_ERROR' });
    },
  });
  assert.equal(result.ok, false, 'the CLI tail exits 3 whenever ok is false');
  assert.deepEqual(result.providers.codex, { available: true, reconciled: false, results: 1, notOk: 1, skipped: null });
  assert.deepEqual(result.providers.claude, { available: true, reconciled: false, results: 0, notOk: 0, skipped: null, code: 'TRANSPORT_ERROR' });
});

test('--dry-run skips every reconcile and reports what would run', async (t) => {
  const fixture = createStateFixture(t);
  const result = await main(['--repo-root', fixture.repoRoot, '--target', 'all', '--dry-run'], fixture.env, {
    doctor: fakeDoctor(BOTH_AVAILABLE),
    codexReconcile: async () => { throw new Error('must not reconcile during a dry run'); },
    claudeReconcile: async () => { throw new Error('must not reconcile during a dry run'); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.providers.codex, { available: true, reconciled: false, results: 0, notOk: 0, skipped: 'dry-run' });
  assert.deepEqual(result.providers.claude, { available: true, reconciled: false, results: 0, notOk: 0, skipped: 'dry-run' });
});

test('--target codex runs only the codex reconcile and rejects a Claude-only flag', async (t) => {
  const fixture = createStateFixture(t);
  let claudeTouched = false;
  const result = await main(['--repo-root', fixture.repoRoot, '--target', 'codex'], fixture.env, {
    doctor: fakeDoctor({
      codex: { requested: true, available: true, reusable: true },
      claude: { requested: false, available: null, reusable: null },
    }),
    codexReconcile: async () => ({ version: 1, ok: true, operation: 'reconcile', adapter: 'codex-app-server', recovered: [] }),
    claudeReconcile: async () => { claudeTouched = true; throw new Error('must not run'); },
  });
  assert.equal(result.ok, true);
  assert.equal(claudeTouched, false);
  assert.equal(result.providers.claude.skipped, 'not-requested');

  const rejected = await runNodeScript('scripts/maintain.js', [
    '--repo-root', fixture.repoRoot, '--target', 'codex', '--private-archive',
  ]);
  assert.equal(rejected.code, 2);
  assert.equal(JSON.parse(rejected.stderr).code, 'USAGE_ERROR');
});

test('usage errors are refused before any provider or retention pass runs, with a real exit code', async () => {
  const missingRepoRoot = await runNodeScript('scripts/maintain.js', ['--target', 'all']);
  assert.equal(missingRepoRoot.code, 2);
  assert.equal(JSON.parse(missingRepoRoot.stderr).code, 'USAGE_ERROR');
  assert.equal(missingRepoRoot.stdout, '');

  const badTarget = await runNodeScript('scripts/maintain.js', ['--repo-root', '/tmp', '--target', 'bogus']);
  assert.equal(badTarget.code, 2);

  const foreignUrl = await runNodeScript('scripts/maintain.js', [
    '--repo-root', '/tmp', '--target', 'claude', '--url', 'ws://127.0.0.1:8843/',
  ]);
  assert.equal(foreignUrl.code, 2);
  assert.equal(JSON.parse(foreignUrl.stderr).code, 'USAGE_ERROR');

  const retentionConflict = await runNodeScript('scripts/maintain.js', [
    '--repo-root', '/tmp', '--retention', '--target', 'codex',
  ]);
  assert.equal(retentionConflict.code, 2);

  const misplacedKeepDays = await runNodeScript('scripts/maintain.js', ['--repo-root', '/tmp', '--keep-days', '10']);
  assert.equal(misplacedKeepDays.code, 2);

  const help = await runNodeScript('scripts/maintain.js', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^usage: maintain\.js/);
});

test('--retention runs end to end as a real process, isolated from this machine\'s own installer backups', async (t) => {
  const fixture = createStateFixture(t);
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-maintain-retention-home-'));
  t.after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));
  const dryRun = await runNodeScript('scripts/maintain.js', [
    '--repo-root', fixture.repoRoot, '--retention', '--dry-run',
  ], { env: { ...fixture.env, HOME: fakeHome } });
  assert.equal(dryRun.code, 0, dryRun.stderr);
  const parsed = JSON.parse(dryRun.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.operation, 'maintain');
  assert.deepEqual(parsed.retention, {
    dryRun: true,
    keepDays: 30,
    keepBackups: 3,
    operations: { candidates: 0, moved: 0 },
    events: { candidates: 0, moved: 0 },
    backups: { candidates: 0, moved: 0 },
    trashDir: false,
  });
});
