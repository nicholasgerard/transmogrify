'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { once } = require('node:events');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  daemonVersion,
  ensureManagedDaemon,
  ensurePreferredRuntime,
  ensureRuntime,
  normalizeListenUrl,
  openRuntimeLog,
  parseLsofListeners,
  sanitizedRuntimeEnv,
  spawnRuntime,
  terminateOwnedProcess,
} = require('../scripts/runtime-launch');
const { runtimeUrl } = require('../scripts/lib/codex-runtime');
const { processBirth } = require('../scripts/lib/state');
const { REPO_ROOT } = require('./helpers/run-cli');

const URL = 'ws://127.0.0.1:49123/';
const OWNED = { pid: 41001, processBirth: 'owned-birth' };

function listener(pid, name = '127.0.0.1:49123') {
  return [{ pid, command: 'codex', names: [name] }];
}

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

function runRuntimeUpArgs(args, env = process.env) {
  return new Promise((resolve, reject) => {
    execFile('bash', [path.join(REPO_ROOT, 'scripts', 'runtime-up.sh'), ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024,
      timeout: 15_000,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ code: error?.code || 0, stdout, stderr });
    });
  });
}

function runRuntimeUp(url, env) {
  return runRuntimeUpArgs(['--url', url], env);
}

test('runtime launcher shell exposes successful help', async () => {
  const result = await runRuntimeUpArgs(['--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--url/);
});

test('runtime launcher shares Node URL validation and accepts a root trailing slash', () => {
  assert.deepEqual(normalizeListenUrl(URL), {
    clientUrl: URL,
    listenUrl: 'ws://127.0.0.1:49123',
    port: 49123,
  });
  assert.throws(
    () => normalizeListenUrl('ws://127.0.0.1:49123/path'),
    /credentials, paths, queries, and fragments/,
  );
  assert.throws(() => normalizeListenUrl('wss://127.0.0.1:49123'), /literal loopback address/);
  assert.throws(() => normalizeListenUrl('ws://localhost:49123'), /non-loopback/);
  assert.throws(() => normalizeListenUrl('ws://example.com:49123'), /non-loopback/);
});

test('lsof parsing accepts only explicit IPv4 or IPv6 loopback listeners', () => {
  assert.deepEqual(parseLsofListeners('p41\ncnode\nn127.0.0.1:49123\n', 49123), [{
    pid: 41,
    command: 'node',
    names: ['127.0.0.1:49123'],
  }]);
  assert.deepEqual(parseLsofListeners('p42\ncnode\nn[::1]:49123\n', 49123)[0].pid, 42);
  assert.throws(
    () => parseLsofListeners('p43\ncnode\nn*:49123\n', 49123),
    /wildcard or non-loopback/,
  );
  assert.throws(
    () => parseLsofListeners('p44\ncnode\nn0.0.0.0:49123\n', 49123),
    /wildcard or non-loopback/,
  );
});

test('verified loopback listener is reused without spawning a process', async () => {
  let spawned = false;
  const result = await ensureRuntime({ url: URL, probe: '/tmp/probe' }, {
    inspectListeners: async () => listener(40001),
    probeRuntime: async () => true,
    spawnRuntime: async () => {
      spawned = true;
      return OWNED;
    },
  });
  assert.equal(result.state, 'reused');
  assert.deepEqual(result.pids, [40001]);
  assert.equal(spawned, false);
});

test('managed daemon version accepts the supported semantic version only', () => {
  assert.equal(daemonVersion({ code: 0, stdout: '{"appServerVersion":"0.151.0"}\n', stderr: '' }), '0.151.0');
  assert.equal(daemonVersion({ code: 0, stdout: '{"appServerVersion":"0.153.2","managedCodexVersion":"0.160.0"}\n', stderr: '' }), '0.153.2');
  assert.equal(daemonVersion({ code: 0, stdout: '{"appServerVersion":"0.150.9"}\n', stderr: '' }), null);
  assert.equal(daemonVersion({ code: 0, stdout: '{"managedCodexVersion":"0.153.2"}\n', stderr: '' }), null);
  assert.equal(daemonVersion({ code: 1, stdout: '{"appServerVersion":"0.153.2"}\n', stderr: '' }), null);
});

test('existing managed daemon is probed and never started', async () => {
  const commands = [];
  const result = await ensureManagedDaemon({
    probe: '/tmp/probe',
    managedPaths: {
      bin: '/managed/current/codex',
      socketPath: '/tmp/codex-daemon.sock',
    },
  }, {
    existsSync: () => true,
    realpathSync: (value) => value,
    accessSync: () => {},
    commandResult: async (binary, args) => {
      commands.push({ binary, args });
      return { code: 0, stdout: '{"appServerVersion":"0.153.0"}\n', stderr: '' };
    },
    probeRuntime: async (url) => url === 'ws+unix:/tmp/codex-daemon.sock',
  });
  assert.equal(result.available, true);
  assert.equal(result.state, 'reused');
  assert.deepEqual(commands.map((entry) => entry.args), [['app-server', 'daemon', 'version']]);
});

test('absent managed daemon uses only version, start, version before the probe', async () => {
  const commands = [];
  const results = [
    { code: 1, stdout: '', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '{"appServerVersion":"0.151.0"}\n', stderr: '' },
  ];
  const result = await ensureManagedDaemon({
    probe: '/tmp/probe',
    managedPaths: {
      bin: '/managed/current/codex',
      socketPath: '/tmp/codex-daemon.sock',
    },
  }, {
    existsSync: (value) => value.endsWith('/codex'),
    realpathSync: (value) => value,
    accessSync: () => {},
    commandResult: async (binary, args) => {
      commands.push({ binary, args });
      return results.shift();
    },
    probeRuntime: async () => true,
  });
  assert.equal(result.state, 'started');
  assert.deepEqual(commands.map((entry) => entry.args), [
    ['app-server', 'daemon', 'version'],
    ['app-server', 'daemon', 'start'],
    ['app-server', 'daemon', 'version'],
  ]);
  assert.equal(commands.flatMap((entry) => entry.args).includes('bootstrap'), false);
  assert.equal(commands.flatMap((entry) => entry.args).includes('stop'), false);
  assert.equal(commands.flatMap((entry) => entry.args).includes('restart'), false);
});

test('an unreachable present daemon socket is never started over', async () => {
  const commands = [];
  const result = await ensureManagedDaemon({
    probe: '/tmp/probe',
    managedPaths: {
      bin: '/managed/current/codex',
      socketPath: '/tmp/codex-daemon.sock',
    },
  }, {
    existsSync: () => true,
    realpathSync: (value) => value,
    accessSync: () => {},
    commandResult: async (binary, args) => {
      commands.push({ binary, args });
      return { code: 1, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(result, { available: false, reason: 'managed-daemon-unreachable' });
  assert.deepEqual(commands.map((entry) => entry.args), [['app-server', 'daemon', 'version']]);
});

test('preferred runtime reports the relay URL and falls back explicitly', async () => {
  const daemonResult = await ensurePreferredRuntime({ url: URL, probe: '/tmp/probe' }, {
    ensureManagedDaemon: async () => ({
      available: true,
      state: 'reused',
      version: '0.153.0',
      socketPath: '/tmp/codex-daemon.sock',
    }),
    ensureRelay: async () => ({ state: 'reused', url: 'ws://127.0.0.1:8844/' }),
  });
  assert.deepEqual(daemonResult, {
    runtime: 'managed-daemon',
    state: 'reused',
    url: 'ws://127.0.0.1:8844/',
    socket: '/tmp/codex-daemon.sock',
    daemonVersion: '0.153.0',
    relayState: 'reused',
  });

  const fallback = await ensurePreferredRuntime({ url: URL, probe: '/tmp/probe' }, {
    ensureManagedDaemon: async () => ({ available: false, reason: 'managed-install-missing' }),
    ensureStandalone: async () => ({ state: 'reused', clientUrl: URL }),
  });
  assert.deepEqual(fallback, {
    runtime: 'standalone-fallback',
    state: 'reused',
    url: URL,
    fallbackReason: 'managed-install-missing',
  });
});

test('runtime URL resolves explicit, environment, relay record, then legacy port', () => {
  const relay = () => 'ws://127.0.0.1:8844/';
  assert.equal(runtimeUrl({ url: URL }, { TRANSMOGRIFY_URL: 'ws://127.0.0.1:1' }, { activeRelayUrl: relay }), URL);
  assert.equal(runtimeUrl({}, { TRANSMOGRIFY_URL: 'ws://127.0.0.1:2' }, { activeRelayUrl: relay }), 'ws://127.0.0.1:2');
  assert.equal(runtimeUrl({}, {}, { activeRelayUrl: relay }), 'ws://127.0.0.1:8844/');
  assert.equal(runtimeUrl({}, { TRANSMOGRIFY_PORT: '9443' }, { activeRelayUrl: () => null }), 'ws://127.0.0.1:9443');
});

test('wildcard listener fails closed before probing or spawning', async () => {
  let probed = false;
  let spawned = false;
  await assert.rejects(() => ensureRuntime({ url: URL, probe: '/tmp/probe' }, {
    inspectListeners: async () => parseLsofListeners('p45\nccodex\nn*:49123\n', 49123),
    probeRuntime: async () => {
      probed = true;
      return true;
    },
    spawnRuntime: async () => {
      spawned = true;
      return OWNED;
    },
  }), /wildcard or non-loopback/);
  assert.equal(probed, false);
  assert.equal(spawned, false);
});

test('new detached runtime succeeds only when the verified listener is its exact pid', async () => {
  const observations = [[], listener(OWNED.pid)];
  let terminated = false;
  const result = await ensureRuntime({
    url: URL,
    probe: '/tmp/probe',
    bin: '/tmp/codex',
    log: '/tmp/runtime.log',
    pollMs: 0,
    attempts: 2,
  }, {
    inspectListeners: async () => observations.shift(),
    probeRuntime: async () => true,
    spawnRuntime: async () => OWNED,
    processMatches: (record) => record === OWNED,
    terminateOwnedProcess: async () => { terminated = true; },
    delay: async () => {},
  });
  assert.equal(result.state, 'launched');
  assert.equal(result.pid, OWNED.pid);
  assert.equal(terminated, false);
});

test('a verified foreign listener winning the race is never killed or misattributed', async () => {
  const FOREIGN_PID = 42002;
  const observations = [[], listener(FOREIGN_PID), listener(FOREIGN_PID)];
  const terminated = [];
  const result = await ensureRuntime({
    url: URL,
    probe: '/tmp/probe',
    bin: '/tmp/codex',
    log: '/tmp/runtime.log',
    pollMs: 0,
    attempts: 2,
  }, {
    inspectListeners: async () => observations.shift(),
    probeRuntime: async () => true,
    spawnRuntime: async () => OWNED,
    processMatches: () => true,
    terminateOwnedProcess: async (record) => { terminated.push(record); },
    delay: async () => {},
  });
  assert.equal(result.state, 'race-reused');
  assert.deepEqual(result.pids, [FOREIGN_PID]);
  assert.deepEqual(terminated, [OWNED]);
});

test('launch timeout cleans up only the pid+birth-bound child', async () => {
  const terminated = [];
  await assert.rejects(() => ensureRuntime({
    url: URL,
    probe: '/tmp/probe',
    bin: '/tmp/codex',
    log: '/tmp/runtime.log',
    pollMs: 0,
    attempts: 2,
  }, {
    inspectListeners: async () => [],
    probeRuntime: async () => false,
    spawnRuntime: async () => OWNED,
    processMatches: () => true,
    terminateOwnedProcess: async (record) => { terminated.push(record); },
    delay: async () => {},
  }), /failed to complete a verified handshake/);
  assert.deepEqual(terminated, [OWNED]);
});

test('owned-process termination refuses a changed process birth identity', async () => {
  const signals = [];
  const result = await terminateOwnedProcess(OWNED, {
    processMatches: () => false,
    kill(pid, signal) { signals.push({ pid, signal }); },
    delay: async () => {},
  });
  assert.deepEqual(result, { attempted: false, terminated: false });
  assert.deepEqual(signals, []);
});

test('owned-process termination refuses a pid-only durable receipt by default', async () => {
  const signals = [];
  const result = await terminateOwnedProcess(OWNED, {
    processMatches: () => true,
    kill(pid, signal) { signals.push({ pid, signal }); },
    delay: async () => {},
  });
  assert.deepEqual(result, { attempted: false, terminated: false });
  assert.deepEqual(signals, []);
});

test('runtime log open refuses symlinks and non-private existing files', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-runtime-log-')));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const privateLog = path.join(root, 'private.log');
  const descriptor = openRuntimeLog(privateLog);
  fs.closeSync(descriptor);
  assert.equal(fs.statSync(privateLog).mode & 0o077, 0);

  const publicLog = path.join(root, 'public.log');
  fs.writeFileSync(publicLog, 'public\n', { mode: 0o644 });
  assert.throws(() => openRuntimeLog(publicLog), /private owner-controlled/);

  const linkedLog = path.join(root, 'linked.log');
  fs.symlinkSync(publicLog, linkedLog);
  assert.throws(() => openRuntimeLog(linkedLog), /opened safely/);
  assert.equal(fs.readFileSync(publicLog, 'utf8'), 'public\n');
  assert.equal(fs.statSync(publicLog).mode & 0o077, 0o044);

  const shared = path.join(root, 'shared');
  fs.mkdirSync(shared, { mode: 0o777 });
  fs.chmodSync(shared, 0o777);
  assert.throws(() => openRuntimeLog(path.join(shared, 'runtime.log')), /directory is not owner-controlled/);

  const real = path.join(root, 'real');
  fs.mkdirSync(real, { mode: 0o700 });
  const linkedDirectory = path.join(root, 'linked-directory');
  fs.symlinkSync(real, linkedDirectory);
  assert.throws(
    () => openRuntimeLog(path.join(linkedDirectory, 'missing', 'runtime.log')),
    /must not traverse symlinks/,
  );
  assert.equal(fs.existsSync(path.join(real, 'missing')), false);
});

test('runtime child receives only the bounded Codex environment allowlist', async (t) => {
  assert.deepEqual(sanitizedRuntimeEnv({
    HOME: '/tmp/home',
    PATH: '/usr/bin:/bin',
    OPENAI_API_KEY: 'secret-key',
    AWS_SECRET_ACCESS_KEY: 'secret-cloud-key',
  }), { HOME: '/tmp/home', PATH: '/usr/bin:/bin' });

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-runtime-env-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let childOptions;
  const child = new EventEmitter();
  child.pid = 44001;
  child.exitCode = null;
  child.unref = () => {};
  const receiptPromise = spawnRuntime({
    bin: process.execPath,
    listenUrl: 'ws://127.0.0.1:49123',
    log: path.join(root, 'runtime.log'),
  }, {
    env: {
      HOME: '/tmp/home',
      PATH: '/usr/bin:/bin',
      OPENAI_API_KEY: 'secret-key',
      UNRELATED_TOKEN: 'secret-token',
    },
    processBirth: () => 'owned-birth',
    spawn(binary, args, options) {
      childOptions = { binary, args, options };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  assert.equal((await receiptPromise).processBirth, 'owned-birth');
  assert.equal(childOptions.options.env.HOME, '/tmp/home');
  assert.equal(childOptions.options.env.PATH, '/usr/bin:/bin');
  assert.equal('OPENAI_API_KEY' in childOptions.options.env, false);
  assert.equal('UNRELATED_TOKEN' in childOptions.options.env, false);
});

test('shell launcher starts and then reuses an isolated detached mock runtime', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-runtime-up-')));
  const wrapper = path.join(root, 'mock-codex');
  const helper = path.join(REPO_ROOT, 'test', 'helpers', 'mock-detached-runtime.js');
  fs.writeFileSync(wrapper, `#!${process.execPath}\nrequire(${JSON.stringify(helper)});\n`, { mode: 0o700 });
  const log = path.join(root, 'runtime.log');
  const port = await unusedPort();
  const url = `ws://127.0.0.1:${port}/`;
  const env = {
    ...process.env,
    CODEX_HOME: path.join(root, 'codex-home'),
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}`,
    TRANSMOGRIFY_STATE_DIR: path.join(root, 'state'),
    TRANSMOGRIFY_BIN: wrapper,
    TRANSMOGRIFY_LOG: log,
  };
  let owned;
  t.after(async () => {
    if (owned) await terminateOwnedProcess(owned, { allowPidOnly: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  const launched = await runRuntimeUp(url, env);
  const launchDiagnostic = [
    launched.stderr,
    launched.stdout,
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
  ].filter(Boolean).join('\n');
  assert.equal(launched.code, 0, launchDiagnostic);
  const launchedResult = JSON.parse(launched.stdout);
  assert.equal(launchedResult.runtime, 'standalone-fallback');
  const pid = Number(fs.readFileSync(log, 'utf8').match(/pid=(\d+)/)?.[1] || 0);
  // The standalone launcher no longer exposes process identity in public JSON;
  // lsof supplies the exact pid for this isolated fixture.
  const listening = await new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' },
      (error, stdout) => resolve(error ? 0 : Number(stdout.match(/p(\d+)/)?.[1])));
  });
  const ownedPid = pid || listening;
  assert.equal(Number.isInteger(ownedPid) && ownedPid > 0, true, launched.stdout);
  owned = { pid: ownedPid, processBirth: processBirth(ownedPid) };
  assert.equal(typeof owned.processBirth, 'string');

  const reused = await runRuntimeUp(url, env);
  assert.equal(reused.code, 0, reused.stderr);
  assert.equal(JSON.parse(reused.stdout).runtime, 'standalone-fallback');
  assert.equal(processBirth(ownedPid), owned.processBirth);
});
