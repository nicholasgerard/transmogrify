'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { runtimeUrl } = require('../scripts/lib/codex-runtime');
const { writeRelayRecord } = require('../scripts/lib/relay');
const { discoverCodexWake, deliverWake } = require('../scripts/lib/wake');
const { resolveRuntimeTarget } = require('../scripts/lib/desktop-attach');
const { createStateFixture } = require('./helpers/state-fixture');
const { mockCodexClient } = require('./helpers/measured-codex');

// CLI modules run unchanged in a process-boundary harness. The endpoint
// selector and relay reader are real; only the process census and connection
// boundary are faked. No sockets or shared state are accessed.
async function cliEndpoint(file, args, env) {
  const filename = path.resolve(__dirname, '..', 'scripts', file);
  const realRequire = createRequire(filename);
  const connections = [];
  const selections = [];
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name === './lib/codex-runtime') return {
      ...realRequire(name), runtimeUrl: (options, selectedEnv = env) => {
        const selected = runtimeUrl(options, selectedEnv, { processMatches: () => true });
        selections.push(selected);
        return selected;
      },
    };
    if (name === './lib/state') return {
      ...realRequire(name), activeLanes: (repo, backend) => realRequire(name).activeLanes(repo, backend, env),
    };
    if (name === './lib/app-server') return {
      ...realRequire(name), AppServerClient: class extends EventEmitter {
        constructor(config) { super(); this.verifiedRuntime = true; connections.push(config.url); }
        async connect() { throw Object.assign(new Error('end of connection-boundary test'), { code: 'TRANSPORT_ERROR' }); }
        close() {}
      },
    };
    return realRequire(name);
  };
  localRequire.main = null;
  try { vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: localRequire, module, exports: module.exports, __dirname: path.dirname(filename), __filename: filename,
    process: { argv: ['node', filename, ...args], env, on() {}, exit(code) { throw Object.assign(new Error(`process exit ${code}`), { processExit: code }); } },
    console: { log() {}, error() {} }, Buffer, URL,
    setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval() {}, clearInterval() {},
  }, { filename }); } catch (error) { if (error.processExit !== 0) throw error; }
  await new Promise((resolve) => setImmediate(resolve));
  if (file === 'maintain.js') return module.exports.parseMaintainArgs(args, env).url;
  if (file === 'lane-status-listen.js') return new URL(selections.at(-1)).href;
  assert.equal(connections.length, 1, file);
  return connections[0];
}

function relayFixture(t) {
  const fixture = createStateFixture(t);
  const record = writeRelayRecord({ version: 1, host: '127.0.0.1', port: 19001,
    url: 'ws://127.0.0.1:19001/', pid: 321, processBirth: 'birth',
    socketPath: path.join(fixture.root, 'mock-daemon.sock'), startedAt: '2026-09-05T00:00:00Z', origin: 'launched' }, fixture.env);
  return { ...fixture, record };
}

for (const scenario of ['relay only', 'relay and environment', 'neither']) {
  test(`endpoint selecting modules share runtimeUrl precedence: ${scenario}`, async (t) => {
    const fixture = scenario === 'neither' ? createStateFixture(t) : relayFixture(t);
    const env = { ...fixture.env };
    delete env.TRANSMOGRIFY_URL;
    delete env.TRANSMOGRIFY_PORT;
    if (scenario === 'relay and environment') env.TRANSMOGRIFY_URL = 'ws://127.0.0.1:19002';
    const expected = scenario === 'relay only' ? fixture.record.url : scenario === 'neither'
      ? new URL(runtimeUrl({}, env)).href : new URL(env.TRANSMOGRIFY_URL).href;
    const deps = { processMatches: () => true };
    assert.equal(new URL(runtimeUrl({}, env, deps)).href, expected);
    assert.equal(resolveRuntimeTarget({}, env, deps).url, expected);
    assert.equal(resolveRuntimeTarget({ url: 'ws://127.0.0.1:19003' }, env, deps).url, 'ws://127.0.0.1:19003/');
    for (const [file, args] of [
      ['runtime-probe.js', []], ['rpc.js', ['model/list']],
      ['lane-status-listen.js', ['--all', '--repo-root', fixture.repoRoot]],
      ['maintain.js', ['--repo-root', fixture.repoRoot, '--target', 'codex']],
    ]) assert.equal(await cliEndpoint(file, args, env), expected, file);
    let selected;
    const discovered = await discoverCodexWake({ repoRoot: fixture.repoRoot, threadIdHint: 'thread_parent001',
      runtimeUrlDependencies: deps,
      clientFactory(config) {
        selected = config.url;
        return mockCodexClient((request) => request.method === 'thread/read'
          ? { result: { thread: { id: 'thread_parent001', cwd: fixture.repoRoot } } }
          : { result: { data: [{ type: 'commandExecution', command: 'parent-init' }] } });
      },
    }, env);
    assert.equal(selected, expected);
    assert.equal(discovered.channel, 'codex-thread');
    assert.equal(discovered.runtime.url, expected);
  });
}

test('wake discovery on a relay-only machine finds the daemon; delivery uses its recorded identity', async (t) => {
  const { env, repoRoot, record } = relayFixture(t);
  delete env.TRANSMOGRIFY_URL;
  const provider = (request) => {
    if (request.method === 'thread/read') return { result: { thread: { id: 'thread_parent001', cwd: repoRoot } } };
    if (request.method === 'thread/items/list') return { result: { data: [{ type: 'commandExecution', command: 'parent-init' }] } };
    if (request.method === 'thread/turns/list') return { result: { data: [] } };
    if (request.method === 'turn/start') return { result: {} };
    return null;
  };
  const discovered = await discoverCodexWake({ repoRoot, threadIdHint: 'thread_parent001',
    runtimeUrlDependencies: { processMatches: () => true }, clientFactory: () => mockCodexClient(provider) }, env);
  assert.equal(discovered.runtime.url, record.url);
  let selected;
  const delivered = await deliverWake(discovered, 'wake', { url: 'ws://127.0.0.1:19004',
    clientFactory(config) { selected = config.url; return mockCodexClient(provider); } },
  { ...env, TRANSMOGRIFY_URL: 'ws://127.0.0.1:19005' });
  assert.equal(delivered.delivered, true);
  assert.equal(selected, record.url);
  const changed = mockCodexClient(provider, { userAgent: 'codex_cli_rs/0.154.0' });
  await assert.rejects(deliverWake(discovered, 'wake', { clientFactory: () => changed }, env),
    (error) => error.code === 'WAKE_UNDELIVERED' && /identity changed/.test(error.message));
  assert.deepEqual(changed.calls, []);
  for (const invalid of ['error', 'malformed']) {
    const failedRead = mockCodexClient((request) => {
      if (request.method !== 'thread/turns/list') return provider(request);
      if (invalid === 'error') throw Object.assign(new Error('unavailable'), { code: 'TRANSPORT_ERROR' });
      return { result: { data: [{ id: 'turn', status: 'unrecognized' }] } };
    });
    await assert.rejects(deliverWake(discovered, 'wake', { clientFactory: () => failedRead }, env));
    assert.equal(failedRead.calls.some((request) => ['turn/start', 'turn/steer'].includes(request.method)), false,
      'an unsuccessful turn read never becomes permission to start a turn');
  }
  const legacy = { ...discovered }; delete legacy.runtime;
  await assert.rejects(deliverWake(legacy, 'wake', { clientFactory() { throw new Error('must not connect'); } }, env),
    (error) => error.code === 'WAKE_UNDELIVERED');
});

test('no raw legacy default remains in endpoint-selecting JavaScript outside codex-runtime', () => {
  for (const file of ['lib/wake.js', 'watch.js', 'rpc.js', 'maintain.js', 'lane-status-listen.js', 'runtime-probe.js', 'lib/desktop-attach.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'scripts', file), 'utf8'), /8843/, file);
  }
});
