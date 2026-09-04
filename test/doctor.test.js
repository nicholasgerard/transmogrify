'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');
const {
  CLAUDE_BACKEND,
  CODEX_BACKEND,
  codexCliBinaries,
  main,
  parseDoctorArgs,
  renderSetupSummary,
} = require('../scripts/doctor');
const {
  PINNED_CLI_SHA256,
  PINNED_CLI_VERSION,
} = require('../scripts/lib/claude-surface');
const {
  beginLaneOperation,
  readRegistry,
  registerLane,
} = require('../scripts/lib/state');
const { startMockAppServer } = require('./helpers/mock-app-server');
const { createRepoWithSeat } = require('./helpers/repo-fixture');

const CLAUDE_SESSION = '11111111-1111-4111-8111-111111111111';

function fakeClaudeSurface(calls, rows = []) {
  return {
    preflight(options, env) {
      calls.push({ method: 'preflight', options, path: env.PATH });
      return {
        cliVersion: PINNED_CLI_VERSION,
        cliSha256: PINNED_CLI_SHA256,
        configDir: '/Users/private/.claude',
        orgId: 'org-private',
        email: 'private@example.invalid',
      };
    },
    async run(runtime, args, options) {
      calls.push({ method: 'run', runtime, args, options });
      return { stdout: JSON.stringify(rows), stderr: '' };
    },
  };
}

async function waitForRequests(server, count) {
  const deadline = Date.now() + 1000;
  while (server.requests.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('doctor reuses only read-only provider surfaces and emits aggregate ownership', async (t) => {
  const fixture = createRepoWithSeat(t);
  registerLane(fixture.repoRoot, {
    laneId: 'codex-owned',
    backend: CODEX_BACKEND,
    providerId: 'thread-private-id',
    displayName: 'Codex private lane',
    state: 'active',
  }, fixture.env);
  registerLane(fixture.repoRoot, {
    laneId: 'claude-owned',
    backend: CLAUDE_BACKEND,
    providerId: CLAUDE_SESSION,
    displayName: 'Claude private lane',
    state: 'active',
  }, fixture.env);
  beginLaneOperation(fixture.repoRoot, 'claude-owned', {
    operationId: crypto.randomUUID(),
    type: 'steer',
    state: 'planned',
    details: {},
  }, fixture.env);

  const server = await startMockAppServer();
  t.after(() => server.close());
  const claudeCalls = [];
  const secretBridge = 'session_privateBridge123';
  const secretSocket = '/tmp/cc-socks/123.sock';
  const result = await main([
    '--repo-root', fixture.repoRoot,
    '--target', 'all',
    '--url', server.url,
    '--claude-bin', '/opt/homebrew/bin/claude',
    '--timeout-ms', '4321',
  ], { ...fixture.env, PATH: '/bin' }, {
    claudeSurface: fakeClaudeSurface(claudeCalls, [{
      sessionId: CLAUDE_SESSION,
      id: '11111111',
      name: 'private provider row',
      cwd: fixture.seat,
      bridgeId: secretBridge,
      socket: secretSocket,
      startedAt: '2026-09-01T19:00:00.000Z',
    }]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerMutationsAttempted, false);
  assert.deepEqual(result.registry.ownership[CODEX_BACKEND], {
    ownedLanes: 1,
    pendingOperations: 0,
  });
  assert.deepEqual(result.registry.ownership[CLAUDE_BACKEND], {
    ownedLanes: 1,
    pendingOperations: 1,
  });
  assert.equal(result.providers.codex.reuse, 'existing-compatible-protocol-runtime');
  assert.equal(result.providers.codex.reusable, true);
  assert.deepEqual(result.providers.codex.nativeVisibility, {
    verified: false,
    nativeDispatchReady: false,
    evidence: 'desktop-attachment:disabled',
    nextAction: 'use-allow-protocol-only',
  });
  assert.equal(result.providers.codex.probe, 'initialize-handshake-method-compatibility-and-desktop-attachment-read');
  assert.deepEqual(result.providers.codex.observed, {
    userAgentFamily: 'codex_cli_rs',
    version: '0.151.0',
    pinnedVersionLine: true,
    compatibility: 'good',
    compatibleMethods: [
      'thread/list', 'thread/turns/list', 'turn/steer', 'thread/name/set', 'thread/archive',
    ],
  });
  assert.equal(result.providers.claude.reuse, 'installed-cli-session-surface');
  assert.equal(result.providers.claude.reusable, true);
  assert.equal(result.providers.claude.observed.agentListReadable, true);
  assert.equal(result.providers.claude.pinned.cliVersion, PINNED_CLI_VERSION);
  assert.equal(result.providers.claude.pinned.cliSha256, PINNED_CLI_SHA256);
  await waitForRequests(server, 7);
  assert.deepEqual(server.requests.map((request) => request.method), [
    'initialize',
    'initialized',
    'thread/list',
    'thread/turns/list',
    'turn/steer',
    'thread/name/set',
    'thread/archive',
  ]);
  assert.deepEqual(claudeCalls.map((call) => call.method), ['preflight', 'run']);
  assert.deepEqual(claudeCalls[0].options, { claudeBin: '/opt/homebrew/bin/claude' });
  assert.deepEqual(claudeCalls[1].args, ['agents', '--json', '--all']);
  assert.equal(claudeCalls[1].options.timeoutMs, 4321);
  assert.deepEqual(result.nextSafeMaintenanceCommands.map((entry) => entry.provider), [
    'codex', 'claude',
  ]);
  assert.deepEqual(result.nextSafeMaintenanceCommands.map((entry) => entry.command), [
    `node "$SKILL_ROOT/scripts/lane.js" reconcile --repo-root "$REPO_ROOT" --target codex --url ${JSON.stringify(new URL(server.url).toString())}`,
    'node "$SKILL_ROOT/scripts/lane.js" reconcile --repo-root "$REPO_ROOT" --target claude --claude-bin "$CLAUDE_BIN"',
  ]);
  assert.deepEqual(result.nextSafeMaintenanceCommands.map((entry) => entry.requiredHostBindings), [
    ['SKILL_ROOT', 'REPO_ROOT'],
    ['SKILL_ROOT', 'REPO_ROOT', 'CLAUDE_BIN'],
  ]);
  assert.equal(result.nextSafeMaintenanceCommands.some(
    (entry) => /(?:^|\s)node scripts\/lane\.js(?:\s|$)/.test(entry.command),
  ), false);

  const output = JSON.stringify(result);
  for (const secret of [
    'thread-private-id',
    CLAUDE_SESSION,
    secretBridge,
    secretSocket,
    'org-private',
    'private@example.invalid',
    '/Users/private/.claude',
    'private provider row',
  ]) {
    assert.equal(output.includes(secret), false, secret);
  }
});

test('doctor creates the outside-repository registry and skips unrequested providers', async (t) => {
  const fixture = createRepoWithSeat(t);
  fs.rmSync(fixture.stateDir, { recursive: true, force: true });
  let claudeTouched = false;
  const server = await startMockAppServer();
  t.after(() => server.close());

  const result = await main([
    '--repo-root', fixture.repoRoot,
    '--target', 'codex',
    '--url', server.url,
  ], fixture.env, {
    createClaudeSurface() {
      claudeTouched = true;
      throw new Error('must not run');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.registry.state, 'ready');
  assert.equal(result.registry.outsideRepository, true);
  assert.equal(readRegistry(fixture.repoRoot, fixture.env).registry.schemaVersion, 1);
  assert.equal(result.providers.claude.requested, false);
  assert.equal(result.providers.claude.available, null);
  assert.equal(claudeTouched, false);
  assert.deepEqual(result.nextSafeMaintenanceCommands, []);
  await waitForRequests(server, 7);
  assert.deepEqual(server.requests.map((request) => request.method), [
    'initialize',
    'initialized',
    'thread/list',
    'thread/turns/list',
    'turn/steer',
    'thread/name/set',
    'thread/archive',
  ]);
});

test('doctor turns a measured Desktop attachment into the native-visibility receipt', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer();
  t.after(() => server.close());
  const probes = [];
  const attached = await main([
    '--repo-root', fixture.repoRoot,
    '--target', 'codex',
    '--url', server.url,
  ], fixture.env, {
    desktopAttachment: async (probe) => {
      probes.push(probe.url);
      return {
        attachment: {
          state: 'attached',
          evidence: 'lsof-established-loopback-connection',
          clientPid: 96049,
          connection: '127.0.0.1:53519->127.0.0.1:8843',
          observedAt: '2026-09-02T22:00:00.000Z',
        },
        desktop: {
          bundleId: 'com.openai.codex', version: '26.999.1', build: '9999', buildTested: false, hostedByDesktop: false,
        },
        nextAction: 'none',
      };
    },
  });
  assert.equal(attached.ok, true);
  assert.deepEqual(probes, [new URL(server.url).href]);
  assert.deepEqual(attached.providers.codex.nativeVisibility, {
    verified: true,
    nativeDispatchReady: true,
    evidence: 'codex-desktop-attached-to-selected-runtime',
    receipt: {
      clientPid: 96049,
      connection: '127.0.0.1:53519->127.0.0.1:8843',
      observedAt: '2026-09-02T22:00:00.000Z',
      bundleId: 'com.openai.codex',
      desktopVersion: '26.999.1',
      desktopBuild: '9999',
      buildTested: false,
      hostedByDesktop: false,
    },
    nextAction: 'run-disposable-exact-owned-app-visibility-check-on-this-untested-desktop-build',
  });

  const unattached = await main([
    '--repo-root', fixture.repoRoot,
    '--target', 'codex',
    '--url', server.url,
  ], fixture.env, {
    desktopAttachment: async () => ({
      attachment: { state: 'unattached', evidence: 'no-established-connection-to-runtime' },
      desktop: { running: true },
      nextAction: 'run-desktop-attach-ensure',
    }),
  });
  assert.equal(unattached.ok, true);
  assert.deepEqual(unattached.providers.codex.nativeVisibility, {
    verified: false,
    nativeDispatchReady: false,
    evidence: 'desktop-attachment:unattached',
    nextAction: 'run-desktop-attach-ensure',
  });

  const failing = await main([
    '--repo-root', fixture.repoRoot,
    '--target', 'codex',
    '--url', server.url,
  ], fixture.env, {
    desktopAttachment: async () => { throw new Error('lsof exploded'); },
  });
  assert.equal(failing.providers.codex.nativeVisibility.evidence, 'desktop-attachment:toolUnavailable');
  assert.equal(failing.providers.codex.reusable, true);
});

test('doctor maintenance command reuses PATH discovery without an undeclared Claude binding', async (t) => {
  const fixture = createRepoWithSeat(t);
  registerLane(fixture.repoRoot, {
    laneId: 'claude-owned',
    backend: CLAUDE_BACKEND,
    providerId: CLAUDE_SESSION,
    displayName: 'Claude owned lane',
    state: 'active',
  }, fixture.env);
  const claudeCalls = [];
  const result = await main([
    '--repo-root', fixture.repoRoot,
    '--target', 'claude',
  ], { ...fixture.env, PATH: '/opt/homebrew/bin:/usr/bin' }, {
    claudeSurface: fakeClaudeSurface(claudeCalls, [{
      sessionId: CLAUDE_SESSION,
      id: '11111111',
      name: 'owned provider row',
      cwd: fixture.seat,
      startedAt: '2026-09-02T10:00:00.000Z',
    }]),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(claudeCalls[0].options, { claudeBin: undefined });
  assert.deepEqual(result.nextSafeMaintenanceCommands, [{
    provider: 'claude',
    purpose: 'reconcile exact owned Claude lanes without private retirement',
    command: 'node "$SKILL_ROOT/scripts/lane.js" reconcile --repo-root "$REPO_ROOT" --target claude',
    requiredHostBindings: ['SKILL_ROOT', 'REPO_ROOT'],
  }]);
});

test('doctor reports provider unavailability without leaking failure details', async (t) => {
  const fixture = createRepoWithSeat(t);
  const result = await main([
    '--repo-root', fixture.repoRoot,
    '--target', 'claude',
  ], fixture.env, {
    claudeSurface: {
      preflight() {
        const error = new Error('private@example.invalid /Users/private/.claude');
        error.code = 'UNSUPPORTED_ENVIRONMENT';
        throw error;
      },
      run() {
        throw new Error('must not run');
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.providers.claude.available, false);
  assert.deepEqual(result.providers.claude.error, { code: 'UNSUPPORTED_ENVIRONMENT' });
  assert.equal(JSON.stringify(result).includes('private@example.invalid'), false);
  assert.equal(JSON.stringify(result).includes('/Users/private/.claude'), false);
});

test('doctor identifies a sandbox-denied loopback boundary with a fixed next action', async (t) => {
  const fixture = createRepoWithSeat(t);
  const result = await main([
    '--repo-root', fixture.repoRoot,
    '--target', 'codex',
    '--url', 'ws://127.0.0.1:8843',
  ], fixture.env, {
    createAppServerClient() {
      return {
        async connect() {
          const cause = new Error('private sandbox detail');
          cause.code = 'EPERM';
          const error = new Error('private transport detail');
          error.code = 'TRANSPORT_ERROR';
          error.cause = cause;
          throw error;
        },
        close() {},
      };
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.providers.codex.error, {
    code: 'TRANSPORT_ERROR',
    boundary: 'sandbox-loopback-denied',
    nextAction: 'obtain-scoped-host-authorization-or-use-a-full-lifecycle-native-channel',
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('doctor detects but will not recommend reusing an unverified Codex version', async (t) => {
  const fixture = createRepoWithSeat(t);
  registerLane(fixture.repoRoot, {
    laneId: 'codex-owned',
    backend: CODEX_BACKEND,
    providerId: 'thread-private-id',
    displayName: 'Codex private lane',
    state: 'active',
  }, fixture.env);
  const server = await startMockAppServer(undefined, {
    initializeResult: {
      codexHome: '/tmp/private-codex-home',
      platformFamily: 'unix',
      platformOs: 'macos',
      userAgent: 'Codex Desktop/0.148.0 (private suffix)',
    },
  });
  t.after(() => server.close());

  const result = await main([
    '--repo-root', fixture.repoRoot,
    '--target', 'codex',
    '--url', server.url,
  ], fixture.env);

  assert.equal(result.ok, false);
  assert.equal(result.providers.codex.available, true);
  assert.equal(result.providers.codex.reusable, false);
  assert.equal(result.providers.codex.reuse, 'blocked-unverified-runtime');
  assert.deepEqual(result.providers.codex.observed, {
    userAgentFamily: 'Codex Desktop',
    version: '0.148.0',
    pinnedVersionLine: false,
    compatibility: 'failed',
    compatibleMethods: [],
    failingMethod: 'minimum-version',
  });
  assert.equal(result.providers.codex.setup.reason, 'runtime-unsupported');
  assert.equal(result.providers.codex.setup.failingMethod, 'minimum-version');
  assert.deepEqual(result.nextSafeMaintenanceCommands, []);
  assert.equal(JSON.stringify(result).includes('/tmp/private-codex-home'), false);
  assert.equal(JSON.stringify(result).includes('private suffix'), false);
});

test('doctor arguments honor the documented environment fallbacks and reject unsafe values', () => {
  assert.deepEqual(parseDoctorArgs([], {
    REPO_ROOT: '/tmp/repo',
    TRANSMOGRIFY_URL: 'ws://127.0.0.1:9999',
    CLAUDE_BIN: '/tmp/claude',
  }), {
    repoRoot: '/tmp/repo',
    target: 'all',
    url: 'ws://127.0.0.1:9999/',
    claudeBin: '/tmp/claude',
    timeoutMs: 20_000,
    explain: false,
  });
  assert.equal(parseDoctorArgs(['--repo-root', '/tmp/repo', '--explain'], {}).explain, true);
  assert.throws(() => parseDoctorArgs(['--repo-root', 'relative'], {}), /absolute path/);
  assert.throws(() => parseDoctorArgs([
    '--repo-root', '/tmp/repo', '--target', 'other',
  ], {}), /codex, claude, or all/);
  assert.throws(() => parseDoctorArgs([
    '--repo-root', '/tmp/repo', '--claude-bin', 'claude',
  ], {}), /must be an absolute path/);
  assert.throws(() => parseDoctorArgs([
    '--repo-root', '/tmp/repo', '--timeout-ms', '01',
  ], {}), /canonical positive integer/);
  assert.throws(() => parseDoctorArgs([
    '--repo-root', '/tmp/repo', '--url', 'ws://example.com:8843',
  ], {}), /non-loopback/);
  assert.throws(() => parseDoctorArgs([
    '--repo-root', '/tmp/repo', '--target', 'codex', '--claude-bin', '/tmp/claude',
  ], {}), /not valid with --target codex/);
  assert.throws(() => parseDoctorArgs([
    '--repo-root', '/tmp/repo', '--target', 'claude', '--url', 'ws://127.0.0.1:8843',
  ], {}), /not valid with --target claude/);
});

test('doctor explain attaches a plan and renders the four-line TTY summary', async (t) => {
  const fixture = createRepoWithSeat(t);
  const explained = await main([
    '--repo-root', fixture.repoRoot,
    '--target', 'codex',
    '--url', 'ws://127.0.0.1:8843',
    '--explain',
  ], fixture.env, {
    createAppServerClient: () => ({
      verifiedRuntime: true,
      async connect() { return { userAgent: 'codex_cli_rs/0.151.0' }; },
      close() {},
    }),
    desktopAttachment: async () => ({
      attachment: {
        state: 'attached', evidence: 'lsof-established-loopback-connection', clientPid: 1,
        connection: '127.0.0.1:1->127.0.0.1:2', observedAt: '2026-09-03T10:00:00.000Z',
      },
      desktop: { bundleId: 'com.openai.codex', version: '26.901.20858', build: '7658', buildTested: true },
      nextAction: 'none',
    }),
    detectHostContext: () => ({
      app: 'codex-tui', surface: 'terminal',
      platform: { os: 'darwin', arch: 'arm64', claudeLanesSupported: true },
    }),
    measureCodexCompatibility: async () => ({ result: 'good', probes: [] }),
  });
  assert.deepEqual(explained.setup.plan.steps, []);
  assert.match(explained.setup.plan.context, /live streaming shows there/);
  assert.match(renderSetupSummary(explained), /^Found: .+\nReady: .+\nNeeded: .+\nNext: /);
});

test('doctor exposes a non-mutating help entrypoint', async () => {
  const result = await main(['--help'], {}, {
    ensureRegistry() { throw new Error('must not inspect state'); },
  });
  assert.match(result.help, /^usage: doctor\.js/);
});

test('doctor names the owner action for every unmet setup precondition', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer();
  t.after(() => server.close());
  const blocked = await main([
    '--repo-root', fixture.repoRoot,
    '--target', 'all',
    '--url', server.url,
  ], fixture.env, {
    claudeSurface: {
      preflight() {
        const error = new Error('private@example.invalid /Users/private/.claude');
        error.code = 'UNSUPPORTED_ENVIRONMENT';
        error.details = { reason: 'not-logged-in' };
        throw error;
      },
      run() { throw new Error('must not run'); },
    },
    desktopAttachment: async () => ({
      attachment: { state: 'unattached', evidence: 'no-established-connection-to-runtime' },
      desktop: { running: true },
      nextAction: 'run-desktop-attach-ensure',
    }),
  });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.providers.claude.error, { code: 'UNSUPPORTED_ENVIRONMENT' });
  assert.deepEqual(blocked.providers.claude.setup, {
    reason: 'not-logged-in',
    blocking: true,
    ownerAction: 'Run `claude auth login`, then rerun the doctor.',
  });
  assert.equal(blocked.providers.codex.setup.reason, 'desktop-unattached');
  assert.equal(blocked.providers.codex.setup.blocking, false);
  assert.match(blocked.providers.codex.setup.ownerAction, /desktop-attach\.js ensure --relaunch-desktop/);
  assert.deepEqual(blocked.setup, {
    ready: false,
    ownerActions: [
      { provider: 'codex', reason: 'desktop-unattached', blocking: false, ownerAction: blocked.providers.codex.setup.ownerAction },
      { provider: 'claude', reason: 'not-logged-in', blocking: true, ownerAction: 'Run `claude auth login`, then rerun the doctor.' },
    ],
  });
  // An unattached Desktop alone is advisory: Codex lanes stay available
  // protocol-only, so setup is ready.
  const advisory = await main([
    '--repo-root', fixture.repoRoot,
    '--target', 'codex',
    '--url', server.url,
  ], fixture.env, {
    desktopAttachment: async () => ({
      attachment: { state: 'unattached', evidence: 'no-established-connection-to-runtime' },
      desktop: { running: true },
      nextAction: 'run-desktop-attach-ensure',
    }),
  });
  assert.equal(advisory.setup.ready, true);
  assert.equal(advisory.setup.ownerActions.length, 1);
  assert.equal(advisory.setup.ownerActions[0].blocking, false);
  assert.equal(JSON.stringify(blocked).includes('private@example.invalid'), false);
  assert.equal(JSON.stringify(blocked).includes('/Users/private/.claude'), false);

  const unavailable = await main([
    '--repo-root', fixture.repoRoot,
    '--target', 'codex',
    '--url', 'ws://127.0.0.1:65534',
  ], fixture.env, {});
  assert.equal(unavailable.providers.codex.setup.reason, 'runtime-unavailable');
  assert.equal(unavailable.providers.codex.setup.blocking, true);
  assert.equal(unavailable.setup.ready, false);
  assert.match(unavailable.providers.codex.setup.ownerAction, /runtime-up\.sh/);

  const claudeCalls = [];
  const ready = await main([
    '--repo-root', fixture.repoRoot,
    '--target', 'all',
    '--url', server.url,
  ], fixture.env, {
    claudeSurface: fakeClaudeSurface(claudeCalls, []),
    desktopAttachment: async () => ({
      attachment: {
        state: 'attached', evidence: 'lsof-established-loopback-connection', clientPid: 1,
        connection: '127.0.0.1:1->127.0.0.1:2', observedAt: '2026-09-02T22:00:00.000Z',
      },
      desktop: { bundleId: 'com.openai.codex', version: '26.901.20858', build: '7658', buildTested: true },
      nextAction: 'none',
    }),
  });
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.setup, { ready: true, ownerActions: [] });
  assert.equal(ready.providers.claude.setup, undefined);
  assert.equal(ready.providers.codex.setup, undefined);
});

test('doctor distinguishes unsupported and failed-measurement Claude builds without proposing a downgrade', async (t) => {
  const fixture = createRepoWithSeat(t);
  for (const [reason, probe] of [
    ['cli-unsupported', 'minimum-version'],
    ['cli-unmeasured-failed', 'settings-argument'],
  ]) {
    const result = await main([
      '--repo-root', fixture.repoRoot,
      '--target', 'claude',
    ], { ...fixture.env, CLAUDE_CODE_EXECPATH: '/running/claude' }, {
      claudeSurface: {
        preflight() {
          const error = new Error('private build detail');
          error.code = 'UNSUPPORTED_ENVIRONMENT';
          error.details = { reason, probe };
          throw error;
        },
        run() { throw new Error('must not run'); },
      },
    });
    assert.equal(result.providers.claude.setup.reason, reason);
    assert.equal(result.setup.ready, false);
    assert.doesNotMatch(result.providers.claude.setup.ownerAction, /2\.1\.258|downgrade|older/i);
    assert.match(result.providers.claude.setup.ownerAction, /claude install/);
    if (reason === 'cli-unmeasured-failed') {
      assert.equal(result.providers.claude.setup.failingProbe, probe);
      assert.match(result.providers.claude.setup.ownerAction, /settings-argument/);
    }
  }
});

test('doctor reports a supported-version Codex method failure as runtime-unsupported', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/list') {
      return { error: { code: -32601, message: 'method not found' } };
    }
    return { result: {} };
  }, {
    initializeResult: {
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
      userAgent: 'codex_cli_rs/0.155.0',
    },
  });
  t.after(() => server.close());
  const result = await main([
    '--repo-root', fixture.repoRoot,
    '--target', 'codex',
    '--url', server.url,
  ], fixture.env);
  assert.equal(result.providers.codex.available, true);
  assert.equal(result.providers.codex.reusable, false);
  assert.equal(result.providers.codex.setup.reason, 'runtime-unsupported');
  assert.equal(result.providers.codex.setup.failingMethod, 'thread/list');
  assert.match(result.providers.codex.setup.ownerAction, /thread\/list/);
});

test('doctor inventories every distinct Codex CLI candidate using only --version', (t) => {
  const root = fs.mkdtempSync('/tmp/transmogrify-doctor-binaries-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstDir = `${root}/first`;
  const secondDir = `${root}/second`;
  fs.mkdirSync(firstDir);
  fs.mkdirSync(secondDir);
  const first = `${firstDir}/codex`;
  const second = `${secondDir}/codex`;
  fs.writeFileSync(first, '#!/bin/sh\n', { mode: 0o700 });
  fs.writeFileSync(second, '#!/bin/sh\n', { mode: 0o700 });
  const calls = [];
  const binaries = codexCliBinaries({
    PATH: `${firstDir}:${secondDir}`,
    TRANSMOGRIFY_BIN: second,
  }, {
    execFileSync(executable, args) {
      calls.push([executable, args]);
      return executable === fs.realpathSync(first) ? 'codex-cli 0.148.0\n' : 'codex-cli 0.153.0\n';
    },
  });
  assert.deepEqual(binaries.filter((binary) => binary.path.startsWith(fs.realpathSync(root))), [
    { path: fs.realpathSync(first), sources: ['PATH'], version: '0.148.0' },
    { path: fs.realpathSync(second), sources: ['PATH', 'TRANSMOGRIFY_BIN'], version: '0.153.0' },
  ]);
  assert.equal(binaries.some((binary) => binary.sources.includes('codex-desktop')), true);
  assert.equal(calls.every((call) => JSON.stringify(call[1]) === '["--version"]'), true);
});
