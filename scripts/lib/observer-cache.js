'use strict';

// Round-scoped caches for a long-running observer (the watcher, and one
// `wait` command across its rounds). Observation reads a child through the
// same adapter code a command uses; a command measures the Claude runtime
// (two digests of the CLI plus two CLI calls) and lists the census once,
// which is right for one command and wasteful every few seconds per child.
// This module keeps those measurements across a round without changing what
// they verify: the runtime memo is dropped when the CLI file changes or ages
// out, the census memo lives for one round only, and mutations never use
// either (they build their own surface).

const fs = require('node:fs');
const { AppServerClient } = require('./app-server');
const { createClaudeSurface } = require('./claude-surface');

const RUNTIME_MEMO_TTL_MS = 10 * 60 * 1000;

function fileStamp(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

function runtimeKey(options, env) {
  return JSON.stringify({
    claudeBin: options?.claudeBin ?? null,
    CLAUDE_BIN: env.CLAUDE_BIN ?? null,
    CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR ?? null,
    HOME: env.HOME ?? null,
  });
}

// A Claude surface whose preflight is memoized per CLI file and whose census
// is memoized within a round. Everything else delegates to the base surface.
function cachedClaudeSurface(base = createClaudeSurface(), options = {}) {
  const ttlMs = options.runtimeMemoTtlMs ?? RUNTIME_MEMO_TTL_MS;
  const now = options.now || Date.now;
  const runtimes = new Map();
  let census = null;
  const surface = {
    ...base,
    stats: { preflights: 0, censuses: 0 },
    preflight(preflightOptions = {}, env = process.env) {
      const key = runtimeKey(preflightOptions, env);
      const memo = runtimes.get(key);
      if (memo && now() - memo.at <= ttlMs && fileStamp(memo.runtime.cliPath) === memo.stamp) {
        return memo.runtime;
      }
      const runtime = base.preflight(preflightOptions, env);
      surface.stats.preflights += 1;
      runtimes.set(key, { runtime, at: now(), stamp: fileStamp(runtime.cliPath) });
      return runtime;
    },
    async agents(runtime, agentOptions = {}) {
      if (census && census.runtime === runtime) return census.rows.map((row) => ({ ...row }));
      const rows = await base.agents(runtime, agentOptions);
      surface.stats.censuses += 1;
      census = { runtime, rows };
      return rows.map((row) => ({ ...row }));
    },
    beginRound() { census = null; },
    forget() { runtimes.clear(); census = null; },
  };
  return surface;
}

// One connected app-server client shared by every Codex read of a round. The
// adapter connects and closes a client per call; the shared client answers a
// second connect from its first handshake and ignores close until the round
// ends. A client that dropped is replaced on the next connect.
class SharedAppServerClient {
  constructor(config, createClient) {
    this.config = config;
    this.createClient = createClient;
    this.inner = null;
    this.initialized = null;
    this.connecting = null;
  }

  async connect() {
    if (this.inner && !this.inner.closed) return this.initialized;
    if (this.connecting) return this.connecting;
    const inner = this.createClient(this.config);
    inner.closed = false;
    inner.once('connection/closed', () => { inner.closed = true; });
    this.connecting = inner.connect().then((initialized) => {
      this.inner = inner;
      this.initialized = initialized;
      this.connecting = null;
      return initialized;
    }, (error) => {
      this.connecting = null;
      throw error;
    });
    return this.connecting;
  }

  get runtimeIdentity() { return this.inner?.runtimeIdentity; }
  get verifiedRuntime() { return this.inner?.verifiedRuntime; }
  get userAgent() { return this.inner?.userAgent; }
  call(method, params, timeoutMs) { return this.inner.call(method, params, timeoutMs); }
  notify(method, params) { return this.inner.notify(method, params); }
  waitForNotification(method, predicate, timeoutMs) { return this.inner.waitForNotification(method, predicate, timeoutMs); }
  on(event, listener) { this.inner.on(event, listener); return this; }
  once(event, listener) { this.inner.once(event, listener); return this; }
  off(event, listener) { this.inner?.off(event, listener); return this; }
  close() { /* the round owner closes the real connection */ }
  end() {
    const inner = this.inner;
    this.inner = null;
    this.initialized = null;
    if (inner) { try { inner.close(); } catch { /* already closed */ } }
  }
}

// A client factory for the adapters that hands out one shared client per
// endpoint until endRound() closes them.
function roundClientFactory(createClient = (config) => new AppServerClient(config)) {
  const shared = new Map();
  const factory = (config) => {
    const key = config.url;
    if (!shared.has(key)) shared.set(key, new SharedAppServerClient(config, createClient));
    return shared.get(key);
  };
  factory.endRound = () => {
    for (const client of shared.values()) client.end();
    shared.clear();
  };
  return factory;
}

// The pair an observer passes through observation values (`surface`,
// `clientFactory`), with the round boundaries it must call.
function createObserverCache(options = {}) {
  const surface = cachedClaudeSurface(options.claudeSurface, options);
  const clientFactory = roundClientFactory(options.createClient);
  return {
    surface,
    clientFactory,
    beginRound() { surface.beginRound(); },
    endRound() { clientFactory.endRound(); },
    forget() { surface.forget(); clientFactory.endRound(); },
  };
}

module.exports = {
  RUNTIME_MEMO_TTL_MS,
  SharedAppServerClient,
  cachedClaudeSurface,
  createObserverCache,
  roundClientFactory,
};
