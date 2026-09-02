'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureRegistry } = require('../../scripts/lib/state');

function createRepoWithSeat(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-repo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  const worktreesRoot = path.join(repoRoot, '.worktrees');
  const seat = path.join(worktreesRoot, 'lane');
  fs.mkdirSync(repoRoot);
  execFileSync('git', ['init', '--quiet', repoRoot]);
  execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'test\n');
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), '.worktrees/\n');
  execFileSync('git', ['-C', repoRoot, 'add', 'README.md', '.gitignore']);
  execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '-m', 'initial']);
  fs.mkdirSync(worktreesRoot, { mode: 0o700 });
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '-q', '-b', 'lane/test', seat]);
  const env = { ...process.env, TRANSMOGRIFY_STATE_DIR: stateDir };
  ensureRegistry(repoRoot, env);
  return { root, repoRoot, stateDir, worktreesRoot, seat, env };
}

module.exports = { createRepoWithSeat };
