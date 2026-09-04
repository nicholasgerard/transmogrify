'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AppServerClient } = require('../scripts/lib/app-server');
const {
  NIL_ID,
  measureCodexCompatibility,
  runtimeCompatibilityFile,
} = require('../scripts/lib/codex-compat');
const { startMockAppServer } = require('./helpers/mock-app-server');

function privateState(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-codex-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { TRANSMOGRIFY_STATE_DIR: path.join(root, 'state') };
}

async function connectedClient(server) {
  const client = new AppServerClient({ url: server.url, timeoutMs: 3000 });
  await client.connect();
  return client;
}

test('Codex compatibility probes the required method shapes once per runtime version', async (t) => {
  const env = privateState(t);
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/list' || request.method === 'thread/turns/list') {
      return { result: { data: [], nextCursor: null } };
    }
    return { error: { code: -32600, message: 'thread not found' } };
  });
  t.after(() => server.close());
  const client = await connectedClient(server);
  t.after(() => client.close());

  const record = await measureCodexCompatibility(client, '0.153.0', { env, timeoutMs: 3000 });
  assert.equal(record.result, 'good');
  assert.deepEqual(record.probes.map((probe) => probe.method), [
    'thread/list', 'thread/turns/list', 'turn/steer', 'thread/name/set', 'thread/archive',
  ]);
  const methodRequests = server.requests.filter((request) => request.id !== undefined && request.method !== 'initialize');
  assert.equal(methodRequests.length, 5);
  for (const request of methodRequests.filter((entry) => entry.method !== 'thread/list')) {
    assert.equal(request.params.threadId, NIL_ID);
  }
  const file = runtimeCompatibilityFile('0.153.0', env);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const before = server.requests.length;
  const cached = await measureCodexCompatibility(client, '0.153.0', { env, timeoutMs: 3000 });
  assert.equal(cached.result, 'good');
  assert.equal(server.requests.length, before, 'the cached version sends no method probe');
});

test('Codex compatibility caches and names the first rejected method', async (t) => {
  const env = privateState(t);
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/list') return { result: { data: [] } };
    return { error: { code: -32602, message: 'invalid params' } };
  });
  t.after(() => server.close());
  const client = await connectedClient(server);
  t.after(() => client.close());

  const failed = await measureCodexCompatibility(client, '0.154.0', { env, timeoutMs: 3000 });
  assert.equal(failed.result, 'failed');
  assert.equal(failed.failingMethod, 'thread/turns/list');
  assert.deepEqual(failed.probes, [
    { method: 'thread/list', ok: true },
    { method: 'thread/turns/list', ok: false },
  ]);
  const before = server.requests.length;
  assert.equal((await measureCodexCompatibility(client, '0.154.0', { env })).failingMethod,
    'thread/turns/list');
  assert.equal(server.requests.length, before);
});

test('Codex compatibility rejects a below-minimum version without lifecycle requests', async (t) => {
  const env = privateState(t);
  const calls = [];
  const record = await measureCodexCompatibility({
    call(method) { calls.push(method); throw new Error('must not call'); },
  }, '0.150.9', { env });
  assert.equal(record.result, 'failed');
  assert.equal(record.failingMethod, 'minimum-version');
  assert.deepEqual(calls, []);
});
