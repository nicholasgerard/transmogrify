'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { registerLane } = require('../scripts/lib/state');
const { verifySeat } = require('../scripts/lib/worktree');
const { startMockAppServer } = require('./helpers/mock-app-server');
const { runNodeScript } = require('./helpers/run-cli');
const { createRepoWithSeat } = require('./helpers/repo-fixture');
const { REPO_ROOT } = require('./helpers/run-cli');

function runSteerWithStdin(args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts/steer.js'), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('steer help exposes the compatibility control options', async () => {
  const result = await runNodeScript('scripts/steer.js', ['--help']);
  assert.equal(result.code, 0, result.stderr);
  for (const flag of ['--resume', '--interrupt', '--input-file', '--url', '--repo-root', '--prefix', '--no-prefix']) {
    assert.match(result.stdout, new RegExp(flag));
  }
});

test('steer reads exact bounded UTF-8 from stdin without placing it in argv', async (t) => {
  const message = 'exact stdin directive\nwith a second line';
  let env;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return ownedThreadRead(env, 'active');
    }
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{ id: 'turn-stdin', status: 'inProgress', items: [] }] } };
    }
    assert.equal(request.method, 'turn/steer');
    assert.deepEqual(request.params.input, [{ type: 'text', text: message }]);
    return { result: { turnId: 'turn-stdin' } };
  });
  t.after(() => server.close());
  env = ownedEnv(t, server.url);
  const result = await runSteerWithStdin([
    '--url', server.url, '--no-prefix', '--input-file', '-', 'owned-thread',
  ], message, env);
  assert.equal(result.code, 0, result.stderr);
});

test('steer input-file mode rejects mixed, symlinked, oversized, and invalid UTF-8 input', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-steer-input-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const safe = path.join(root, 'safe.txt');
  fs.writeFileSync(safe, 'safe', { mode: 0o600 });
  const linked = path.join(root, 'linked.txt');
  fs.symlinkSync(safe, linked);
  const oversized = path.join(root, 'oversized.txt');
  fs.writeFileSync(oversized, Buffer.alloc(64 * 1024 + 1), { mode: 0o600 });
  const invalid = path.join(root, 'invalid.txt');
  fs.writeFileSync(invalid, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
  for (const args of [
    ['--input-file', safe, 'owned-thread', 'legacy'],
    ['--input-file', linked, 'owned-thread'],
    ['--input-file', oversized, 'owned-thread'],
    ['--input-file', invalid, 'owned-thread'],
  ]) {
    const result = await runNodeScript('scripts/steer.js', args);
    assert.equal(result.code, 3, `${args.join(' ')}\n${result.stderr}`);
  }
});

function ownedEnv(t, url, providerId = 'owned-thread') {
  const fixture = createRepoWithSeat(t);
  registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId,
    displayName: '[test] owned CLI lane',
    state: 'active',
    runtime: {
      endpoint: new URL(url).toString(),
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
    },
    seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot),
  }, fixture.env);
  return {
    REPO_ROOT: fixture.repoRoot,
    TRANSMOGRIFY_STATE_DIR: fixture.stateDir,
    TRANSMOGRIFY_TEST_SEAT: fs.realpathSync(fixture.seat),
  };
}

function ownedThreadRead(env, status = 'active', providerId = 'owned-thread') {
  return { result: { thread: {
    id: providerId,
    cwd: env.TRANSMOGRIFY_TEST_SEAT,
    status: status === 'active'
      ? { type: 'active', activeFlags: [] }
      : { type: status },
  } } };
}

test('steer exits 2 when the newest turn is not active', async (t) => {
  let env;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') return ownedThreadRead(env, 'idle');
    if (request.method === 'thread/turns/list') return { result: { data: [] } };
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  env = ownedEnv(t, server.url);

  const result = await runNodeScript('scripts/steer.js', [
    '--url', server.url, 'owned-thread', 'continue',
  ], { env });
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /no active turn/);
});

test('steer treats only the measured unmaterialized-thread error as no active turn', async (t) => {
  let env;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') return ownedThreadRead(env, 'idle');
    if (request.method === 'thread/turns/list') {
      return { error: { code: -32600, message: 'Thread is not materialized yet' } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  env = ownedEnv(t, server.url);

  const result = await runNodeScript('scripts/steer.js', [
    '--url', server.url, 'owned-thread', 'continue',
  ], { env });
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /no active turn/);
});

test('steer does not mask an unrelated -32600 protocol error', async (t) => {
  let env;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') return ownedThreadRead(env, 'idle', 'missing-thread');
    if (request.method === 'thread/turns/list') {
      return { error: { code: -32600, message: 'rollout not found for thread missing-thread' } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  env = ownedEnv(t, server.url, 'missing-thread');

  const result = await runNodeScript('scripts/steer.js', [
    '--url', server.url, 'missing-thread', 'continue',
  ], { env });
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stderr, /Codex control operation failed/);
  assert.doesNotMatch(result.stderr, /rollout not found|missing-thread/);
});

test('steer maps a measured turn/steer race to exit 2', async (t) => {
  let env;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') return ownedThreadRead(env, 'active');
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{ id: 'turn-1', status: 'inProgress', items: [] }] } };
    }
    assert.equal(request.method, 'turn/steer');
    return { error: { code: -32600, message: 'no active turn to steer' } };
  });
  t.after(() => server.close());
  env = ownedEnv(t, server.url);

  const result = await runNodeScript('scripts/steer.js', [
    '--url', server.url, 'owned-thread', 'continue',
  ], { env });
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /no active turn to steer/);
});

test('steer validates the WebSocket URL before connecting', async () => {
  const result = await runNodeScript('scripts/steer.js', [
    '--url', 'file:///tmp/socket', 'owned-thread', 'continue',
  ]);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /WebSocket URL/i);
});

test('steer refuses an unowned thread before connecting', async (t) => {
  const fixture = createRepoWithSeat(t);
  registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'different-thread',
    displayName: '[test] different',
    state: 'active',
    runtime: {
      endpoint: 'ws://127.0.0.1:1/',
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
    },
    seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot),
  }, fixture.env);
  const result = await runNodeScript('scripts/steer.js', [
    '--url', 'ws://127.0.0.1:1', 'foreign-thread', 'continue',
  ], {
    env: { REPO_ROOT: fixture.repoRoot, TRANSMOGRIFY_STATE_DIR: fixture.stateDir },
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /NOT_OWNED/);
});
