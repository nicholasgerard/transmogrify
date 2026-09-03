'use strict';

// The observer caches keep one runtime measurement and one census per round
// without changing what a read verifies: the runtime memo follows the CLI
// file, the census memo lives for one round, and a shared client answers a
// second connect from its first handshake until the round ends.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SharedAppServerClient, cachedClaudeSurface, createObserverCache, roundClientFactory,
} = require('../scripts/lib/observer-cache');

function fakeSurface(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cliPath = path.join(dir, 'claude');
  fs.writeFileSync(cliPath, 'v1');
  const calls = { preflight: 0, agents: 0 };
  return {
    cliPath,
    calls,
    base: {
      preflight() { calls.preflight += 1; return { cliPath, cliSha256: 'a'.repeat(64), measured: calls.preflight }; },
      async agents(runtime) { calls.agents += 1; return [{ id: 'job', pid: 1, runtime: runtime.measured, census: calls.agents }]; },
      other() { return 'delegated'; },
    },
  };
}

test('the runtime measurement is reused until the CLI file changes or the memo ages out', async (t) => {
  const { base, calls, cliPath } = fakeSurface(t);
  let now = 1_000_000;
  const surface = cachedClaudeSurface(base, { now: () => now, runtimeMemoTtlMs: 60_000 });
  const first = surface.preflight({}, { HOME: '/h' });
  const second = surface.preflight({}, { HOME: '/h' });
  assert.equal(first, second, 'same runtime object within the memo');
  assert.equal(calls.preflight, 1);
  assert.equal(surface.preflight({ claudeBin: '/other' }, { HOME: '/h' }).measured, 2, 'a different CLI selection is measured separately');
  assert.equal(surface.preflight({}, { HOME: '/h2' }).measured, 3, 'a different environment identity is measured separately');

  fs.writeFileSync(cliPath, 'v2-changed');
  assert.equal(surface.preflight({}, { HOME: '/h' }).measured, 4, 'a changed CLI file is measured again');
  now += 61_000;
  assert.equal(surface.preflight({}, { HOME: '/h' }).measured, 5, 'an aged memo is measured again');
  assert.equal(surface.other(), 'delegated');
  assert.deepEqual(surface.stats, { preflights: 5, censuses: 0 });
});

test('the census is shared within a round and re-read after beginRound', async (t) => {
  const { base, calls } = fakeSurface(t);
  const surface = cachedClaudeSurface(base);
  const runtime = surface.preflight({}, { HOME: '/h' });
  const a = await surface.agents(runtime, { timeoutMs: 1000 });
  const b = await surface.agents(runtime, { timeoutMs: 1000 });
  assert.equal(calls.agents, 1);
  assert.deepEqual(a, b);
  assert.notEqual(a[0], b[0], 'rows are copied so a caller cannot mutate the memo');
  surface.beginRound();
  await surface.agents(runtime, { timeoutMs: 1000 });
  assert.equal(calls.agents, 2);
  const otherRuntime = { cliPath: runtime.cliPath, measured: 99 };
  await surface.agents(otherRuntime, { timeoutMs: 1000 });
  assert.equal(calls.agents, 3, 'a census belongs to the runtime it was read with');
});

class FakeClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.connects = 0;
    this.closes = 0;
    this.verifiedRuntime = true;
    this.runtimeIdentity = { endpoint: config.url };
  }

  async connect() { this.connects += 1; return { userAgent: 'codex_cli_rs/0.151.0' }; }
  async call(method) { return { method }; }
  close() { this.closes += 1; this.emit('connection/closed'); }
}

test('a shared client connects once per round and closes only when the round ends', async () => {
  const created = [];
  const factory = roundClientFactory((config) => { const client = new FakeClient(config); created.push(client); return client; });
  const shared = factory({ url: 'ws://127.0.0.1:1/' });
  assert.equal(factory({ url: 'ws://127.0.0.1:1/' }), shared, 'one shared client per endpoint');
  assert.notEqual(factory({ url: 'ws://127.0.0.1:2/' }), shared);
  assert.ok(shared instanceof SharedAppServerClient);

  const first = await shared.connect();
  const second = await shared.connect();
  assert.deepEqual(first, second);
  assert.equal(created[0].connects, 1);
  assert.deepEqual(await shared.call('thread/read'), { method: 'thread/read' });
  assert.equal(shared.verifiedRuntime, true);
  assert.deepEqual(shared.runtimeIdentity, { endpoint: 'ws://127.0.0.1:1/' });
  shared.close();
  assert.equal(created[0].closes, 0, 'an adapter close is ignored within the round');
  factory.endRound();
  assert.equal(created[0].closes, 1);

  // A dropped connection is replaced on the next connect.
  const again = factory({ url: 'ws://127.0.0.1:1/' });
  await again.connect();
  assert.equal(created.length, 2, 'the endpoint 1 client was recreated after the round (endpoint 2 never connected)');
  created[1].close();
  await again.connect();
  assert.equal(created.length, 3, 'a client that closed underneath is replaced');
  factory.endRound();
});

test('createObserverCache hands out the surface and factory with round boundaries', async (t) => {
  const { base, calls } = fakeSurface(t);
  const cache = createObserverCache({ claudeSurface: base, createClient: (config) => new FakeClient(config) });
  const runtime = cache.surface.preflight({}, { HOME: '/h' });
  await cache.surface.agents(runtime, {});
  await cache.surface.agents(runtime, {});
  assert.equal(calls.agents, 1);
  cache.beginRound();
  await cache.surface.agents(runtime, {});
  assert.equal(calls.agents, 2);
  const client = cache.clientFactory({ url: 'ws://127.0.0.1:1/' });
  await client.connect();
  cache.endRound();
  assert.equal(client.inner, null, 'endRound closed the shared client');
  cache.forget();
  cache.surface.preflight({}, { HOME: '/h' });
  assert.equal(calls.preflight, 2, 'forget drops the runtime memo');
});
