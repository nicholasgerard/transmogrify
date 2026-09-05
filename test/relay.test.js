'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  activeRelayUrl, ensureRelay, readRelayRecord, relayPaths, sameRuntimeThroughRelay,
  stopRelay, validateHost,
  writeRelayRecord,
} = require('../scripts/lib/relay');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-relay-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    env: { TRANSMOGRIFY_STATE_DIR: root },
    socketPath: path.join(root, 'daemon.sock'),
  };
}

function record(socketPath, overrides = {}) {
  return {
    version: 1,
    origin: 'launched',
    pid: 45101,
    processBirth: 'relay-birth',
    host: '127.0.0.1',
    port: 8844,
    url: 'ws://127.0.0.1:8844/',
    socketPath,
    startedAt: '2026-09-04T12:00:00.000Z',
    ...overrides,
  };
}

test('relay refuses every non-loopback bind', () => {
  assert.equal(validateHost('127.0.0.1'), '127.0.0.1');
  assert.equal(validateHost('::1'), '::1');
  for (const host of ['0.0.0.0', 'localhost', '192.0.2.1']) {
    assert.throws(() => validateHost(host), /non-loopback/);
  }
});

test('relay record is private, exact, and supplies the active runtime URL', (t) => {
  const { env, socketPath } = fixture(t);
  writeRelayRecord(record(socketPath), env);
  assert.equal(fs.statSync(relayPaths(env).record).mode & 0o077, 0);
  assert.deepEqual(readRelayRecord(env), record(socketPath));
  assert.equal(activeRelayUrl(env, { processMatches: () => true }), 'ws://127.0.0.1:8844/');
  assert.equal(activeRelayUrl(env, { processMatches: () => false }), null);
});

test('ensure relay reuses an exact live record without spawning', async (t) => {
  const { env, socketPath } = fixture(t);
  writeRelayRecord(record(socketPath), env);
  let spawned = false;
  const result = await ensureRelay({ socketPath }, env, {
    processMatches: () => true,
    inspectListeners: async () => { throw new Error('must not inspect a reused relay'); },
    spawnDetached: () => { spawned = true; },
  });
  assert.equal(result.state, 'reused');
  assert.equal(spawned, false);
});

test('ensure relay accepts only the pid-and-birth record published by its injected child', async (t) => {
  const { env, socketPath } = fixture(t);
  const launched = [];
  const result = await ensureRelay({ socketPath, pollMs: 0, attempts: 1 }, env, {
    inspectListeners: async () => [],
    processMatches: () => true,
    spawnDetached(executable, args) {
      launched.push({ executable, args });
      writeRelayRecord(record(socketPath), env);
      return 45101;
    },
    sleep: async () => {},
  });
  assert.equal(result.state, 'started');
  assert.equal(result.pid, 45101);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].args.includes('--serve'), true);
});

test('ensure relay refuses an unowned listener before spawning', async (t) => {
  const { env, socketPath } = fixture(t);
  let spawned = false;
  await assert.rejects(() => ensureRelay({ socketPath }, env, {
    inspectListeners: async () => [{ pid: 99 }],
    sameRuntimeThroughRelay: async () => false,
    spawnDetached: () => { spawned = true; return 99; },
  }), /unowned listener/);
  assert.equal(spawned, false);
});

test('ensure relay records one existing listener only after both endpoints identify the same runtime', async (t) => {
  const { env, socketPath } = fixture(t);
  let spawned = false;
  const result = await ensureRelay({ socketPath }, env, {
    inspectListeners: async () => [{ pid: 45102 }],
    sameRuntimeThroughRelay: async (candidateSocket, url) =>
      candidateSocket === socketPath && url === 'ws://127.0.0.1:8844/',
    processBirth: () => 'observed-birth',
    spawnDetached: () => { spawned = true; return 45102; },
  });
  assert.equal(result.state, 'reused');
  assert.equal(result.origin, 'adopted');
  assert.equal(result.pid, 45102);
  assert.equal(result.processBirth, 'observed-birth');
  assert.equal(spawned, false);
  assert.equal(readRelayRecord(env).pid, 45102);
  assert.equal(activeRelayUrl(env, { processMatches: () => true }), result.url);
  let signalled = false;
  await assert.rejects(
    () => stopRelay(env, { kill() { signalled = true; } }),
    (error) => error.code === 'RELAY_NOT_OWNED',
  );
  assert.equal(signalled, false);
  assert.equal(readRelayRecord(env).origin, 'adopted');
});

test('existing relay verification compares the complete initialized runtime identity', async () => {
  const base = {
    codexHome: '/tmp/codex-home',
    platformFamily: 'unix',
    platformOs: 'macos',
    userAgent: 'codex_cli_rs/0.151.0',
  };
  const identities = [base, { ...base }];
  const dependencies = {
    clientFactory: () => ({
      verifiedRuntime: true,
      connect: async () => identities.shift(),
      close() {},
    }),
  };
  assert.equal(await sameRuntimeThroughRelay('/tmp/daemon.sock', 'ws://127.0.0.1:8844/', dependencies), true);

  identities.push(base, { ...base, codexHome: '/tmp/other-home' });
  assert.equal(await sameRuntimeThroughRelay('/tmp/daemon.sock', 'ws://127.0.0.1:8844/', dependencies), false);
});

test('stop relay signals a launched relay only after affirmative process identity', async (t) => {
  const { env, socketPath } = fixture(t);
  await ensureRelay({ socketPath, pollMs: 0, attempts: 1 }, env, {
    inspectListeners: async () => [],
    processMatches: () => true,
    spawnDetached() {
      writeRelayRecord(record(socketPath), env);
      return 45101;
    },
    sleep: async () => {},
  });
  const signals = [];
  let live = true;
  const result = await stopRelay(env, {
    processIdentity: () => 'same',
    processMatches: () => live,
    kill(pid, signal) { signals.push({ pid, signal }); live = false; },
    sleep: async () => {},
  });
  assert.deepEqual(result, { stopped: true, pid: 45101 });
  assert.deepEqual(signals, [{ pid: 45101, signal: 'SIGTERM' }]);
  assert.equal(fs.existsSync(relayPaths(env).record), false);
});

test('stop relay refuses unknown or different launched identities without signalling', async (t) => {
  const { env, socketPath } = fixture(t);
  for (const identity of ['unknown', 'different']) {
    writeRelayRecord(record(socketPath), env);
    let signalled = false;
    await assert.rejects(
      () => stopRelay(env, {
        processIdentity: () => identity,
        kill() { signalled = true; },
      }),
      (error) => error.code === 'RELAY_IDENTITY_UNVERIFIED',
    );
    assert.equal(signalled, false);
    assert.equal(fs.existsSync(relayPaths(env).record), true);
  }
});

test('a relay record without an origin is compatibility evidence, not stop ownership', async (t) => {
  const { env, socketPath } = fixture(t);
  const legacy = record(socketPath);
  delete legacy.origin;
  writeRelayRecord(legacy, env);
  let signalled = false;
  await assert.rejects(
    () => stopRelay(env, { kill() { signalled = true; } }),
    (error) => error.code === 'RELAY_NOT_OWNED',
  );
  assert.equal(signalled, false);
  assert.equal(fs.existsSync(relayPaths(env).record), true);
});
