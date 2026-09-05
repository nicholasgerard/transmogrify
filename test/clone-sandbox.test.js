'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { sanitizedGitEnv } = require('../scripts/lib/git-env');
const { verifyRecordedSeat } = require('../scripts/lib/worktree');
const { createCloneProviderFixture } = require('./helpers/clone-provider-fixture');

function sandboxCommand(cwd, home, help, writableRoots, command) {
  const args = ['sandbox'];
  if (help.includes('--permission-profile')) {
    // Mirror the actual turn's extra roots in an isolated fixture profile.
    const entries = [':root', cwd, '/tmp', ...writableRoots]
      .map((root) => `${JSON.stringify(root)} = ${JSON.stringify(root === ':root' ? 'read' : 'write')}`);
    args.push('--permission-profile', 'clone_probe',
      '-c', `permissions.clone_probe.filesystem={ ${entries.join(', ')} }`);
  } else {
    args.push('-c', 'sandbox_mode="workspace-write"',
      '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`);
  }
  return spawnSync('codex', [...args, '-C', cwd, '--', ...command], {
    cwd, env: { ...sanitizedGitEnv(), CODEX_HOME: home }, encoding: 'utf8', timeout: 30000,
  });
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: sanitizedGitEnv(), encoding: 'utf8', stdio: 'pipe' }).trim();
}

test('real codex sandbox denies plain clone git add without the grant and permits add and commit with the turn grant', async (t) => {
  const help = spawnSync('codex', ['sandbox', '--help'], { encoding: 'utf8', timeout: 10000 });
  if (help.error?.code === 'ENOENT') {
    t.skip('codex is absent; the live sandbox assertion requires the host CLI');
    return;
  }
  assert.equal(help.status, 0, help.stderr || help.error?.message);
  const fixture = await createCloneProviderFixture(t);
  const policy = fixture.turnRequests[0].sandboxPolicy;
  assert.deepEqual(policy.writableRoots, [path.join(fixture.seat.path, '.git')]);
  assert.equal(fs.lstatSync(fixture.seat.gitDir).isDirectory(), true);
  const home = path.join(fixture.root, 'codex-home');
  fs.mkdirSync(home, { mode: 0o700 });
  const run = (roots, command) => sandboxCommand(fixture.seat.path, home, help.stdout, roots, command);
  const probe = run([], ['/usr/bin/true']);
  if (/sandbox_apply: Operation not permitted|bwrap:.*(?:Operation not permitted|No permissions)/u.test(probe.stderr || '')) {
    t.skip('this host context forbids starting a sandbox; rerun outside the enclosing sandbox');
    return;
  }
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
  fs.writeFileSync(path.join(fixture.seat.path, 'child.txt'), 'child commit with the exact Git write grant\n');
  const denied = run([], ['git', 'add', 'child.txt']);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /index\.lock.*(?:Operation not permitted|Permission denied)/u);
  assert.equal(git(fixture.seat.path, ['diff', '--cached', '--name-only']), '');
  for (const args of [['add', 'child.txt'], ['commit', '-qm', 'Commit sandbox fixture work']]) {
    const result = run(policy.writableRoots, ['git', ...args]);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  }
  const current = verifyRecordedSeat(fixture.repoRoot, fixture.seat);
  assert.notEqual(current.head, fixture.seat.head);
  assert.equal(git(fixture.seat.path, ['show', 'HEAD:child.txt']), 'child commit with the exact Git write grant');
  assert.equal(git(fixture.seat.path, ['status', '--porcelain']), '');
  assert.equal(git(fixture.seat.path, ['log', '-1', '--format=%s']), 'Commit sandbox fixture work');
});
