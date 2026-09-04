'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { startMockAppServer } = require('./helpers/mock-app-server');
const { REPO_ROOT, runNodeScript } = require('./helpers/run-cli');
const { registerLane } = require('../scripts/lib/state');
const { createStateFixture, registerTestLane } = require('./helpers/state-fixture');

function runRpcWithStdin(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts/rpc.js'), ...args], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('rpc exposes complete bounded read-only help', async () => {
  const result = await runNodeScript('scripts/rpc.js', ['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^usage: rpc\.js/);
  assert.match(result.stdout, /thread\/turns\/list/);
  assert.match(result.stdout, /--repo-root/);
  assert.match(result.stdout, /65536 bytes/);
});

test('rpc supplies empty object params when they are omitted', async (t) => {
  const server = await startMockAppServer((request) => {
    assert.equal(request.method, 'thread/list');
    assert.deepEqual(request.params, {});
    return { result: { data: [], nextCursor: null } };
  });
  t.after(() => server.close());

  const result = await runNodeScript('scripts/rpc.js', ['thread/list', '--url', server.url]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    data: [], nextPage: false, backwardsPage: false,
  });
});

test('rpc thread census redacts unrelated content and private filesystem metadata', async (t) => {
  const server = await startMockAppServer(() => ({
    result: {
      data: [{
        id: 'thread-private-id',
        parentThreadId: null,
        preview: 'private prompt text',
        name: 'private task name',
        cwd: '/Users/private/repository',
        path: '/Users/private/session.jsonl',
        gitInfo: { originUrl: 'https://example.invalid/private.git' },
        status: { type: 'active', activeFlags: ['waitingOnApproval'] },
        createdAt: 1,
        updatedAt: 2,
        source: 'vscode',
      }],
      nextCursor: 'cursor-safe',
    },
  }));
  t.after(() => server.close());

  const result = await runNodeScript('scripts/rpc.js', ['thread/list', '--url', server.url]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    data: [{
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      createdAt: 1,
      updatedAt: 2,
      source: 'vscode',
    }],
    nextPage: true,
    backwardsPage: false,
  });
  for (const secret of [
    'thread-private-id', 'private prompt text', 'private task name', '/Users/private/repository',
    '/Users/private/session.jsonl', 'https://example.invalid/private.git',
  ]) {
    assert.equal(result.stdout.includes(secret), false, secret);
  }
});

test('rpc census omits hostile status, flag, and source strings', async (t) => {
  const secret = 'private-control-text';
  const server = await startMockAppServer(() => ({
    result: {
      data: [{
        status: { type: 'active', activeFlags: [secret] },
        source: secret,
        createdAt: 1,
      }, {
        status: { type: secret },
        source: { custom: secret },
        updatedAt: 2,
      }],
      nextCursor: null,
    },
  }));
  t.after(() => server.close());
  const result = await runNodeScript('scripts/rpc.js', ['thread/list', '--url', server.url]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    data: [{ createdAt: 1 }, { updatedAt: 2 }],
    nextPage: false,
    backwardsPage: false,
  });
  assert.equal(result.stdout.includes(secret), false);
});

test('rpc census rejects malformed shapes and never emits opaque cursors', async (t) => {
  const secret = 'token=secret /Users/private thread-private-id';
  for (const providerResult of [
    secret,
    [secret],
    { nextCursor: secret },
    { data: [], nextCursor: { secret } },
  ]) {
    const server = await startMockAppServer(() => ({ result: providerResult }));
    t.after(() => server.close());
    const result = await runNodeScript('scripts/rpc.js', ['thread/list', '--url', server.url]);
    assert.equal(result.code, 3);
    assert.equal(JSON.parse(result.stderr).code, 'PROTOCOL_ERROR');
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
  }

  const server = await startMockAppServer(() => ({
    result: { data: [], nextCursor: secret, backwardsCursor: secret },
  }));
  t.after(() => server.close());
  const result = await runNodeScript('scripts/rpc.js', ['thread/list', '--url', server.url]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    data: [], nextPage: true, backwardsPage: true,
  });
  assert.equal(result.stdout.includes(secret), false);
});

test('rpc rejects invalid timeout and URL values as usage errors', async () => {
  const badTimeout = await runNodeScript('scripts/rpc.js', [
    'thread/list', '--timeout-ms', 'tomorrow',
  ]);
  assert.equal(badTimeout.code, 2);
  assert.equal(JSON.parse(badTimeout.stderr).code, 'USAGE_ERROR');

  const badUrl = await runNodeScript('scripts/rpc.js', [
    'thread/list', '--url', 'http://127.0.0.1:8843',
  ]);
  assert.equal(badUrl.code, 2);
  assert.equal(JSON.parse(badUrl.stderr).code, 'USAGE_ERROR');
});

test('rpc refuses methods outside its read-only allowlist', async () => {
  const result = await runNodeScript('scripts/rpc.js', ['thread/archive', '{}']);
  assert.equal(result.code, 2);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'POLICY_REFUSAL');
  assert.match(error.message, /refused by read-only policy/);
});

test('rpc redacts provider errors to a stable public projection', async (t) => {
  const secret = 'private prompt /Users/private/repo token=secret';
  const server = await startMockAppServer(() => ({
    error: { code: -32000, message: secret, data: { transcript: secret } },
  }));
  t.after(() => server.close());

  const result = await runNodeScript('scripts/rpc.js', ['thread/list', '--url', server.url]);
  assert.equal(result.code, 3);
  const error = JSON.parse(result.stderr);
  assert.deepEqual(error, {
    version: 1,
    ok: false,
    code: 'RPC_ERROR',
    message: 'app-server returned an RPC error',
    rpcCode: -32000,
  });
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(result.stderr.includes('/Users/private'), false);
});

test('rpc fails closed before requests or output against an unverified runtime', async (t) => {
  let calls = 0;
  const secret = 'private token=secret /Users/private/repo';
  const server = await startMockAppServer(() => {
    calls += 1;
    return { result: { data: [{ source: secret }], nextCursor: null } };
  }, {
    initializeResult: {
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
      userAgent: `Codex Desktop/0.148.0 ${secret}`,
    },
  });
  t.after(() => server.close());

  const result = await runNodeScript('scripts/rpc.js', ['thread/list', '--url', server.url]);
  assert.equal(result.code, 3);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'UNVERIFIED_RUNTIME');
  assert.match(error.message, /doctor\.js/);
  assert.equal(calls, 0);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(result.stdout, '');
});

test('rpc bounds JSON parameters read from stdin before connecting', async () => {
  const result = await runRpcWithStdin(
    ['thread/list', '-', '--url', 'ws://127.0.0.1:1'],
    Buffer.alloc(64 * 1024 + 1, 'x'),
  );
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stderr).code, 'USAGE_ERROR');
  assert.equal(result.stdout, '');
});

test('rpc refuses content-bearing reads for unowned threads', async (t) => {
  const fixture = registerTestLane(t, { providerId: 'owned-thread' });
  const result = await runNodeScript('scripts/rpc.js', [
    'thread/turns/list', '{"threadId":"foreign-thread"}', '--url', 'ws://127.0.0.1:1',
  ], { env: { REPO_ROOT: fixture.repoRoot, TRANSMOGRIFY_STATE_DIR: fixture.stateDir } });
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stderr).code, 'NOT_OWNED');
});

test('rpc permits content-bearing reads for an exact owned thread id', async (t) => {
  const server = await startMockAppServer((request) => {
    assert.equal(request.method, 'thread/turns/list');
    assert.equal(request.params.threadId, 'owned-thread');
    return { result: { data: [] } };
  });
  t.after(() => server.close());
  const fixture = createStateFixture(t);
  registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'owned-thread',
    displayName: '[test] owned read',
    state: 'active',
    runtime: {
      endpoint: new URL(server.url).toString(),
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
    },
  }, fixture.env);

  const result = await runNodeScript('scripts/rpc.js', [
    'thread/turns/list', '{"threadId":"owned-thread"}', '--url', server.url,
  ], { env: { REPO_ROOT: fixture.repoRoot, TRANSMOGRIFY_STATE_DIR: fixture.stateDir } });
  assert.equal(result.code, 0, result.stderr);
});
