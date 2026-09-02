'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  BRIDGE_PATTERN,
  MAX_STEER_BYTES,
  PINNED_CLI_SHA256,
  PINNED_CLI_VERSION,
  assertSafeLaneValue,
  assertSafeModelSelector,
  assertUniqueShortJobId,
  canonicalCseId,
  claudeSpawnArgs,
  createClaudeSurface,
  exactOwnedAgent,
  parseAgents,
  parseAuthStatus,
  parseJobId,
  parseVersion,
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
  assert.equal(assertSafeLaneValue('[maint] safe'), '[maint] safe');
  assert.deepEqual(claudeSpawnArgs('safe', 'do work'), [
    '--bg', '--name', 'safe', '--remote-control', 'safe', 'do work',
  ]);
  assert.deepEqual(claudeSpawnArgs('safe', 'do work', { model: 'claude-opus-5' }), [
    '--bg', '--name', 'safe', '--remote-control', 'safe',
    '--model', 'claude-opus-5', 'do work',
  ]);
  for (const invalid of ['', '--opus', 'opus 5', 'opus[1m]', `x${'y'.repeat(128)}`]) {
    assert.throws(() => assertSafeModelSelector(invalid), /model must be/);
  }
  for (const hostile of ['--option', 'line\nbreak', 'nul\0byte', '']) {
    assert.throws(() => assertSafeLaneValue(hostile), /single-line text/);
  }
  assert.throws(() => claudeSpawnArgs('safe', '--danger'), /cannot begin with -/);
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

test('Claude preflight pins platform, CLI hash/version, default config, and account fingerprint', (t) => {
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
  const runtime = surface.preflight({ claudeBin: cli }, { PATH: '/bin' });
  assert.equal(runtime.cliPath, fs.realpathSync(cli));
  assert.equal(runtime.cliSha256, PINNED_CLI_SHA256);
  assert.equal(runtime.cliVersion, PINNED_CLI_VERSION);
  assert.equal(runtime.configDevice, fs.statSync(path.dirname(projects)).dev);
  assert.equal(runtime.configInode, fs.statSync(path.dirname(projects)).ino);
  assert.equal(runtime.projectsDevice, fs.statSync(projects).dev);
  assert.equal(runtime.projectsInode, fs.statSync(projects).ino);
  assert.equal(runtime.accountFingerprint.length, 64);
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
    () => surface.preflight({ claudeBin: cli }, { PATH: '/bin' }),
    /Claude projects directory is not owner-controlled/,
  );
  fs.chmodSync(projects, 0o700);
  fs.chmodSync(path.dirname(projects), 0o777);
  assert.throws(
    () => surface.preflight({ claudeBin: cli }, { PATH: '/bin' }),
    /Claude config directory is not owner-controlled/,
  );
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
    "  process.stdout.write(JSON.stringify({ ok: true, session_id: 'cse_testBridge', url: 'https://claude.ai/code/cse_testBridge' }));",
    "});",
    '',
  ].join('\n'), { mode: 0o700 });
  const surface = createClaudeSurface();
  const receipt = await surface.sendRemoteFollowup({
    cliPath: cli,
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
      cliPath: cli,
      cleanEnv: { PATH: process.env.PATH || '/usr/bin:/bin' },
    }, 'session_testBridge', 'directed follow-up', { cwd: root, timeoutMs: 5000 }),
    (error) => error.code === 'DELIVERY_UNCERTAIN', name);
  }

  const hanging = path.join(root, 'hanging');
  fs.writeFileSync(hanging, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  await assert.rejects(() => surface.sendRemoteFollowup({
    cliPath: hanging,
    cleanEnv: { PATH: process.env.PATH || '/usr/bin:/bin' },
  }, 'session_testBridge', 'directed follow-up', { cwd: root, timeoutMs: 150 }),
  (error) => error.code === 'DELIVERY_UNCERTAIN');

  await assert.rejects(() => surface.sendRemoteFollowup({
    cliPath: path.join(root, 'missing'),
    cleanEnv: { PATH: process.env.PATH || '/usr/bin:/bin' },
  }, 'session_testBridge', 'directed follow-up', { cwd: root, timeoutMs: 5000 }),
  (error) => error.code === 'NOT_DELIVERED');
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

test('Claude transcript receipt observes exact queue enqueue and later user consumption shapes', async (t) => {
  const fixture = transcriptFixture(t);
  const surface = createClaudeSurface();
  const content = 'steer me\n\n[transmogrify delivery 11111111-1111-4111-8111-111111111111]';

  let snapshot = surface.transcriptSnapshot(fixture.runtime, SESSION_ID);
  fs.appendFileSync(fixture.transcript, `${JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: '2026-09-01T19:00:00.000Z',
    sessionId: SESSION_ID,
    content,
  })}\n`);
  assert.equal((await surface.waitForTranscriptDelivery(snapshot, content, 500)).state, 'queuedObserved');

  snapshot = surface.transcriptSnapshot(fixture.runtime, SESSION_ID);
  fs.appendFileSync(fixture.transcript, `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
  })}\n`);
  assert.equal((await surface.waitForTranscriptDelivery(snapshot, content, 500)).state, 'consumedObserved');
});

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

test('Claude transcript receipt rejects replacement after snapshot', async (t) => {
  const fixture = transcriptFixture(t);
  const surface = createClaudeSurface();
  const snapshot = surface.transcriptSnapshot(fixture.runtime, SESSION_ID);
  fs.renameSync(fixture.transcript, `${fixture.transcript}.old`);
  fs.writeFileSync(fixture.transcript, `${JSON.stringify({
    type: 'queue-operation', operation: 'enqueue', timestamp: 'now',
    sessionId: SESSION_ID, content: 'message',
  })}\n`, { mode: 0o600 });
  await assert.rejects(
    () => surface.waitForTranscriptDelivery(snapshot, 'message', 200),
    /transcript identity changed/,
  );
});

test('Claude transcript observation bounds cumulative newline-free appends', async (t) => {
  const fixture = transcriptFixture(t);
  const surface = createClaudeSurface();
  const snapshot = surface.transcriptSnapshot(fixture.runtime, SESSION_ID);
  fs.appendFileSync(fixture.transcript, 'x'.repeat(600 * 1024));
  const append = setTimeout(() => {
    fs.appendFileSync(fixture.transcript, 'y'.repeat(600 * 1024));
  }, 100);
  t.after(() => clearTimeout(append));
  await assert.rejects(
    () => surface.waitForTranscriptDelivery(snapshot, 'never present', 1000),
    /append exceeded its bound/,
  );
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
  }), /not uniquely receipted/);
});
