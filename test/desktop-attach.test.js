'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFile } = require('node:child_process');
const {
  DesktopAttachError,
  TESTED_DESKTOP_BUILDS,
  applyPersisted,
  check,
  clientConnections,
  ensure,
  parseEstablishedConnections,
  persist,
  persistenceReceiptPath,
  resolveRuntimeUrl,
  launchAgentContents,
  stableNodePath,
  unpersist,
} = require('../scripts/lib/desktop-attach');
const { cliFailure, main, parseCli } = require('../scripts/desktop-attach');

const { scenario, APP, DESKTOP_PID, SELF_PID } = require('./helpers/desktop-attachment-fixture');

const ENV = { TRANSMOGRIFY_PORT: '8843' };

test('runtime selection is option, environment, live relay, then legacy endpoint', () => {
  const liveRelay = () => ({
    url: 'ws://127.0.0.1:8844/', socketPath: '/private/tmp/codex-daemon.sock',
  });
  assert.equal(resolveRuntimeUrl({ url: 'ws://127.0.0.1:9001' }, {
    TRANSMOGRIFY_URL: 'ws://127.0.0.1:9002',
  }, { runningRelay: liveRelay }), 'ws://127.0.0.1:9001/');
  assert.equal(resolveRuntimeUrl({}, { TRANSMOGRIFY_URL: 'ws://127.0.0.1:9002' }, {
    runningRelay: liveRelay,
  }), 'ws://127.0.0.1:9002/');
  assert.equal(resolveRuntimeUrl({}, {}, { runningRelay: liveRelay }), 'ws://127.0.0.1:8844/');
  assert.equal(resolveRuntimeUrl({}, {}, { runningRelay: () => null }), 'ws://127.0.0.1:8843/');
});

test('check reports an attached Desktop with a tested build and no host-session risk', async () => {
  const { dependencies } = scenario({ attached: true });
  const receipt = await check({}, ENV, dependencies);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.runtimeUrl, 'ws://127.0.0.1:8843/');
  assert.equal(receipt.persisted, false);
  assert.deepEqual(receipt.attachment, {
    state: 'attached',
    evidence: 'lsof-established-loopback-connection',
    clientPid: DESKTOP_PID,
    connection: '127.0.0.1:53519->127.0.0.1:8843',
    observedAt: '2026-09-02T22:00:00.000Z',
  });
  assert.equal(receipt.desktop.bundleId, 'com.openai.codex');
  assert.equal(receipt.desktop.version, '26.901.20858');
  assert.equal(receipt.desktop.build, '7658');
  assert.equal(receipt.desktop.buildTested, true);
  assert.equal(receipt.desktop.hostedByDesktop, false);
  assert.deepEqual(receipt.desktop.pids, [DESKTOP_PID]);
  assert.equal(receipt.nextAction, 'none');
  assert.ok(TESTED_DESKTOP_BUILDS.some((build) => build.version === '26.901.20858'));
});

test('check selects a live relay record and receipts its daemon socket', async () => {
  const relayRecord = {
    url: 'ws://127.0.0.1:8844/',
    socketPath: '/private/tmp/codex-daemon.sock',
  };
  const { dependencies } = scenario({
    attached: true,
    runtimePort: 8844,
    relayRecord,
    hostedByDesktop: true,
    persistedUrl: 'ws://127.0.0.1:8844/',
    plistExists: true,
  });
  const receipt = await check({}, {}, dependencies);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.runtimeUrl, relayRecord.url);
  assert.equal(receipt.runtimeSource, 'liveRelay');
  assert.equal(receipt.persisted, true);
  assert.equal(receipt.desktop.hostedByDesktop, true);
  assert.deepEqual(receipt.attachment.relay, relayRecord);
});

test('check reports persistence false unless both login environment and plist match', async () => {
  const relayRecord = {
    url: 'ws://127.0.0.1:8844/',
    socketPath: '/private/tmp/codex-daemon.sock',
  };
  const wrongUrl = await check({}, {}, scenario({
    attached: true, runtimePort: 8844, relayRecord,
    persistedUrl: 'ws://127.0.0.1:8843', plistExists: true,
  }).dependencies);
  assert.equal(wrongUrl.persisted, false);
  const noPlist = await check({}, {}, scenario({
    attached: true, runtimePort: 8844, relayRecord,
    persistedUrl: 'ws://127.0.0.1:8844/', plistExists: false,
  }).dependencies);
  assert.equal(noPlist.persisted, false);
});

test('check distinguishes unattached, not running, and not installed', async () => {
  const unattached = await check({}, ENV, scenario().dependencies);
  assert.equal(unattached.ok, false);
  assert.equal(unattached.attachment.state, 'unattached');
  assert.equal(unattached.nextAction, 'run-desktop-attach-ensure');

  const notRunning = await check({}, ENV, scenario({ running: false }).dependencies);
  assert.equal(notRunning.attachment.state, 'notRunning');
  assert.equal(notRunning.desktop.running, false);

  const notInstalled = await check({}, ENV, scenario({ installed: false }).dependencies);
  assert.equal(notInstalled.attachment.state, 'notInstalled');
  assert.deepEqual(notInstalled.desktop, { installed: false });
});

test('check verifies the standard app path when LaunchServices lookup is sandboxed', async () => {
  const receipt = await check({}, ENV, scenario({
    launchServices: false,
    diskInstalled: true,
    attached: true,
  }).dependencies);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.desktop.appPath, APP);
  assert.equal(receipt.desktop.version, '26.901.22334');
  assert.equal(receipt.desktop.buildTested, true);
});

test('check honours the disable switch and non-macOS hosts without probing', async () => {
  const { calls, dependencies } = scenario();
  const disabled = await check({}, { ...ENV, TRANSMOGRIFY_DESKTOP_ATTACH: 'off' }, dependencies);
  assert.equal(disabled.attachment.state, 'disabled');
  assert.equal(disabled.nextAction, 'use-allow-protocol-only');
  const linux = await check({}, ENV, { ...dependencies, platform: 'linux' });
  assert.equal(linux.attachment.state, 'unsupportedPlatform');
  assert.equal(calls.length, 0);
});

test('check reports missing system tools instead of guessing', async () => {
  const receipt = await check({}, ENV, {
    ...scenario().dependencies,
    execFileResult: async () => ({ code: null, failure: 'missing', stdout: '', stderr: '' }),
  });
  assert.equal(receipt.attachment.state, 'toolUnavailable');
  assert.equal(receipt.attachment.tool, 'osascript');
  await assert.rejects(
    () => ensure({}, ENV, {
      ...scenario().dependencies,
      execFileResult: async () => ({ code: null, failure: 'missing', stdout: '', stderr: '' }),
    }),
    (error) => error instanceof DesktopAttachError && error.code === 'TOOL_UNAVAILABLE',
  );
});

test('check detects a Desktop attached to another loopback Codex listener', async () => {
  const receipt = await check({}, ENV, scenario({ elsewherePort: 9911 }).dependencies);
  assert.equal(receipt.attachment.state, 'attachedElsewhere');
  assert.deepEqual(receipt.attachment.elsewhere, [{ url: 'ws://127.0.0.1:9911', listenerPid: 777 }]);
  assert.equal(receipt.nextAction, 'reuse-attached-runtime:ws://127.0.0.1:9911');
  await assert.rejects(
    () => ensure({ relaunch: true }, ENV, scenario({ elsewherePort: 9911 }).dependencies),
    (error) => error.code === 'ATTACHED_ELSEWHERE' &&
      error.details.suggestedRuntimeUrl === 'ws://127.0.0.1:9911',
  );
});

test('ensure reuses an existing attachment without touching the app', async () => {
  const { state, calls, dependencies } = scenario({ attached: true });
  const result = await ensure({}, ENV, dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'reused');
  assert.equal(result.relaunchAuthorization, 'none');
  assert.equal(result.receipt.attachment.state, 'attached');
  assert.deepEqual(state.launches, []);
  assert.ok(!calls.some(([executable]) => executable === 'open'));
  assert.ok(!calls.some(([executable, , script]) => executable === 'osascript' && /quit/.test(script)));
});

test('ensure launches Desktop attached when it is not running', async () => {
  const { state, calls, dependencies } = scenario({ running: false });
  const result = await ensure({}, ENV, dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'launched');
  assert.deepEqual(state.launches, [[
    '-b', 'com.openai.codex', '--env', 'CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:8843',
  ]]);
  assert.ok(!calls.some(([executable, , script]) => executable === 'osascript' && /quit/.test(script)));
  assert.equal(result.receipt.attachment.clientPid, DESKTOP_PID);
});

test('ensure refuses to relaunch a running unattached Desktop without authorization', async () => {
  const { state, dependencies } = scenario();
  await assert.rejects(
    () => ensure({}, ENV, dependencies),
    (error) => error.code === 'DESKTOP_RELAUNCH_REQUIRED' && error.details.desktop.pids[0] === DESKTOP_PID,
  );
  assert.equal(state.quitRequested, false);
  assert.deepEqual(state.launches, []);
});

test('ensure relaunches with per-run or standing authorization and says what it could not inspect', async () => {
  const flagged = scenario();
  const result = await ensure({ relaunch: true }, ENV, flagged.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'relaunched');
  assert.equal(result.relaunchAuthorization, 'flag');
  assert.match(result.warnings[0], /could not be inspected/);
  const quitIndex = flagged.calls.findIndex(([executable, , script]) => executable === 'osascript' && /to quit$/.test(script));
  const openIndex = flagged.calls.findIndex(([executable]) => executable === 'open');
  assert.ok(quitIndex >= 0 && openIndex > quitIndex);
  assert.match(flagged.calls[quitIndex][2], /^tell application id "com\.openai\.codex" to quit$/);

  const standing = scenario();
  const auto = await ensure({}, { ...ENV, TRANSMOGRIFY_DESKTOP_RELAUNCH: 'auto' }, standing.dependencies);
  assert.equal(auto.action, 'relaunched');
  assert.equal(auto.relaunchAuthorization, 'standing-env');
});

test('ensure never relaunches from a session hosted by the Desktop app itself', async () => {
  const { state, dependencies } = scenario({ hostedByDesktop: true });
  const receipt = await check({}, ENV, dependencies);
  assert.equal(receipt.desktop.hostedByDesktop, true);
  await assert.rejects(
    () => ensure({ relaunch: true }, { ...ENV, TRANSMOGRIFY_DESKTOP_RELAUNCH: 'auto' }, dependencies),
    (error) => error.code === 'DESKTOP_HOST_SESSION',
  );
  assert.equal(state.quitRequested, false);
});

test('ensure asks runtime-up for the relay before launching against an absent listener', async () => {
  const { state, calls, dependencies } = scenario({ running: false, runtimeListening: false });
  const result = await ensure({}, ENV, dependencies);
  const runtimeIndex = calls.findIndex(([executable]) => executable === 'runtime-up');
  const launchIndex = calls.findIndex(([executable]) => executable === 'open');
  assert.ok(runtimeIndex >= 0 && launchIndex > runtimeIndex);
  assert.equal(result.receipt.runtimeUrl, 'ws://127.0.0.1:8844/');
  assert.deepEqual(result.receipt.attachment.relay, {
    url: 'ws://127.0.0.1:8844/',
    socketPath: '/private/tmp/codex-daemon.sock',
  });
  assert.deepEqual(state.launches, [[
    '-b', 'com.openai.codex', '--env', 'CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:8844',
  ]]);
});

test('ensure launch-only uses an existing listener and never starts a runtime or relay', async () => {
  const ready = scenario({
    running: false,
    runtimeListening: true,
    runtimePort: 8844,
    relayRecord: {
      url: 'ws://127.0.0.1:8844/',
      socketPath: '/private/tmp/codex-daemon.sock',
    },
  });
  ready.dependencies.runtimeUp = async () => { throw new Error('must not start a runtime'); };
  const result = await ensure({ launchOnly: true }, ENV, ready.dependencies);
  assert.equal(result.action, 'launched');
  assert.equal(result.receipt.attachment.state, 'attached');

  const absent = scenario({ running: false, runtimeListening: false });
  let runtimeStarted = false;
  absent.dependencies.runtimeUp = async () => { runtimeStarted = true; };
  await assert.rejects(
    () => ensure({ launchOnly: true }, ENV, absent.dependencies),
    (error) => error.code === 'RELAY_UNAVAILABLE',
  );
  assert.equal(runtimeStarted, false);
  assert.deepEqual(absent.state.launches, []);
});

test('ensure refuses when runtime-up returns an endpoint without a listener', async () => {
  const fixture = scenario({ running: false, runtimeListening: false });
  fixture.dependencies.runtimeUp = async () => ({
    runtime: 'managed-daemon', url: 'ws://127.0.0.1:8844/',
  });
  await assert.rejects(
    () => ensure({}, ENV, fixture.dependencies),
    (error) => error.code === 'RUNTIME_UNAVAILABLE',
  );
  assert.deepEqual(fixture.state.launches, []);
});

test('ensure fails closed when Desktop never attaches or never quits', async () => {
  await assert.rejects(
    () => ensure({ timeoutMs: 3000 }, ENV, scenario({ running: false, attachOnLaunch: false }).dependencies),
    (error) => error.code === 'ATTACH_TIMEOUT' && error.details.lastState === 'unattached',
  );
  await assert.rejects(
    () => ensure({ relaunch: true }, ENV, scenario({ quitIgnoredPolls: 1000 }).dependencies),
    (error) => error.code === 'DESKTOP_QUIT_TIMEOUT',
  );
});

test('ensure rejects unsupported platforms and the disable switch explicitly', async () => {
  await assert.rejects(
    () => ensure({}, ENV, { ...scenario().dependencies, platform: 'linux' }),
    (error) => error.code === 'UNSUPPORTED_PLATFORM',
  );
  await assert.rejects(
    () => ensure({}, { ...ENV, TRANSMOGRIFY_DESKTOP_ATTACH: 'off' }, scenario().dependencies),
    (error) => error.code === 'ATTACH_DISABLED',
  );
  await assert.rejects(
    () => ensure({ timeoutMs: 5 }, ENV, scenario().dependencies),
    (error) => error.code === 'USAGE_ERROR',
  );
});

test('lsof parsing keeps client-side loopback rows only and rejects a bad process shape', () => {
  const rows = parseEstablishedConnections([
    'p96049', 'cChatGPT', 'n127.0.0.1:53519->127.0.0.1:8843',
    'p83538', 'ccodex', 'n127.0.0.1:8843->127.0.0.1:53519', 'n10.0.0.5:8843->10.0.0.9:40000',
    'p1', 'cx', 'nno-arrow-here',
  ].join('\n'));
  assert.equal(rows.length, 3);
  assert.deepEqual(clientConnections(rows, 8843).map((row) => row.pid), [96049]);
  assert.throws(() => parseEstablishedConnections('pabc\ncx\n'), /unverified process shape/);
});

test('the CLI parses operations strictly and reports the disabled state with exit 3', async () => {
  assert.equal(parseCli(['--help']).help.startsWith('usage: desktop-attach.js'), true);
  assert.throws(() => parseCli(['attach']), /check, ensure, persist, or unpersist/);
  assert.throws(() => parseCli(['check', '--relaunch-desktop']), /ensure only/);
  assert.throws(() => parseCli(['ensure', '--timeout-ms', '0']), /positive integer/);
  assert.deepEqual(parseCli(['persist', '--dry-run']), {
    operation: 'persist', url: undefined, relaunch: false, timeoutMs: undefined,
    launchOnly: false, dryRun: true, authorize: false,
  });
  assert.equal(parseCli(['ensure', '--launch-only']).launchOnly, true);
  assert.throws(() => parseCli(['ensure', '--launch-only', '--relaunch-desktop']), /cannot be combined/);
  assert.throws(() => parseCli(['ensure', '--dry-run']), /persist and unpersist only/);
  assert.throws(() => parseCli(['unpersist', '--url', 'ws://127.0.0.1:8844']), /does not apply/);
  const disabled = await main(['check'], { TRANSMOGRIFY_DESKTOP_ATTACH: 'off' }, scenario().dependencies);
  assert.equal(disabled.attachment.state, 'disabled');

  const script = path.resolve(__dirname, '..', 'scripts', 'desktop-attach.js');
  const { code, stdout } = await new Promise((resolve) => {
    execFile(process.execPath, [script, 'check'], {
      env: { PATH: process.env.PATH, TRANSMOGRIFY_DESKTOP_ATTACH: 'off' },
      encoding: 'utf8',
    }, (error, out) => resolve({ code: error?.code ?? 0, stdout: out }));
  });
  assert.equal(code, 3);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.attachment.state, 'disabled');
  const usage = await new Promise((resolve) => {
    execFile(process.execPath, [script, 'ensure', '--bogus'], { encoding: 'utf8' }, (error, out, err) =>
      resolve({ code: error?.code ?? 0, stdout: out, stderr: err }));
  });
  assert.equal(usage.code, 2);
  assert.equal(usage.stdout, '');
  assert.equal(JSON.parse(usage.stderr).code, 'USAGE_ERROR');
  const projected = cliFailure(Object.assign(new Error('secret raw exception'), {
    code: 'ATTACHED_ELSEWHERE', details: { state: 'private-state', suggestedRuntimeUrl: 'ws://127.0.0.1:9999', secret: 'hidden' },
  }));
  assert.deepEqual(projected, {
    version: 1, ok: false, code: 'ATTACHED_ELSEWHERE',
    message: 'Codex Desktop is attached to a different runtime',
  });
});

test('persist dry-run prints the exact LaunchAgent and launchctl setting without mutation', async () => {
  const calls = [];
  const dependencies = {
    ...scenario().dependencies,
    platform: 'darwin',
    home: '/Users/tester',
    nodePath: '/opt/node/bin/node',
    scriptPath: '/opt/transmogrify/scripts/desktop-attach.js',
    runningRelay: () => ({
      url: 'ws://127.0.0.1:8844/',
      socketPath: '/private/tmp/codex-daemon.sock',
    }),
    runtimeUp: async () => { calls.push('runtime-up'); },
    launchctl: async () => { calls.push('launchctl'); },
    plistWriter: async () => { calls.push('write'); },
  };
  const result = await persist({ dryRun: true }, {}, dependencies);
  assert.deepEqual(calls, []);
  assert.deepEqual(result.launchctl, [
    'launchctl', 'setenv', 'CODEX_APP_SERVER_WS_URL', 'ws://127.0.0.1:8844/',
  ]);
  assert.equal(result.launchAgent.path,
    '/Users/tester/Library/LaunchAgents/sh.transmogrify.attach.plist');
  assert.match(result.launchAgent.contents, /<string>apply-persisted<\/string>/);
  assert.match(result.launchAgent.contents, /<string>ws:\/\/127\.0\.0\.1:8844\/<\/string>/);
});

function persistenceFixture(t, overrides = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-desktop-persist-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const persistenceStateRoot = path.join(root, 'state');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(path.join(persistenceStateRoot, 'desktop-attach'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(persistenceStateRoot, 'desktop-attach', 'verification.json'), JSON.stringify({
    desktop: { version: '26.901.20858', build: '7658' }, attachStatus: 'verified',
  }), { mode: 0o600 });
  const state = { currentValue: '', runtimeUrl: 'ws://127.0.0.1:8844/', ...overrides };
  const calls = [];
  const dependencies = {
    ...scenario().dependencies,
    platform: 'darwin',
    home,
    persistenceStateRoot,
    attachmentRecordReader: undefined,
    plistExists: fs.existsSync,
    plistWriter: (file, contents) => {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, contents, { mode: 0o600 });
    },
    plistRemover: (file) => {
      if (!fs.existsSync(file)) return false;
      fs.unlinkSync(file);
      return true;
    },
    nodePath: '/opt/node/bin/node',
    scriptPath: '/opt/transmogrify/scripts/desktop-attach.js',
    runningRelay: () => ({
      url: state.runtimeUrl,
      socketPath: '/private/tmp/codex-daemon.sock',
    }),
    launchctlGetenv: async () => state.currentValue,
    launchctl: async (args) => {
      calls.push(`launchctl:${args.join(' ')}`);
      if (args[0] === 'setenv') state.currentValue = args[2];
      if (args[0] === 'unsetenv') state.currentValue = '';
    },
    runtimeUp: async (options) => {
      calls.push('runtime-up');
      return { runtime: 'managed-daemon', url: options.url, daemonVersion: '0.153.4' };
    },
  };
  return { env: { HOME: home }, state, calls, dependencies };
}

test('persist and its login apply verify the runtime before setting the environment', async (t) => {
  const fixture = persistenceFixture(t);
  await assert.rejects(() => persist({}, fixture.env, fixture.dependencies), /require --authorize/);
  const result = await persist({ authorize: true }, fixture.env, fixture.dependencies);
  assert.equal(result.launchAgent.written, true);
  assert.equal(result.persistence.phase, 'applied');
  assert.deepEqual(fixture.calls, [
    'runtime-up',
    'launchctl:setenv CODEX_APP_SERVER_WS_URL ws://127.0.0.1:8844/',
  ]);
  assert.equal(fs.existsSync(result.launchAgent.path), true);
  assert.equal(fs.statSync(persistenceReceiptPath(fixture.env, fixture.dependencies)).mode & 0o077, 0);

  fixture.calls.length = 0;
  fixture.state.currentValue = '';
  const applied = await applyPersisted(
    { url: 'ws://127.0.0.1:8844/' }, fixture.env, fixture.dependencies,
  );
  assert.equal(applied.runtimeReadyBeforeEnvironment, true);
  assert.equal(applied.environmentChanged, true);
  assert.deepEqual(fixture.calls, [
    'runtime-up',
    'launchctl:setenv CODEX_APP_SERVER_WS_URL ws://127.0.0.1:8844/',
  ]);
});

test('persist refuses a foreign login setting before runtime or file mutation', async (t) => {
  const fixture = persistenceFixture(t, { currentValue: 'ws://127.0.0.1:9999/' });
  await assert.rejects(
    () => persist({ authorize: true }, fixture.env, fixture.dependencies),
    (error) => error.code === 'FOREIGN_LOGIN_SETTING' && /would replace/.test(error.message),
  );
  assert.deepEqual(fixture.calls, []);
  assert.equal(fs.existsSync(persistenceReceiptPath(fixture.env, fixture.dependencies)), false);
});

test('persist refuses a foreign LaunchAgent before inspecting the login setting', async (t) => {
  const fixture = persistenceFixture(t);
  const file = path.join(fixture.env.HOME, 'Library', 'LaunchAgents', 'sh.transmogrify.attach.plist');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, '<plist>foreign</plist>', { mode: 0o600 });
  let inspected = false;
  fixture.dependencies.launchctlGetenv = async () => { inspected = true; return ''; };
  await assert.rejects(
    () => persist({ authorize: true }, fixture.env, fixture.dependencies),
    (error) => error.code === 'FOREIGN_LAUNCH_AGENT',
  );
  assert.equal(inspected, false);
  assert.deepEqual(fixture.calls, []);
});

test('a failing plist writer restores the previous value and leaves no plist or receipt', async (t) => {
  const fixture = persistenceFixture(t, { currentValue: 'ws://127.0.0.1:8844/' });
  const file = path.join(fixture.env.HOME, 'Library', 'LaunchAgents', 'sh.transmogrify.attach.plist');
  fixture.dependencies.plistWriter = async (target, contents) => {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, contents, { mode: 0o600 });
    throw new Error('simulated plist write failure');
  };
  await assert.rejects(
    () => persist({ authorize: true }, fixture.env, fixture.dependencies),
    /simulated plist write failure/,
  );
  assert.equal(fixture.state.currentValue, 'ws://127.0.0.1:8844/');
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(persistenceReceiptPath(fixture.env, fixture.dependencies)), false);
});

test('persist recovers an interrupted receipt before starting a new transaction', async (t) => {
  const fixture = persistenceFixture(t);
  await persist({ authorize: true }, fixture.env, fixture.dependencies);
  const receiptFile = persistenceReceiptPath(fixture.env, fixture.dependencies);
  const interrupted = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  interrupted.phase = 'plistWritten';
  fs.writeFileSync(receiptFile, `${JSON.stringify(interrupted, null, 2)}\n`, { mode: 0o600 });
  fixture.calls.length = 0;

  const result = await persist({ authorize: true }, fixture.env, fixture.dependencies);
  assert.equal(result.persistence.phase, 'applied');
  assert.deepEqual(fixture.calls, [
    'launchctl:unsetenv CODEX_APP_SERVER_WS_URL',
    'runtime-up',
    'launchctl:setenv CODEX_APP_SERVER_WS_URL ws://127.0.0.1:8844/',
  ]);
});

test('unpersist removes only a receipt-owned plist and restores the previous value', async (t) => {
  const fixture = persistenceFixture(t);
  const persisted = await persist({ authorize: true }, fixture.env, fixture.dependencies);
  fixture.calls.length = 0;
  await assert.rejects(() => unpersist({}, fixture.env, fixture.dependencies), /require --authorize/);
  const result = await unpersist({ authorize: true }, fixture.env, fixture.dependencies);
  assert.equal(result.launchAgent.removed, true);
  assert.deepEqual(fixture.calls, [
    'launchctl:unsetenv CODEX_APP_SERVER_WS_URL',
  ]);
  assert.equal(fs.existsSync(persisted.launchAgent.path), false);
  assert.equal(fs.existsSync(persistenceReceiptPath(fixture.env, fixture.dependencies)), false);
});

test('unpersist refuses a changed login value and leaves owned state intact', async (t) => {
  const fixture = persistenceFixture(t);
  const persisted = await persist({ authorize: true }, fixture.env, fixture.dependencies);
  fixture.calls.length = 0;
  fixture.state.currentValue = 'ws://127.0.0.1:9999/';
  await assert.rejects(
    () => unpersist({ authorize: true }, fixture.env, fixture.dependencies),
    (error) => error.code === 'FOREIGN_LOGIN_SETTING' && /9999/.test(error.message),
  );
  assert.deepEqual(fixture.calls, []);
  assert.equal(fs.existsSync(persisted.launchAgent.path), true);
  assert.equal(fs.existsSync(persistenceReceiptPath(fixture.env, fixture.dependencies)), true);
});

test('unpersist without an owned plist and receipt never clears the login value', async (t) => {
  const fixture = persistenceFixture(t, { currentValue: 'ws://127.0.0.1:8844/' });
  await assert.rejects(
    () => unpersist({ authorize: true }, fixture.env, fixture.dependencies),
    (error) => error.code === 'PERSISTENCE_NOT_OWNED',
  );
  assert.equal(fixture.state.currentValue, 'ws://127.0.0.1:8844/');
  assert.deepEqual(fixture.calls, []);
});

test('the LaunchAgent prefers a stable Node alias that resolves to the running executable', () => {
  const versioned = '/opt/homebrew/Cellar/node/24.8.0/bin/node';
  const real = new Map([
    [versioned, versioned],
    ['/opt/homebrew/bin/node', versioned],
    ['/usr/local/bin/node', '/usr/local/Cellar/node/22.0.0/bin/node'],
    [process.execPath, versioned],
  ]);
  const realpath = (target) => {
    if (!real.has(target)) throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
    return real.get(target);
  };
  assert.equal(stableNodePath(versioned, { realpath }), '/opt/homebrew/bin/node');
  // No alias names this executable: keep the exact path.
  const nvm = '/Users/me/.nvm/versions/node/v24.8.0/bin/node';
  assert.equal(stableNodePath(nvm, { realpath: (target) => (target === nvm ? nvm : realpath(target)) }), nvm);
  // An unreadable executable path is returned unchanged rather than guessed.
  assert.equal(stableNodePath('/missing/node', { realpath }), '/missing/node');
  const contents = launchAgentContents('ws://127.0.0.1:8844/', { realpath, scriptPath: '/skill/scripts/desktop-attach.js' });
  assert.match(contents, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  // An explicit nodePath still wins.
  assert.match(launchAgentContents('ws://127.0.0.1:8844/', { nodePath: '/exact/node', scriptPath: '/skill/scripts/desktop-attach.js' }), /<string>\/exact\/node<\/string>/);
});

for (const selection of ['relay only', 'relay and environment', 'neither']) {
  test(`ensure uses the common runtime selector without launching when already attached: ${selection}`, async (t) => {
    const { createStateFixture } = require('./helpers/state-fixture');
    const { writeRelayRecord, runningRelay } = require('../scripts/lib/relay');
    const fixture = createStateFixture(t);
    const env = { ...fixture.env };
    delete env.TRANSMOGRIFY_DESKTOP_ATTACH;
    delete env.TRANSMOGRIFY_URL;
    delete env.TRANSMOGRIFY_PORT;
    let relay;
    if (selection !== 'neither') relay = writeRelayRecord({ version: 1, host: '127.0.0.1', port: 19001,
      url: 'ws://127.0.0.1:19001/', pid: 321, processBirth: 'birth', origin: 'launched',
      socketPath: '/tmp/daemon.sock', startedAt: '2026-09-05T00:00:00Z' }, env);
    if (selection === 'relay and environment') env.TRANSMOGRIFY_URL = 'ws://127.0.0.1:19002';
    const expected = new URL(require('../scripts/lib/codex-runtime').runtimeUrl({}, env, { processMatches: () => true })).href;
    const mocked = scenario({ attached: true, runtimePort: Number(new URL(expected).port), relayRecord: relay });
    const result = await ensure({}, env, { ...mocked.dependencies,
      runningRelay: (selectedEnv) => runningRelay(selectedEnv, { processMatches: () => true }),
    });
    assert.equal(result.receipt.runtimeUrl, expected);
    assert.equal(result.action, 'reused');
    assert.deepEqual(mocked.state.launches, []);
  });
}

const { attachmentBuildStatus, BUILD_REFUSAL, RESCUE_COMMAND } = require('../scripts/lib/desktop-attach');
const BROKEN_BUILD = { version: '26.901.51231', build: '8109' };
const UNTESTED_BUILD = { version: '26.999.1', build: '9999' };

function replaceInventory(fixture, build, extra = {}) {
  const fake = scenario({ ...build, ...extra, runtimePort: 8844 });
  fixture.dependencies.execFileResult = fake.dependencies.execFileResult;
  return fake;
}

function savedReceipt(fixture) {
  return JSON.parse(fs.readFileSync(persistenceReceiptPath(fixture.env, fixture.dependencies), 'utf8'));
}

function pauseRecord(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture.dependencies.persistenceStateRoot,
    'desktop-attach', 'paused.json'), 'utf8'));
}

test('attachment build lookup distinguishes exact verified, broken, and untested pairs', () => {
  const historical = { version: '26.901.20858', build: '7658' };
  assert.equal(attachmentBuildStatus(historical), 'untested');
  assert.equal(attachmentBuildStatus(historical, { desktop: historical, attachStatus: 'verified' }), 'verified');
  assert.equal(attachmentBuildStatus(BROKEN_BUILD), 'broken');
  assert.equal(attachmentBuildStatus(UNTESTED_BUILD), 'untested');
  assert.equal(attachmentBuildStatus({ ...BROKEN_BUILD, build: '8110' }), 'untested');
  assert.equal(attachmentBuildStatus(null), 'untested');
  assert.match(TESTED_DESKTOP_BUILDS.find((entry) => entry.attachStatus === 'broken').reason, /placeholder/);
});

for (const [status, build] of [['broken', BROKEN_BUILD], ['untested', UNTESTED_BUILD]]) {
  for (const options of [{}, { launchOnly: true }, { relaunch: true }]) {
    test(`ensure refuses ${status} builds before any login change: ${JSON.stringify(options)}`, async (t) => {
      const fixture = persistenceFixture(t);
      // An old owned setting must remain untouched on a refused ensure.
      await persist({ authorize: true }, fixture.env, fixture.dependencies);
      const before = savedReceipt(fixture);
      const fake = replaceInventory(fixture, build, { attached: true });
      fixture.calls.length = 0;
      await assert.rejects(() => ensure(options, fixture.env, fixture.dependencies), (error) => {
        assert.equal(error.code, 'POLICY_REFUSAL');
        assert.equal(error.details.attachStatus, status);
        assert.equal(cliFailure(error).message, BUILD_REFUSAL);
        return true;
      });
      assert.deepEqual(fixture.calls, []);
      assert.deepEqual(fake.state.launches, []);
      assert.equal(fake.state.quitRequested, false);
      assert.deepEqual(savedReceipt(fixture), before);
    });
  }
  test(`persist refuses ${status} builds including dry-run before any login change`, async (t) => {
    const fixture = persistenceFixture(t);
    replaceInventory(fixture, build);
    for (const options of [{ authorize: true }, { dryRun: true }]) {
      await assert.rejects(() => persist(options, fixture.env, fixture.dependencies),
        (error) => error.code === 'POLICY_REFUSAL' && error.details.attachStatus === status);
    }
    assert.deepEqual(fixture.calls, []);
    assert.equal(fs.existsSync(persistenceReceiptPath(fixture.env, fixture.dependencies)), false);
  });
  test(`an attached ${status} app reports rescue and cannot supply a verified attachment state`, async (t) => {
    const fixture = persistenceFixture(t);
    replaceInventory(fixture, build, { attached: true });
    const result = await main(['check'], fixture.env, fixture.dependencies);
    assert.equal(result.ok, false);
    assert.equal(result.desktop.attachStatus, status);
    assert.equal(result.desktop.buildTested, false);
    assert.equal(result.attachment.state, 'unverifiedBuild');
    assert.equal(result.nextAction, RESCUE_COMMAND);
    assert.deepEqual(fixture.calls, []);
  });
  test(`exact owner verification permits ${status} builds and survives a later check`, async (t) => {
    const fixture = persistenceFixture(t);
    replaceInventory(fixture, build, { attached: true });
    await assert.rejects(() => persist({ authorize: true, verifiedBuild: { ...build, build: '1' } },
      fixture.env, fixture.dependencies), (error) => error.code === 'USAGE_ERROR');
    assert.deepEqual(fixture.calls, []);
    const result = await main(['persist', '--authorize', '--verified-build', build.version, build.build],
      fixture.env, fixture.dependencies);
    assert.equal(result.persistence.phase, 'applied');
    assert.deepEqual(savedReceipt(fixture).desktop, build);
    assert.equal(savedReceipt(fixture).daemonVersion, '0.153.4');
    const checked = await check({}, fixture.env, fixture.dependencies);
    assert.equal(checked.desktop.attachStatus, 'verified');
    assert.equal(checked.attachment.state, 'attached');
    assert.equal(checked.ok, true);
    assert.equal(checked.persisted, true);
  });
}

test('verified-build parsing rejects incomplete, mismatched, or misplaced assertions', () => {
  for (const args of [
    ['persist', '--verified-build', '26.1'],
    ['check', '--verified-build', '26.1', '1'],
    ['unpersist', '--verified-build', '26.1', '1'],
    ['ensure', '--verified-build', '26.1', 'invalid'],
    ['persist', '--verified-build', '26.1', '1', 'extra'],
  ]) assert.throws(() => parseCli(args));
});

for (const operation of ['check', 'apply-persisted']) {
  for (const rollback of [null, 'ws://127.0.0.1:8844/']) {
    test(`${operation} pauses a changed build and restores the receipt rollback value ${rollback}`, async (t) => {
      const fixture = persistenceFixture(t, { currentValue: rollback || '' });
      await persist({ authorize: true }, fixture.env, fixture.dependencies);
      const previousBuild = savedReceipt(fixture).desktop;
      fixture.state.runtimeUrl = 'ws://127.0.0.1:8845/';
      // Re-persisting must not overwrite the original rollback with our own setting.
      await persist({ authorize: true }, fixture.env, fixture.dependencies);
      assert.equal(savedReceipt(fixture).rollbackValue, rollback);
      replaceInventory(fixture, BROKEN_BUILD, { attached: true });
      fixture.calls.length = 0;
      if (operation === 'apply-persisted') fixture.state.currentValue = '';
      const result = await main([operation], fixture.env, fixture.dependencies);
      assert.equal(result.attachment.state, 'paused');
      assert.deepEqual(result.attachment.paused, {
        reason: 'app-updated', previousBuild, currentBuild: BROKEN_BUILD,
      });
      assert.equal(fixture.state.currentValue, rollback || '');
      assert.equal(fixture.calls.includes('runtime-up'), false);
      assert.equal(fs.existsSync(persistenceReceiptPath(fixture.env, fixture.dependencies)), false);
      assert.equal(fs.existsSync(path.join(fixture.env.HOME, 'Library/LaunchAgents/sh.transmogrify.attach.plist')), false);
      assert.deepEqual(pauseRecord(fixture).attachment, result.attachment);
      const checkedAgain = await check({}, fixture.env, fixture.dependencies);
      assert.equal(checkedAgain.attachment.state, 'paused');
      assert.equal(checkedAgain.persisted, false);
    });
  }
}

test('changed build rollback retries after a failed removal without losing authority', async (t) => {
  const fixture = persistenceFixture(t);
  await persist({ authorize: true }, fixture.env, fixture.dependencies);
  replaceInventory(fixture, BROKEN_BUILD);
  fixture.dependencies.plistRemover = () => { throw new Error('injected removal failure'); };
  await assert.rejects(() => applyPersisted({}, fixture.env, fixture.dependencies), /injected removal failure/);
  assert.equal(savedReceipt(fixture).phase, 'applied');
  assert.equal(fixture.state.currentValue, '');
  delete fixture.dependencies.plistRemover;
  const result = await applyPersisted({}, fixture.env, fixture.dependencies);
  assert.equal(result.attachment.state, 'paused');
  assert.equal(fs.existsSync(persistenceReceiptPath(fixture.env, fixture.dependencies)), false);
});

test('changed build never overwrites a foreign login value', async (t) => {
  const fixture = persistenceFixture(t);
  await persist({ authorize: true }, fixture.env, fixture.dependencies);
  replaceInventory(fixture, BROKEN_BUILD);
  fixture.state.currentValue = 'foreign-value';
  fixture.calls.length = 0;
  await assert.rejects(() => applyPersisted({}, fixture.env, fixture.dependencies),
    (error) => error.code === 'FOREIGN_LOGIN_SETTING');
  assert.deepEqual(fixture.calls, []);
  assert.equal(savedReceipt(fixture).phase, 'applied');
});

test('legacy receipts without app pins pause safely instead of accepting a new app by inference', async (t) => {
  const fixture = persistenceFixture(t);
  await persist({ authorize: true }, fixture.env, fixture.dependencies);
  const receipt = savedReceipt(fixture);
  receipt.version = 1;
  delete receipt.desktop;
  delete receipt.daemonVersion;
  fs.writeFileSync(persistenceReceiptPath(fixture.env, fixture.dependencies), JSON.stringify(receipt));
  const result = await applyPersisted({}, fixture.env, fixture.dependencies);
  assert.equal(result.attachment.state, 'paused');
  assert.equal(result.attachment.paused.previousBuild, null);
  assert.equal(fixture.state.currentValue, '');
});

test('a paused attachment flows through the real doctor, plan, and setup without offering persistence', async (t) => {
  const { doctorReport } = require('./helpers/onboarding-fixture');
  const { runSetup } = require('../scripts/setup');
  const fixture = persistenceFixture(t);
  await persist({ authorize: true }, fixture.env, fixture.dependencies);
  replaceInventory(fixture, BROKEN_BUILD);
  const report = await doctorReport(t, {
    desktopAttachment: () => check({}, fixture.env, fixture.dependencies),
  });
  assert.equal(report.providers.codex.desktop.attachStatus, 'broken');
  assert.equal(report.providers.codex.attachment.state, 'paused');
  assert.equal(report.providers.codex.nativeVisibility.verified, false);
  assert.equal(report.setup.outcome, 'ready-with-limitations');
  assert.equal(report.setup.plan.steps.length, 1);
  assert.equal(report.setup.plan.steps[0].action, 'attachment-paused');
  assert.equal(report.setup.plan.steps[0].consent, 'none');
  assert.match(report.setup.plan.steps[0].what, /app changed.*streaming is paused/);
  assert.match(report.setup.plan.steps[0].command, /--verified-build <version> <build>/);
  for (const dryRun of [true, false]) {
    const result = await runSetup({ dryRun }, {}, { runDoctor: async () => report,
      hostContext: {}, narrate() {}, runProcess() { throw new Error('must not execute a pause notice'); } });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'ready-with-limitations');
    assert.deepEqual(result.completed, []);
    assert.deepEqual(result.plan, report.setup.plan);
  }
});

test('current-machine fixture: broken app with no persistence keeps protocol lanes ready', async (t) => {
  const { doctorReport } = require('./helpers/onboarding-fixture');
  const { renderSetupSummary } = require('../scripts/doctor');
  const { runSetup } = require('../scripts/setup');
  const fixture = persistenceFixture(t);
  replaceInventory(fixture, BROKEN_BUILD);
  const checked = await main(['check'], fixture.env, fixture.dependencies);
  assert.equal(checked.desktop.attachStatus, 'broken');
  assert.equal(checked.persisted, false);
  assert.equal(checked.attachment.state, 'unattached');
  assert.equal(checked.ok, false);
  assert.equal(checked.nextAction, BUILD_REFUSAL);
  const report = await doctorReport(t, {
    codexVersion: '0.153.4',
    desktopAttachment: () => check({}, fixture.env, fixture.dependencies),
  });
  assert.equal(report.setup.ready, true);
  assert.equal(report.setup.outcome, 'ready-with-limitations');
  assert.deepEqual(report.setup.plan.steps, []);
  assert.match(renderSetupSummary(report), /Needed: This Codex app version has not been verified/);
  const setup = await runSetup({ dryRun: true }, {}, { runDoctor: async () => report });
  assert.equal(setup.outcome, 'ready-with-limitations');
  assert.deepEqual(setup.providers, { claude: 'ready', codex: 'ready-with-limitations' });
  assert.deepEqual(setup.plan.steps, []);
  assert.deepEqual(fixture.calls, []);
  if (process.env.ATTACHMENT_FIXTURE_OUTPUT) {
    fs.writeFileSync(process.env.ATTACHMENT_FIXTURE_OUTPUT, JSON.stringify({
      check: checked, doctor: report, doctorExplain: renderSetupSummary(report), setup,
    }, null, 2));
  }
});

test('a broken status pauses an unchanged pinned build after its attestation is withdrawn', async (t) => {
  const fixture = persistenceFixture(t);
  replaceInventory(fixture, BROKEN_BUILD);
  await persist({ authorize: true, verifiedBuild: BROKEN_BUILD }, fixture.env, fixture.dependencies);
  fs.unlinkSync(path.join(fixture.dependencies.persistenceStateRoot, 'desktop-attach/verification.json'));
  const result = await check({}, fixture.env, fixture.dependencies);
  assert.equal(result.attachment.state, 'paused');
  assert.equal(result.attachment.paused.reason, 'app-build-broken');
  assert.deepEqual(result.attachment.paused.previousBuild, BROKEN_BUILD);
  assert.deepEqual(result.attachment.paused.currentBuild, BROKEN_BUILD);
  assert.equal(fixture.state.currentValue, '');
});

test('a verified new build still pauses the old persistence pin', async (t) => {
  const fixture = persistenceFixture(t);
  await persist({ authorize: true }, fixture.env, fixture.dependencies);
  replaceInventory(fixture, UNTESTED_BUILD);
  fs.writeFileSync(path.join(fixture.dependencies.persistenceStateRoot, 'desktop-attach/verification.json'),
    JSON.stringify({ desktop: UNTESTED_BUILD, attachStatus: 'verified' }));
  const result = await check({}, fixture.env, fixture.dependencies);
  assert.equal(result.desktop.attachStatus, 'verified');
  assert.equal(result.attachment.state, 'paused');
  assert.equal(fixture.state.currentValue, '');
});

test('the disable switch cannot preserve obsolete login persistence', async (t) => {
  const fixture = persistenceFixture(t);
  await persist({ authorize: true }, fixture.env, fixture.dependencies);
  replaceInventory(fixture, BROKEN_BUILD);
  const result = await check({}, { ...fixture.env, TRANSMOGRIFY_DESKTOP_ATTACH: 'off' }, fixture.dependencies);
  assert.equal(result.attachment.state, 'paused');
  assert.equal(fixture.state.currentValue, '');
});

test('a dry-run owner assertion never writes verification or clears a pause', async (t) => {
  const fixture = persistenceFixture(t);
  await persist({ authorize: true }, fixture.env, fixture.dependencies);
  replaceInventory(fixture, BROKEN_BUILD);
  await check({}, fixture.env, fixture.dependencies);
  fixture.calls.length = 0;
  const result = await persist({ dryRun: true, verifiedBuild: BROKEN_BUILD }, fixture.env, fixture.dependencies);
  assert.equal(result.dryRun, true);
  const after = await check({}, fixture.env, fixture.dependencies);
  assert.equal(after.desktop.attachStatus, 'broken');
  assert.equal(after.attachment.state, 'paused');
  assert.deepEqual(fixture.calls, []);
});

test('ensure with exact owner verification re-enables a paused build without login persistence', async (t) => {
  const fixture = persistenceFixture(t);
  await persist({ authorize: true }, fixture.env, fixture.dependencies);
  replaceInventory(fixture, BROKEN_BUILD);
  await check({}, fixture.env, fixture.dependencies);
  const fake = replaceInventory(fixture, BROKEN_BUILD, { running: false });
  fixture.calls.length = 0;
  const result = await main(['ensure', '--launch-only', '--verified-build', BROKEN_BUILD.version, BROKEN_BUILD.build],
    fixture.env, fixture.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'launched');
  assert.equal(fake.state.launches.length, 1);
  assert.equal(fs.existsSync(path.join(fixture.dependencies.persistenceStateRoot, 'desktop-attach/paused.json')), false);
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.state.currentValue, '');
});

test('persistence refuses an unmeasured daemon version before any login or plist write', async (t) => {
  const fixture = persistenceFixture(t);
  fixture.dependencies.runtimeUp = async (options) => ({ url: options.url });
  await assert.rejects(() => persist({ authorize: true }, fixture.env, fixture.dependencies),
    (error) => error.code === 'UNVERIFIED_RUNTIME');
  assert.deepEqual(fixture.calls, []);
  assert.equal(fs.existsSync(persistenceReceiptPath(fixture.env, fixture.dependencies)), false);
});

test('attachment docs retain exact-build gating, pause fields, and resume-error rescue', () => {
  const root = path.join(__dirname, '..');
  const output = fs.readFileSync(path.join(root, 'docs/OUTPUT.md'), 'utf8');
  for (const field of ['desktop.attachStatus', 'unverifiedBuild', 'attachment.paused', 'previousBuild', 'currentBuild', 'daemonVersion']) {
    assert.ok(output.includes(field), field);
  }
  for (const file of ['README.md', 'SKILL.md', 'SECURITY.md', 'docs/TROUBLESHOOTING.md']) {
    const contents = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(contents, /--verified-build <version> <build>/, file);
    assert.match(contents, /resume/, file);
  }
  assert.ok(fs.readFileSync(path.join(root, 'docs/TROUBLESHOOTING.md'), 'utf8').includes(RESCUE_COMMAND));
});

test('ensure on a newly verified build refuses stale persistence without changing the login environment', async (t) => {
  const fixture = persistenceFixture(t);
  await persist({ authorize: true }, fixture.env, fixture.dependencies);
  replaceInventory(fixture, BROKEN_BUILD, { attached: true });
  fixture.calls.length = 0;
  await assert.rejects(() => ensure({ verifiedBuild: BROKEN_BUILD }, fixture.env, fixture.dependencies),
    (error) => error.code === 'POLICY_REFUSAL' && /desktop-attach.js check/.test(cliFailure(error).message));
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.state.currentValue, 'ws://127.0.0.1:8844/');
  assert.equal(savedReceipt(fixture).phase, 'applied');
});

test('the plan never offers open, relaunch, or persistence for unverified builds', async (t) => {
  const { doctorReport } = require('./helpers/onboarding-fixture');
  for (const build of [BROKEN_BUILD, UNTESTED_BUILD]) {
    for (const desktopState of ['attached', 'unattached', 'notRunning']) {
      const report = await doctorReport(t, { target: 'codex', persisted: false, desktopState, desktopOptions: build });
      assert.equal(report.setup.outcome, 'ready-with-limitations');
      assert.deepEqual(report.setup.plan.steps, []);
    }
  }
});

test('persist with a fresh exact owner verification clears the durable pause', async (t) => {
  const fixture = persistenceFixture(t);
  await persist({ authorize: true }, fixture.env, fixture.dependencies);
  replaceInventory(fixture, BROKEN_BUILD, { attached: true });
  await check({}, fixture.env, fixture.dependencies);
  const result = await persist({ authorize: true, verifiedBuild: BROKEN_BUILD }, fixture.env, fixture.dependencies);
  assert.equal(result.ok, true);
  const checked = await check({}, fixture.env, fixture.dependencies);
  assert.equal(checked.desktop.attachStatus, 'verified');
  assert.equal(checked.attachment.state, 'attached');
  assert.equal(checked.persisted, true);
  assert.equal(fs.existsSync(path.join(fixture.dependencies.persistenceStateRoot, 'desktop-attach/paused.json')), false);
});
