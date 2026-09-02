'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureRegistry, registerLane } = require('../../scripts/lib/state');

function createStateFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-state-'));
  const repoRoot = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(repoRoot);
  execFileSync('git', ['init', '--quiet', repoRoot]);
  const env = { ...process.env, TRANSMOGRIFY_STATE_DIR: stateDir };
  ensureRegistry(repoRoot, env);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repoRoot, stateDir, env };
}

function registerTestLane(t, options = {}) {
  const fixture = createStateFixture(t);
  const lane = registerLane(fixture.repoRoot, {
    backend: options.backend || 'codex-app-server',
    providerId: options.providerId || 'owned-thread',
    displayName: options.displayName || '[test] owned lane',
    state: options.state || 'active',
  }, fixture.env);
  return { ...fixture, lane };
}

module.exports = { createStateFixture, registerTestLane };
