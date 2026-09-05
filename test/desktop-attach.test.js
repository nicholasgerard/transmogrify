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

const APP = '/Applications/ChatGPT.app';
const DESKTOP_PID = 96049;
const SELF_PID = 4242;

function scenario(overrides = {}) {
  const state = {
    installed: true,
    launchServices: true,
    diskInstalled: false,
    running: true,
    attached: false,
    attachOnLaunch: true,
    runtimeListening: true,
    runtimePort: 8843,
    relayRecord: null,
    elsewherePort: null,
    hostedByDesktop: false,
    quitRequested: false,
    quitIgnoredPolls: 0,
    launches: [],
    ...overrides,
  };
  const calls = [];
  const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
  const fail = (stderr = '', code = 1) => ({ code, stdout: '', stderr });
  async function run(executable, args) {
    calls.push([executable, ...args]);
    if (executable === 'osascript' && args[1].startsWith('POSIX path')) {
      return state.installed && state.launchServices && args[1].includes('com.openai.codex')
        ? ok(`${APP}\n`) : fail('not found');
    }
    if (executable === 'osascript' && args[1].endsWith('to quit')) {
      state.quitRequested = true;
      return ok('');
    }
    if (executable === 'defaults') {
      return ok(args[2] === 'CFBundleShortVersionString' ? '26.901.20858\n' : '7658\n');
    }
    if (executable === 'plutil') {
      if (args[1] === 'CFBundleIdentifier') return ok('com.openai.codex\n');
      return ok(args[1] === 'CFBundleShortVersionString' ? '26.901.22334\n' : '7746\n');
    }
    if (executable === 'ps' && args[0] === '-axo') {
      if (state.quitRequested) {
        if (state.quitIgnoredPolls > 0) state.quitIgnoredPolls -= 1;
        else state.running = false;
      }
      return ok(state.running
        ? `${DESKTOP_PID} ${APP}/Contents/MacOS/ChatGPT\n    1 /sbin/launchd\n 500 ${APP}/Contents/Frameworks/Helper.app/Contents/MacOS/Helper\n`
        : '    1 /sbin/launchd\n');
    }
    if (executable === 'ps' && args[0] === '-o') {
      const pid = Number(args[3]);
      if (pid === SELF_PID) return ok(`${state.hostedByDesktop ? DESKTOP_PID : 1}\n`);
      return ok('1\n');
    }
    if (executable === 'open') {
      state.launches.push(args);
      state.running = true;
      state.quitRequested = false;
      state.attached = state.attachOnLaunch;
      return ok('');
    }
    if (executable === 'lsof') {
      if (args.includes('-a')) {
        return state.elsewherePort
          ? ok(`p${DESKTOP_PID}\ncChatGPT\nn127.0.0.1:50001->127.0.0.1:${state.elsewherePort}\n`)
          : fail();
      }
      if (args.includes('-iTCP') && args.includes('-sTCP:LISTEN')) {
        return ok(`p777\nccodex\nn127.0.0.1:${state.elsewherePort}\np778\ncnode\nn127.0.0.1:3000\n`);
      }
      const portOption = args.find((argument) => argument.startsWith('-iTCP:'));
      const selectedPort = Number(portOption?.slice('-iTCP:'.length));
      if (selectedPort && args.includes('-sTCP:LISTEN')) {
        return state.runtimeListening && selectedPort === state.runtimePort
          ? ok(`p83538\nccodex\nn127.0.0.1:${selectedPort}\n`) : fail();
      }
      if (selectedPort && args.includes('-sTCP:ESTABLISHED')) {
        return state.attached && selectedPort === state.runtimePort
          ? ok(`p${DESKTOP_PID}\ncChatGPT\nn127.0.0.1:53519->127.0.0.1:${selectedPort}\np83538\nccodex\nn127.0.0.1:${selectedPort}->127.0.0.1:53519\n`)
          : fail();
      }
    }
    throw new Error(`unexpected ${executable} ${args.join(' ')}`);
  }
  let clock = 1_000_000;
  const dependencies = {
    execFileResult: run,
    platform: 'darwin',
    pid: SELF_PID,
    now: () => '2026-09-02T22:00:00.000Z',
    sleep: async (milliseconds) => { clock += milliseconds; },
    clock: () => clock,
    existsSync: () => state.diskInstalled,
    runningRelay: () => state.relayRecord,
    launchctlGetenv: async () => state.persistedUrl || '',
    plistExists: () => state.plistExists === true,
    runtimeUp: async () => {
      calls.push(['runtime-up']);
      state.runtimeListening = true;
      state.runtimePort = 8844;
      state.relayRecord = {
        url: 'ws://127.0.0.1:8844/',
        socketPath: '/private/tmp/codex-daemon.sock',
      };
      return { runtime: 'managed-daemon', url: state.relayRecord.url };
    },
  };
  return { state, calls, dependencies };
}

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
  const state = { currentValue: '', runtimeUrl: 'ws://127.0.0.1:8844/', ...overrides };
  const calls = [];
  const dependencies = {
    platform: 'darwin',
    home,
    persistenceStateRoot,
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
      return { runtime: 'managed-daemon', url: options.url };
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
