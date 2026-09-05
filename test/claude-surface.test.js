'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  BRIDGE_PATTERN,
  MAX_STEER_BYTES,
  MINIMUM_CLI_VERSION,
  PINNED_CLI_SHA256,
  PINNED_CLI_VERSION,
  assertSafeLaneValue,
  assertSafeModelSelector,
  assertUniqueShortJobId,
  canonicalCseId,
  claudeResumeArgs,
  claudeSpawnArgs,
  createClaudeSurface,
  exactOwnedAgent,
  isVerifiedCliBuild,
  parseAgents,
  parseAuthStatus,
  parseJobId,
  parseVersion,
  measuredBuildFile,
  sanitizedClaudeEnv,
  sha256,
} = require('../scripts/lib/claude-surface');

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

test('Claude public-output parsers require exact unambiguous identities', () => {
  assert.equal(parseVersion('2.1.257 (Claude Code)\n'), '2.1.257');
  assert.equal(parseJobId('Started background agent 11111111\n'), '11111111');
  assert.throws(() => parseJobId('11111111 22222222'), /one exact job id/);
  const agents = parseAgents(JSON.stringify([{
    cwd: '/tmp',
    kind: 'background',
    name: '[test] exact',
    pid: 123,
    sessionId: SESSION_ID,
    startedAt: '2026-09-01T19:00:00.000Z',
  }]));
  assert.equal(exactOwnedAgent(agents, {
    sessionId: SESSION_ID,
    jobId: '11111111',
  }, { name: '[test] exact', cwd: '/tmp' }).pid, 123);
  assert.throws(() => exactOwnedAgent(agents, {
    sessionId: SESSION_ID,
    jobId: '22222222',
  }), /job id no longer matches/);
  assert.throws(() => parseAgents('{}'), /did not return an array/);
  assert.equal(parseAgents(JSON.stringify([{
    cwd: '/tmp',
    kind: 'background',
    name: '[test] completed',
    sessionId: SESSION_ID,
    id: '11111111',
    startedAt: 1788290000000,
  }]))[0].pid, null);

  const collision = '11111111-2222-4222-8222-222222222222';
  const collidingRows = parseAgents(JSON.stringify([
    {
      cwd: '/tmp', name: '[test] exact', sessionId: SESSION_ID,
      startedAt: 1788290000000,
    },
    {
      cwd: '/tmp/foreign', name: '[foreign]', sessionId: collision,
      startedAt: 1788290000001,
    },
  ]));
  assert.throws(() => assertUniqueShortJobId(collidingRows, {
    sessionId: SESSION_ID,
    jobId: '11111111',
  }), /short job id is not unique/);
  assert.throws(() => exactOwnedAgent(collidingRows, {
    sessionId: SESSION_ID,
    jobId: '11111111',
  }), /short job id is not unique/);
});

test('Claude agent listing tolerates foreign schema drift but validates the exact owned row', () => {
  const rows = parseAgents(JSON.stringify([
    null,
    { sessionId: 'not-a-session', future: true },
    {
      sessionId: '22222222-2222-4222-8222-222222222222',
      future: { schema: 'unknown' },
    },
    {
      cwd: '/tmp', name: 'owned', sessionId: SESSION_ID,
      startedAt: 1788290000000,
    },
  ]));
  assert.equal(rows.length, 3);
  assert.equal(exactOwnedAgent(rows, {
    sessionId: SESSION_ID,
    jobId: '11111111',
  }).name, 'owned');
  assert.throws(() => exactOwnedAgent(rows, {
    sessionId: '22222222-2222-4222-8222-222222222222',
    jobId: '22222222',
  }), /exact owned Claude agent row is invalid/);
  assert.throws(() => exactOwnedAgent([...rows, { id: '11111111' }], {
    sessionId: SESSION_ID,
    jobId: '11111111',
  }), /short job id is not unique/);
});

test('Claude bridge and lane helpers reject hostile values and canonicalize sessions API ids', () => {
  assert.equal(BRIDGE_PATTERN.test('session_abcDEF123'), true);
  assert.equal(BRIDGE_PATTERN.test('cse_staging_abc123'), true);
  assert.equal(canonicalCseId('session_abcDEF123'), 'cse_abcDEF123');
  assert.equal(canonicalCseId('cse_staging_abc123'), 'cse_staging_abc123');
  for (const invalid of [
    'session_', 'session_a-b', 'session_a_b', 'session_%2F', 'session_staging_',
    `session_${'a'.repeat(65)}`,
  ]) {
    assert.equal(BRIDGE_PATTERN.test(invalid), false, invalid);
    assert.throws(() => canonicalCseId(invalid), /invalid Claude bridge id/);
  }
  assert.equal(assertSafeLaneValue('::: safe'), '::: safe');
  assert.deepEqual(claudeSpawnArgs('::: safe', 'do work'), [
    '--bg', '--name', '::: safe', '--remote-control', '::: safe', 'do work',
  ]);
  assert.deepEqual(claudeSpawnArgs('::: safe', 'do work', { model: 'claude-opus-5' }), [
    '--bg', '--name', '::: safe', '--remote-control', '::: safe',
    '--model', 'claude-opus-5', 'do work',
  ]);
  assert.deepEqual(claudeSpawnArgs('::: safe', 'do work', {
    model: 'claude-opus-5', effort: 'max', fastMode: true,
  }), [
    '--bg', '--name', '::: safe', '--remote-control', '::: safe',
    '--model', 'claude-opus-5', '--effort', 'max',
    '--settings', '{"fastMode":true}', 'do work',
  ]);
  assert.deepEqual(claudeResumeArgs(SESSION_ID, {
    model: 'claude-sonnet-5', effort: 'medium', fastMode: false,
  }), [
    '--resume', SESSION_ID, '--bg', '--model', 'claude-sonnet-5',
    '--effort', 'medium', '--settings', '{"fastMode":false}',
  ]);
  assert.deepEqual(claudeResumeArgs(SESSION_ID, {
    model: 'claude-opus-5', effort: 'ultracode', fastMode: false,
  }), [
    '--resume', SESSION_ID, '--bg', '--model', 'claude-opus-5',
    '--effort', 'ultracode', '--settings', '{"fastMode":false}',
  ]);
  assert.throws(() => claudeSpawnArgs('::: safe', 'do work', { effort: 'ultra' }),
    /effort is not supported/);
  for (const invalid of ['', '--opus', 'opus 5', 'opus[1m]', `x${'y'.repeat(128)}`]) {
    assert.throws(() => assertSafeModelSelector(invalid), /model must be/);
  }
  for (const hostile of ['--option', 'line\nbreak', 'nul\0byte', '']) {
    assert.throws(() => assertSafeLaneValue(hostile), /single-line text|must begin with/);
  }
  assert.throws(() => claudeSpawnArgs('safe', 'do work'), /must begin with/);
  assert.throws(() => claudeSpawnArgs('::: safe', '--danger'), /cannot begin with -/);
});

test('Claude auth parsing and child environment exclude ambient Claude credentials and session state', () => {
  const status = parseAuthStatus(JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    projectsDirectory: '/tmp/.claude/projects',
    orgId: 'org-test',
    email: 'test@example.invalid',
  }));
  assert.equal(status.orgId, 'org-test');
  assert.throws(() => parseAuthStatus(JSON.stringify({
    ...status,
    authMethod: 'apiKey',
  })), /first-party claude.ai OAuth/);
  const clean = sanitizedClaudeEnv({
    HOME: '/Users/test',
    PATH: '/bin',
    TMPDIR: '/tmp',
    AWS_SECRET_ACCESS_KEY: 'secret',
    NODE_OPTIONS: '--require=/tmp/hostile.js',
    HTTPS_PROXY: 'https://credential@example.invalid',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    CLAUDE_CODE_SESSION_ID: 'foreign',
    ANTHROPIC_API_KEY: 'secret',
  });
  assert.deepEqual(clean, {
    HOME: '/Users/test', PATH: '/bin', TMPDIR: '/tmp', DISABLE_UPDATES: '1',
  });
});

test('Claude CLI discovery classifies absence and permission failures without hiding other errors', (t) => {
  const env = { PATH: '/empty' };
  const whichMissing = createClaudeSurface({
    platform: 'darwin', arch: 'arm64',
    execFileSync() {
      const error = new Error('not found');
      error.status = 1;
      throw error;
    },
  });
  assert.throws(() => whichMissing.preflight({}, env), (error) =>
    error.code === 'UNSUPPORTED_ENVIRONMENT' && error.details.reason === 'cli-not-found');

  const permissionDenied = createClaudeSurface({
    platform: 'darwin', arch: 'arm64',
    execFileSync() {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    },
  });
  assert.throws(() => permissionDenied.preflight({}, env), (error) =>
    error.code === 'UNSUPPORTED_ENVIRONMENT' && error.details.reason === 'cli-not-executable');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-claude-permissions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nonExecutable = path.join(root, 'claude');
  fs.writeFileSync(nonExecutable, '#!/bin/sh\n', { mode: 0o600 });
  assert.throws(
    () => createClaudeSurface({ platform: 'darwin', arch: 'arm64' }).preflight(
      { claudeBin: nonExecutable }, env,
    ),
    (error) => error.code === 'UNSUPPORTED_ENVIRONMENT' &&
      error.details.reason === 'cli-not-executable',
  );

  const unexpected = createClaudeSurface({
    platform: 'darwin', arch: 'arm64',
    execFileSync() {
      const error = new Error('timed out');
      error.code = 'ETIMEDOUT';
      throw error;
    },
  });
  assert.throws(() => unexpected.preflight({}, env), (error) => error.code === 'ETIMEDOUT');

  assert.throws(
    () => createClaudeSurface({ platform: 'darwin', arch: 'arm64' }).preflight(
      { claudeBin: path.join(os.tmpdir(), 'missing-claude-cli') }, env,
    ),
    (error) => error.code === 'UNSUPPORTED_ENVIRONMENT' && error.details.reason === 'cli-not-found',
  );
});

test('Claude preflight pins platform, CLI identity, default config, and account fingerprint', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-claude-surface-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, 'claude');
  const projects = path.join(root, '.claude', 'projects');
  fs.writeFileSync(cli, '#!/bin/sh\n', { mode: 0o700 });
  fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
  const calls = [];
  const surface = createClaudeSurface({
    platform: 'darwin',
    arch: 'arm64',
    sha256File: () => PINNED_CLI_SHA256,
    execFileSync(executable, args) {
      calls.push([executable, args]);
      if (args[0] === '--version') return `${PINNED_CLI_VERSION} (Claude Code)\n`;
      if (args[0] === 'auth') return JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        projectsDirectory: projects,
        orgId: 'org-test',
        email: 'test@example.invalid',
      });
      throw new Error('unexpected command');
    },
  });
  const env = { PATH: '/bin', TRANSMOGRIFY_STATE_DIR: path.join(root, 'state') };
  const runtime = surface.preflight({ claudeBin: cli }, env);
  assert.equal(runtime.cliPath, fs.realpathSync(cli));
  assert.equal(runtime.cliSha256, PINNED_CLI_SHA256);
  assert.equal(runtime.cliVersion, PINNED_CLI_VERSION);
  assert.equal(runtime.configDevice, fs.statSync(path.dirname(projects)).dev);
  assert.equal(runtime.configInode, fs.statSync(path.dirname(projects)).ino);
  assert.equal(runtime.projectsDevice, fs.statSync(projects).dev);
  assert.equal(runtime.projectsInode, fs.statSync(projects).ino);
  assert.equal(runtime.accountFingerprint.length, 64);
  const measurement = measuredBuildFile(PINNED_CLI_SHA256, env);
  assert.equal(fs.statSync(measurement).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(measurement, 'utf8')).source, 'verified-build-fast-path');
  assert.deepEqual(calls.map((entry) => entry[1]), [
    ['--version'],
    ['auth', 'status', '--json'],
  ]);
  assert.throws(() => surface.preflight({ claudeBin: cli }, {
    PATH: '/bin',
    CLAUDE_CONFIG_DIR: '/tmp/alternate',
  }), /custom CLAUDE_CONFIG_DIR/);

  fs.chmodSync(projects, 0o777);
  assert.throws(
    () => surface.preflight({ claudeBin: cli }, env),
    /Claude projects directory is not owner-controlled/,
  );
  fs.chmodSync(projects, 0o700);
  fs.chmodSync(path.dirname(projects), 0o777);
  assert.throws(
    () => surface.preflight({ claudeBin: cli }, env),
    /Claude config directory is not owner-controlled/,
  );
});

test('Claude preflight records truthful option checks, refreshes stale labels, and reuses its cache', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-claude-measure-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, 'claude');
  const projects = path.join(root, '.claude', 'projects');
  const state = path.join(root, 'state');
  fs.writeFileSync(cli, '#!/bin/sh\n', { mode: 0o700 });
  fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
  const digest = 'a'.repeat(64);
  const calls = [];
  const auth = JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    projectsDirectory: projects,
    orgId: 'org-test',
    email: 'test@example.invalid',
  });
  const surface = createClaudeSurface({
    platform: 'darwin',
    arch: 'arm64',
    sha256File: () => digest,
    execFileSync(_executable, args) {
      calls.push(args);
      if (args[0] === '--version') return '2.1.259 (Claude Code)\n';
      if (args[0] === 'auth') return auth;
      if (args[0] === 'agents') return '[]';
      if (args.includes('--help')) return '--settings <json> --cloud <session> --output-format <format>\n';
      throw new Error('unexpected command');
    },
  });
  const env = { PATH: '/bin', TRANSMOGRIFY_STATE_DIR: state };
  const first = surface.preflight({ claudeBin: cli }, env);
  assert.equal(first.cliVersion, '2.1.259');
  assert.equal(first.cliMeasurement.source, 'vendor-observations-and-option-checks');
  assert.deepEqual(calls.map((args) => args[0]), [
    '--version', '--version', 'auth', 'agents', '--settings', '-p', 'auth',
  ]);
  const recordPath = measuredBuildFile(digest, env);
  assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600);
  const measurement = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  assert.equal(measurement.result, 'good');
  assert.equal(measurement.probes.at(-1).name, 'follow-up-options');
  assert.equal(isVerifiedCliBuild('2.1.259', digest, {
    cliPath: fs.realpathSync(cli), env,
  }), true);

  fs.writeFileSync(recordPath, JSON.stringify({
    ...measurement,
    source: 'live-probe',
    probes: measurement.probes.map((probe) => probe.name === 'follow-up-options'
      ? { ...probe, name: 'follow-up-acknowledgment' }
      : probe),
  }));
  const beforeRefresh = calls.length;
  surface.preflight({ claudeBin: cli }, env);
  assert.deepEqual(calls.slice(beforeRefresh).map((args) => args[0]), [
    '--version', '--version', 'auth', 'agents', '--settings', '-p', 'auth',
  ]);
  assert.equal(
    JSON.parse(fs.readFileSync(recordPath, 'utf8')).source,
    'vendor-observations-and-option-checks',
  );

  const beforeReuse = calls.length;
  surface.preflight({ claudeBin: cli }, env);
  assert.deepEqual(calls.slice(beforeReuse).map((args) => args[0]), ['--version', 'auth']);
});

test('Claude preflight rejects below-minimum builds and names a cached failed probe', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-claude-measure-fail-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, 'claude');
  const state = path.join(root, 'state');
  fs.writeFileSync(cli, '#!/bin/sh\n', { mode: 0o700 });
  const env = { PATH: '/bin', TRANSMOGRIFY_STATE_DIR: state };
  let version = '2.1.257';
  const digest = 'c'.repeat(64);
  const calls = [];
  const surface = createClaudeSurface({
    platform: 'darwin', arch: 'arm64', sha256File: () => digest,
    execFileSync(_executable, args) {
      calls.push(args);
      if (args[0] === '--version') return `${version} (Claude Code)\n`;
      if (args[0] === 'auth') return '{"loggedIn":false}';
      if (args[0] === 'agents') return '[]';
      if (args[0] === '--settings') return 'no compatible option here';
      throw new Error('unexpected command');
    },
  });
  assert.throws(() => surface.preflight({ claudeBin: cli }, env),
    (error) => error.details.reason === 'cli-unsupported' &&
      error.details.probe === 'minimum-version');
  assert.equal(MINIMUM_CLI_VERSION, '2.1.258');

  version = '2.1.260';
  assert.throws(() => surface.preflight({ claudeBin: cli }, env),
    (error) => error.details.reason === 'cli-unmeasured-failed' &&
      error.details.probe === 'settings-argument');
  const afterFailure = calls.length;
  assert.throws(() => surface.preflight({ claudeBin: cli }, env),
    (error) => error.details.reason === 'cli-unmeasured-failed' &&
      error.details.probe === 'settings-argument');
  assert.equal(calls.length, afterFailure + 1, 'only --version runs before the failed cache is reused');
});

test('Claude worker verification shares one shrinking subprocess deadline', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-claude-deadline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, 'claude');
  const configDir = path.join(root, 'config');
  const sessionsDir = path.join(configDir, 'sessions');
  const socketPath = `/tmp/cc-socks/43210.sock`;
  fs.writeFileSync(cli, '#!/bin/sh\n', { mode: 0o700 });
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const pid = 43210;
  fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({
    pid,
    sessionId: SESSION_ID,
    jobId: '11111111',
    bridgeSessionId: 'session_testBridge',
    name: '::: deadline lane',
    cwd: root,
    messagingSocketPath: socketPath,
    version: PINNED_CLI_VERSION,
  }), { mode: 0o600 });
  const subprocessTimeouts = [];
  const surface = createClaudeSurface({
    sha256File: () => PINNED_CLI_SHA256,
    processBirth(_pid, options) {
      subprocessTimeouts.push(options.timeoutMs);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      return 'birth';
    },
    execFileSync(executable, _args, options) {
      assert.equal(executable, '/usr/sbin/lsof');
      subprocessTimeouts.push(options.timeout);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      return `n${cli}\n`;
    },
    socketReceipt(requested) {
      assert.equal(requested, socketPath);
      return { path: requested, device: 1, inode: 2, uid: 501, mode: 0o600 };
    },
  });
  const receipt = surface.executionReceipt({
    configDir,
    cliSha256: PINNED_CLI_SHA256,
    cliVersion: PINNED_CLI_VERSION,
    cleanEnv: { PATH: '/usr/bin:/bin' },
  }, {
    displayName: '::: deadline lane',
    seat: { path: root },
    providerIdentity: {
      sessionId: SESSION_ID,
      jobId: '11111111',
      bridgeId: 'session_testBridge',
    },
  }, { pid }, { timeoutMs: 100 });
  assert.equal(receipt.processBirth, 'birth');
  assert.equal(subprocessTimeouts.length, 3);
  assert.ok(subprocessTimeouts[0] <= 100);
  assert.ok(subprocessTimeouts[1] < subprocessTimeouts[0]);
  assert.ok(subprocessTimeouts[2] < subprocessTimeouts[1]);
});

test('Claude public follow-up uses stdin and validates the exact machine-readable bridge acknowledgment', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-claude-followup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, 'claude');
  fs.writeFileSync(cli, [
    `#!${process.execPath}`,
    "'use strict';",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  const args = process.argv.slice(2);",
    "  const exact = JSON.stringify(args) === JSON.stringify(['-p', '--cloud', 'cse_testBridge', '--output-format', 'json']);",
    "  if (!exact || input !== 'directed follow-up' || args.includes(input)) process.exit(4);",
    "  process.stdout.write(JSON.stringify({ ok: true, session_id: 'cse_testBridge', url: 'https://claude.ai/code/session_testBridge?from=cli&m=0' }));",
    "});",
    '',
  ].join('\n'), { mode: 0o700 });
  const surface = createClaudeSurface();
  const receipt = await surface.sendRemoteFollowup({
    cliPath: fs.realpathSync(cli),
    cliSha256: sha256(fs.readFileSync(cli)),
    cleanEnv: { PATH: process.env.PATH || '/usr/bin:/bin' },
  }, 'session_testBridge', 'directed follow-up', { cwd: root, timeoutMs: 5000 });
  assert.equal(receipt.queued, true);
  assert.equal(receipt.channel, 'publicCloudFollowup');
  assert.equal(receipt.sessionIdSha256, sha256('cse_testBridge'));
});

test('Claude public follow-up fails closed for non-exact acknowledgments and process failures', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-claude-followup-errors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exact = { ok: true, session_id: 'cse_testBridge', url: 'https://claude.ai/code/cse_testBridge' };
  const cases = [
    ['malformed', "process.stdout.write('{');"],
    ['wrong-bridge', `process.stdout.write(JSON.stringify(${JSON.stringify({ ...exact, session_id: 'cse_foreign' })}));`],
    ['alias-bridge', `process.stdout.write(JSON.stringify(${JSON.stringify({ ...exact, session_id: 'session_testBridge' })}));`],
    ['foreign-url', `process.stdout.write(JSON.stringify(${JSON.stringify({ ...exact, url: 'https://claude.ai/code/cse_foreign?from=cli' })}));`],
    ['foreign-host', `process.stdout.write(JSON.stringify(${JSON.stringify({ ...exact, url: 'https://example.com/code/cse_testBridge' })}));`],
    ['extra-field', `process.stdout.write(JSON.stringify(${JSON.stringify({ ...exact, extra: true })}));`],
    ['negative', `process.stdout.write(JSON.stringify(${JSON.stringify({ ...exact, ok: false })}));`],
    ['nonzero', `process.stdout.write(JSON.stringify(${JSON.stringify(exact)})); process.exitCode = 2;`],
    ['stderr', `process.stderr.write('warning'); process.stdout.write(JSON.stringify(${JSON.stringify(exact)}));`],
    ['overflow', `process.stdout.write('x'.repeat(${MAX_STEER_BYTES + 1}));`],
  ];
  const surface = createClaudeSurface();
  for (const [name, body] of cases) {
    const cli = path.join(root, name);
    fs.writeFileSync(cli, `#!${process.execPath}\n'use strict';\n${body}\n`, { mode: 0o700 });
    await assert.rejects(() => surface.sendRemoteFollowup({
      cliPath: fs.realpathSync(cli),
      cliSha256: sha256(fs.readFileSync(cli)),
      cleanEnv: { PATH: process.env.PATH || '/usr/bin:/bin' },
    }, 'session_testBridge', 'directed follow-up', { cwd: root, timeoutMs: 5000 }),
    (error) => error.code === 'DELIVERY_UNCERTAIN', name);
  }

  const hanging = path.join(root, 'hanging');
  fs.writeFileSync(hanging, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  await assert.rejects(() => surface.sendRemoteFollowup({
    cliPath: fs.realpathSync(hanging),
    cliSha256: sha256(fs.readFileSync(hanging)),
    cleanEnv: { PATH: process.env.PATH || '/usr/bin:/bin' },
  }, 'session_testBridge', 'directed follow-up', { cwd: root, timeoutMs: 150 }),
  (error) => error.code === 'DELIVERY_UNCERTAIN');

  await assert.rejects(() => surface.sendRemoteFollowup({
    cliPath: path.join(root, 'missing'),
    cliSha256: '0'.repeat(64),
    cleanEnv: { PATH: process.env.PATH || '/usr/bin:/bin' },
  }, 'session_testBridge', 'directed follow-up', { cwd: root, timeoutMs: 5000 }),
  (error) => error.code === 'RUNTIME_MISMATCH');
});

test('Claude public mutation rechecks the exact CLI content immediately before spawn', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-claude-cli-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, 'claude');
  fs.writeFileSync(cli, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const cliSha256 = sha256(fs.readFileSync(cli));
  fs.writeFileSync(cli, '#!/bin/sh\nexit 7\n', { mode: 0o700 });
  let spawned = false;
  const surface = createClaudeSurface({ spawn() { spawned = true; } });
  await assert.rejects(() => surface.sendRemoteFollowup({
    cliPath: fs.realpathSync(cli),
    cliSha256,
    cleanEnv: { PATH: process.env.PATH || '/usr/bin:/bin' },
  }, 'session_testBridge', 'directed follow-up', { cwd: root, timeoutMs: 5000 }),
  (error) => error.code === 'RUNTIME_MISMATCH');
  assert.equal(spawned, false);
});

test('Claude public follow-up rejects invalid text before starting a process', async () => {
  const surface = createClaudeSurface({
    spawn() { throw new Error('must not spawn'); },
  });
  await assert.rejects(() => surface.sendRemoteFollowup({
    cliPath: '/tmp/not-used', cleanEnv: {},
  }, 'session_testBridge', `x${String.fromCharCode(0xD800)}`),
  (error) => error.code === 'USAGE_ERROR');
});

function transcriptFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-claude-transcript-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const nested = path.join(projects, 'repo');
  fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
  const transcript = path.join(nested, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'system', subtype: 'init' })}\n`, { mode: 0o600 });
  return {
    projects,
    transcript,
    runtime: { projectsDirectory: projects },
  };
}

test('Claude delivery reconciliation finds a content-free exact marker receipt without replay', (t) => {
  const fixture = transcriptFixture(t);
  const surface = createClaudeSurface();
  const token = '22222222-2222-4222-8222-222222222222';
  const message = 'Apply the exact constraint.';
  const framed = `${message}\n\n[transmogrify delivery ${token}]`;
  fs.appendFileSync(fixture.transcript, `${JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: '2026-09-01T20:00:00.000Z',
    sessionId: SESSION_ID,
    content: framed,
  })}\n`);
  const receipt = surface.verifyDeliveryTranscript(fixture.runtime, SESSION_ID, {
    messageSha256: require('node:crypto').createHash('sha256').update(message).digest('hex'),
    deliveryToken: token,
  });
  assert.equal(receipt.state, 'queuedObserved');
  assert.equal(Object.hasOwn(receipt, 'deliveryToken'), false);
  assert.throws(() => surface.verifyDeliveryTranscript(fixture.runtime, SESSION_ID, {
    messageSha256: '0'.repeat(64),
    deliveryToken: token,
  }), /not uniquely receipted/);
});

test('Claude spawn attribution requires one exact prompt and nonce marker transcript receipt', (t) => {
  const fixture = transcriptFixture(t);
  const surface = createClaudeSurface();
  const spawnNonce = '22222222-2222-4222-8222-222222222222';
  const prompt = 'perform exact task';
  const marker = `[transmogrify spawn ${spawnNonce}]`;
  fs.appendFileSync(fixture.transcript, `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: `${prompt}\n\n${marker}` },
  })}\n`);
  const receipt = surface.verifySpawnTranscript(fixture.runtime, SESSION_ID, {
    promptSha256: sha256(prompt),
    promptMarkerSha256: sha256(marker),
    spawnNonce,
  });
  assert.equal(receipt.state, 'spawnPromptObserved');
  assert.equal(receipt.promptSha256, sha256(prompt));
  assert.equal(Object.hasOwn(receipt, 'content'), false);
  assert.throws(() => surface.verifySpawnTranscript(fixture.runtime, SESSION_ID, {
    promptSha256: sha256('different'),
    promptMarkerSha256: sha256(marker),
    spawnNonce,
  }), /not receipted in the transcript yet/);
});

test('Claude worker metadata without a Remote Control bridge is reported as REMOTE_CONTROL_UNAVAILABLE', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-claude-nobridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config');
  const sessionsDir = path.join(configDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const pid = 43211;
  const metadata = {
    pid, sessionId: SESSION_ID, jobId: '11111111', name: '::: unbridged lane', cwd: root,
    messagingSocketPath: `/tmp/cc-socks/${pid}.sock`, version: PINNED_CLI_VERSION,
  };
  fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify(metadata), { mode: 0o600 });
  const surface = createClaudeSurface({
    sha256File: () => PINNED_CLI_SHA256,
    processBirth() { throw new Error('must not reach process inspection'); },
    execFileSync() { throw new Error('must not reach lsof'); },
  });
  const runtime = {
    configDir, cliSha256: PINNED_CLI_SHA256, cliVersion: PINNED_CLI_VERSION, cleanEnv: { PATH: '/usr/bin:/bin' },
  };
  const expected = { sessionId: SESSION_ID, jobId: '11111111', name: '::: unbridged lane', cwd: root };
  assert.throws(
    () => surface.discoverExecution(runtime, expected, { pid }, { timeoutMs: 100 }),
    (error) => error.code === 'REMOTE_CONTROL_UNAVAILABLE' && /claude auth status/.test(error.message),
  );
  // A retired `bridgeId` field is shape drift, not a missing bridge.
  fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({
    ...metadata, bridgeId: 'session_old',
  }), { mode: 0o600 });
  assert.throws(
    () => surface.discoverExecution(runtime, expected, { pid }, { timeoutMs: 100 }),
    (error) => error.code === 'PROTOCOL_ERROR',
  );
});

test('Claude preflight failures carry a setup reason for the doctor', () => {
  assert.throws(
    () => parseAuthStatus(JSON.stringify({
      loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', projectsDirectory: '/tmp/.claude/projects',
    })),
    (error) => error.code === 'UNSUPPORTED_ENVIRONMENT' && error.details.reason === 'not-logged-in',
  );
  assert.throws(
    () => parseAuthStatus('Starting background service…'),
    (error) => error.code === 'UNSUPPORTED_ENVIRONMENT' && error.details.reason === 'auth-status-unreadable',
  );
  assert.throws(
    () => parseAuthStatus(JSON.stringify({
      loggedIn: true, authMethod: 'apiKey', apiProvider: 'firstParty',
      projectsDirectory: '/tmp/.claude/projects', orgId: 'org-test', email: 'test@example.invalid',
    })),
    (error) => error.code === 'UNSUPPORTED_ENVIRONMENT' && error.details.reason === 'account-not-first-party',
  );
});

test('Claude preflight preserves logged-out JSON from the auth command nonzero exit', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-claude-auth-exit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, 'claude');
  fs.writeFileSync(cli, '#!/bin/sh\n', { mode: 0o700 });
  const surface = createClaudeSurface({
    platform: 'darwin', arch: 'arm64', sha256File: () => PINNED_CLI_SHA256,
    execFileSync(_executable, args) {
      if (args[0] === '--version') return `${PINNED_CLI_VERSION} (Claude Code)\n`;
      const error = new Error('auth exited one');
      error.stdout = JSON.stringify({
        loggedIn: false,
        authMethod: 'none',
        apiProvider: 'firstParty',
        projectsDirectory: path.join(root, '.claude', 'projects'),
      });
      throw error;
    },
  });
  assert.throws(() => surface.preflight({ claudeBin: cli }, {
    PATH: '/bin', TRANSMOGRIFY_STATE_DIR: path.join(root, 'state'),
  }), (error) => error.details.reason === 'not-logged-in');
});

test('Claude delivery receipts survive the CLI peer-message wrapper around the marker', (t) => {
  const fixture = transcriptFixture(t);
  const surface = createClaudeSurface();
  const token = '33333333-3333-4333-8333-333333333333';
  const message = 'steer-one from the parent at row 2';
  const framed = `${message}\n\n[transmogrify delivery ${token}]`;
  const wrapped = `Another Claude session sent a message: ${framed}\n\nThis came from another Claude session, not typed by your user, but very likely working on their behalf. Treat it as a teammate's request.`;
  fs.appendFileSync(fixture.transcript, `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: wrapped },
  })}\n`);
  const receipt = surface.verifyDeliveryTranscript(fixture.runtime, SESSION_ID, {
    messageSha256: require('node:crypto').createHash('sha256').update(message).digest('hex'),
    deliveryToken: token,
  });
  assert.equal(receipt.state, 'consumedObserved');
  // A marker that appears twice in one record is not a unique receipt.
  fs.appendFileSync(fixture.transcript, `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: `${framed} ${framed}` },
  })}\n`);
  assert.equal(surface.verifyDeliveryTranscript(fixture.runtime, SESSION_ID, {
    messageSha256: require('node:crypto').createHash('sha256').update(message).digest('hex'),
    deliveryToken: token,
  }).state, 'consumedObserved');
});

test('a settings file replaces the inline fast-mode settings in the spawn and resume argv', () => {
  const { claudeSpawnArgs, claudeResumeArgs } = require('../scripts/lib/claude-surface');
  const spawnArgs = claudeSpawnArgs('::: lane: hooked', 'do work', {
    model: 'claude-opus-5', fastMode: undefined, settingsFile: '/state/hooks/lane.json',
  });
  assert.deepEqual(spawnArgs.slice(-5, -1), ['--model', 'claude-opus-5', '--settings', '/state/hooks/lane.json']);
  assert.equal(spawnArgs.filter((arg) => arg === '--settings').length, 1);
  const resumeArgs = claudeResumeArgs('11111111-1111-4111-8111-111111111111', {
    fastMode: true, settingsFile: '/state/hooks/lane.json',
  });
  assert.ok(resumeArgs.includes('/state/hooks/lane.json'));
  assert.equal(resumeArgs.includes('{"fastMode":true}'), false, 'the file carries the pin instead');
  assert.throws(() => claudeSpawnArgs('::: lane: hooked', 'do work', { settingsFile: 'relative.json' }),
    (error) => error.code === 'USAGE_ERROR');
});
