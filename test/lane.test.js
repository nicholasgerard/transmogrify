'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  errorEffect,
  exitCodeForError,
  main,
  publicSuccess,
  publicErrorMessage,
  readInput,
  resultExitCode,
  safeDetails,
  safeString,
} = require('../scripts/lane');
const {
  createParentContext, recordEvent, reserveDispatch,
} = require('../scripts/lib/dispatch');
const {
  completeLaneOperation,
  pendingOperationForLane,
  registerLane,
  reserveSpawn,
  updateLane,
} = require('../scripts/lib/state');
const { verifySeat } = require('../scripts/lib/worktree');
const { startMockAppServer } = require('./helpers/mock-app-server');
const { runNodeScript } = require('./helpers/run-cli');
const { createRepoWithSeat } = require('./helpers/repo-fixture');

test('lane CLI rejects unknown operations, targets, and flags without provider mutation', async () => {
  const help = await runNodeScript('scripts/lane.js', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^usage: lane\.js/);
  for (const flag of [
    '--target', '--lane', '--name', '--cwd', '--worktrees',
    '--harvested-output-sha256', '--private-archive', '--finish-retirements',
    '--no-cleanup-worktree', '--accept-manual-seat-removal', '--url', '--claude-bin',
    '--parent-context-file', '--intent', '--model', '--effort', '--speed',
    '--allow-protocol-only',
  ]) {
    assert.match(help.stdout, new RegExp(flag), flag);
  }
  await assert.rejects(() => main([
    'spawn', '--repo-root', '/tmp', '--target', 'other', '--name', 'x', '--input', 'y',
  ], {}), /target codex\|claude/);
  const result = await runNodeScript('scripts/lane.js', ['status', '--unknown']);
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stderr).code, 'ERR_PARSE_ARGS_UNKNOWN_OPTION');
  await assert.rejects(() => main([
    'status', '--repo-root', '/tmp', '--lane', 'x', '--input', 'must-not-be-read',
  ], {}), /not valid for status/);
  await assert.rejects(() => main([
    'spawn', '--repo-root', '/tmp', '--target', 'codex', '--name', 'x', '--input', 'y',
    '--claude-bin', '/tmp/claude',
  ], {}), /only for Claude targets/);
  await assert.rejects(() => main([
    'spawn', '--repo-root', '/tmp', '--target', 'codex', '--name', 'x', '--input', 'y',
    '--model', 'gpt-5.6-sol',
  ], {}), /parent-context-file/);
  await assert.rejects(() => main([
    'reconcile', '--repo-root', '/tmp', '--target', 'codex', '--finish-retirements',
  ], {}), /only for Claude reconciliation/);
  await assert.rejects(() => main([
    'reconcile', '--repo-root', '/tmp', '--target', 'claude',
    '--accept-manual-seat-removal',
  ], {}), /not valid for reconcile/);
});

test('public capability output retains catalog ids, names, and provider-neutral descriptors', () => {
  const projected = publicSuccess({
    operation: 'capabilities',
    intents: [{ id: 'balanced', intent: 'balanced', label: 'Balanced' }],
    selectionGuide: {
      efforts: [{ id: 'high', effort: 'high', useWhen: 'Difficult work.' }],
      speeds: [{ id: 'standard', speed: 'standard', useWhen: 'Default.' }],
    },
    catalog: {
      source: { kind: 'app-server:model/list', userAgent: 'codex_cli_rs/0.151.0', verifiedAt: '2026-09-02' },
      models: [{
        id: 'gpt-5.6-sol', selector: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol',
        nativeSpeedTiers: [{ id: 'priority', name: 'Fast', description: 'Premium fast speed' }],
        executionSettings: [],
      }],
      executionSettings: [{
        id: 'ultracode', description: 'Dynamic workflows.', requiredEffort: 'xhigh',
        nativeControl: { kind: 'claude-effort-flag', value: 'ultracode' },
      }],
    },
    receipt: { name: '::: still redacted', providerId: 'thread-private', path: '/Users/private' },
  });
  assert.equal(projected.intents[0].id, 'balanced');
  assert.equal(projected.intents[0].intent, 'balanced');
  assert.equal(projected.selectionGuide.efforts[0].effort, 'high');
  assert.equal(projected.selectionGuide.speeds[0].speed, 'standard');
  assert.equal(projected.catalog.models[0].id, 'gpt-5.6-sol');
  assert.deepEqual(projected.catalog.models[0].nativeSpeedTiers[0], {
    id: 'priority', name: 'Fast', description: 'Premium fast speed',
  });
  assert.equal(projected.catalog.executionSettings[0].id, 'ultracode');
  assert.equal(projected.catalog.source.userAgent, 'codex_cli_rs/0.151.0');
  assert.deepEqual(projected.receipt, {});
  const children = publicSuccess({
    children: [{
      resolvedProfile: { resolved: { setting: { id: 'ultracode', selection: 'explicit' } } },
      providerId: 'thread-private',
    }],
  });
  assert.equal(children.children[0].resolvedProfile.resolved.setting.id, 'ultracode');
  assert.equal(children.children[0].providerId, undefined);
});

test('lane CLI can recover exact parent contexts without exposing private native references', async (t) => {
  const fixture = createRepoWithSeat(t);
  const created = await main([
    'parent-init', '--host-provider', 'codex', '--host-app', 'codex-desktop',
    '--name', 'Release operator', '--native-task-ref', 'private-native-task-id',
  ], fixture.env);
  const retried = await main([
    'parent-init', '--host-provider', 'codex', '--host-app', 'codex-desktop',
    '--name', 'Release operator', '--native-task-ref', 'private-native-task-id',
  ], fixture.env);
  assert.equal(retried.parentRef, created.parentRef);
  const listed = await main(['parent-list'], fixture.env);
  assert.equal(listed.parents.length, 1);
  assert.equal(listed.parents[0].parentRef, created.parentRef);
  assert.equal(listed.parents[0].contextFile, created.contextFile);
  assert.equal(JSON.stringify(listed).includes('private-native-task-id'), false);
});

test('parent wait survives restart, redelivers until acknowledgement, and never skips old unacked events', async (t) => {
  const fixture = createRepoWithSeat(t);
  const parent = await main([
    'parent-init', '--host-provider', 'codex', '--host-app', 'codex-desktop',
    '--name', 'Durable parent', '--native-task-ref', 'private-durable-parent',
  ], fixture.env);
  const context = createParentContext({
    hostProvider: 'codex',
    hostApp: 'codex-desktop',
    displayName: 'Durable parent',
    nativeTaskRef: 'private-durable-parent',
  }, fixture.env);
  const dispatch = reserveDispatch({
    parentContext: context,
    repoRoot: fixture.repoRoot,
    laneId: '88888888-8888-4888-8888-888888888888',
    targetProvider: 'claude',
    backend: 'claude-code',
    displayName: '::: durable child',
    prompt: 'Return durably.',
  }, fixture.env);
  const event = recordEvent({
    dispatchId: dispatch.dispatch.dispatchId,
    type: 'child.turn-completed',
    fingerprint: 'turn:one:completed',
    data: { state: 'idle' },
  }, fixture.env);

  const children = publicSuccess(await main([
    'children', '--parent-context-file', parent.contextFile,
    '--repo-root', fixture.repoRoot,
  ], fixture.env));
  assert.equal(children.children[0].displayName, '::: durable child');

  const first = await main([
    'wait', '--parent-context-file', parent.contextFile, '--timeout-ms', '0',
  ], fixture.env);
  assert.equal(first.events[0].eventId, event.eventId);
  const redelivered = await main([
    'wait', '--parent-context-file', parent.contextFile,
    '--after', String(event.sequence + 10), '--timeout-ms', '0',
  ], fixture.env);
  assert.equal(redelivered.events[0].eventId, event.eventId);

  await main([
    'ack', '--parent-context-file', parent.contextFile, '--event', event.eventId,
  ], fixture.env);
  await assert.rejects(() => main([
    'wait', '--parent-context-file', parent.contextFile, '--timeout-ms', '0',
  ], fixture.env), (error) => error.code === 'NO_EVENT');
});

test('parent wait observes later children after an earlier terminal child was acknowledged', async (t) => {
  const fixture = createRepoWithSeat(t);
  const context = createParentContext({
    hostProvider: 'codex',
    hostApp: 'codex-desktop',
    displayName: 'Multi-child parent',
    nativeTaskRef: 'private-multi-child-parent',
  }, fixture.env);
  const dispatches = [
    ['11111111-1111-4111-8111-111111111111', '::: first failed child'],
    ['22222222-2222-4222-8222-222222222222', '::: second failed child'],
  ].map(([laneId, displayName]) => reserveDispatch({
    parentContext: context,
    repoRoot: fixture.repoRoot,
    laneId,
    targetProvider: 'codex',
    backend: 'codex-app-server',
    displayName,
    prompt: 'Fail locally for observation.',
  }, fixture.env));
  for (const dispatch of dispatches) {
    const laneId = dispatch.dispatch.child.laneId;
    const operationId = crypto.randomUUID();
    reserveSpawn(fixture.repoRoot, {
      operation: {
        operationId,
        type: 'spawn',
        laneId,
        details: { dispatchId: dispatch.dispatch.dispatchId },
      },
      lane: {
        laneId,
        backend: 'codex-app-server',
        target: 'codex',
        displayName: dispatch.dispatch.child.displayName,
        state: 'planned',
        operationId,
        runtime: {
          endpoint: 'ws://127.0.0.1:8843/',
          codexHome: '/tmp/codex-home',
          platformFamily: 'unix',
          platformOs: 'test',
        },
        seat: null,
        lineage: dispatch.lineage,
      },
    }, fixture.env);
    updateLane(fixture.repoRoot, laneId, { state: 'failed' }, fixture.env);
    completeLaneOperation(
      fixture.repoRoot,
      laneId,
      operationId,
      { state: 'notDelivered' },
      fixture.env,
    );
  }
  // Event-expecting waits use a generous deadline: a wait returns as soon as an
  // observation round records events, but a slow CI disk can stretch the round.
  const first = await main([
    'wait', '--parent-context-file', context.file,
    '--repo-root', fixture.repoRoot,
    '--timeout-ms', '10000',
  ], fixture.env);
  assert.deepEqual(
    first.events.map((event) => event.dispatchId).sort(),
    dispatches.map((dispatch) => dispatch.dispatch.dispatchId).sort(),
  );
  assert.deepEqual(first.events.map((event) => event.type), ['child.failed', 'child.failed']);
  await main([
    'ack', '--parent-context-file', context.file,
    '--event', first.events[0].eventId,
  ], fixture.env);
  const second = await main([
    'wait', '--parent-context-file', context.file,
    '--repo-root', fixture.repoRoot,
    '--timeout-ms', '10000',
  ], fixture.env);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].eventId, first.events[1].eventId);
  await main([
    'ack', '--parent-context-file', context.file,
    '--event', second.events[0].eventId,
  ], fixture.env);
  await assert.rejects(() => main([
    'wait', '--parent-context-file', context.file,
    '--repo-root', fixture.repoRoot,
    '--timeout-ms', '300',
  ], fixture.env), (error) => error.code === 'NO_EVENT');
});

test('lane CLI routes Codex recover input to exact boundary resume', async (t) => {
  const fixture = createRepoWithSeat(t);
  const methods = [];
  const server = await startMockAppServer((request, socket) => {
    methods.push(request.method);
    if (request.method === 'thread/read') {
      return { result: { thread: {
        id: 'thread-lane-recover',
        cwd: fs.realpathSync(fixture.seat),
        status: { type: 'idle' },
      } } };
    }
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{ id: 'turn-before-recover', status: 'completed', items: [] }] } };
    }
    if (request.method === 'thread/resume') {
      assert.equal(request.params.cwd, fs.realpathSync(fixture.seat));
      return { result: {
        cwd: fs.realpathSync(fixture.seat),
        thread: { id: 'thread-lane-recover', cwd: fs.realpathSync(fixture.seat) },
      } };
    }
    if (request.method === 'turn/start') {
      socket.send(JSON.stringify({
        method: 'turn/started',
        params: {
          threadId: 'thread-lane-recover',
          turn: { id: 'turn-after-recover', status: 'inProgress' },
        },
      }));
      return { result: { turn: {
        id: 'turn-after-recover',
        status: 'inProgress',
        items: [{
          id: 'user-turn-after-recover',
          type: 'userMessage',
          clientId: request.params.clientUserMessageId,
          content: request.params.input,
        }],
      } } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'thread-lane-recover',
    displayName: '[test] lane recover input',
    state: 'idle',
    runtime: {
      endpoint: new URL(server.url).toString(),
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
    },
    seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot),
  }, fixture.env);

  const result = await main([
    'recover',
    '--repo-root', fixture.repoRoot,
    '--lane', lane.laneId,
    '--url', server.url,
    '--input', 'continue through the provider-neutral command',
  ], fixture.env);
  assert.equal(result.operation, 'recover');
  assert.equal(result.state, 'active');
  assert.deepEqual(methods, ['thread/read', 'thread/turns/list', 'thread/resume', 'turn/start']);
});

test('lane CLI labels Codex target-wide observation as reconcile', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer();
  t.after(() => server.close());

  const result = await main([
    'reconcile',
    '--repo-root', fixture.repoRoot,
    '--target', 'codex',
    '--url', server.url,
  ], fixture.env);
  assert.equal(result.ok, true);
  assert.equal(result.operation, 'reconcile');
  assert.deepEqual(result.recovered, []);
});

test('lane CLI maps exact unowned-lane refusal to exit 2', async (t) => {
  const fixture = createRepoWithSeat(t);
  const result = await runNodeScript('scripts/lane.js', [
    'status',
    '--repo-root', fixture.repoRoot,
    '--lane', 'not-owned',
  ], {
    env: { TRANSMOGRIFY_STATE_DIR: fixture.stateDir },
  });
  assert.equal(result.code, 2);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'NOT_OWNED');
  assert.equal(error.delivery, 'notAttempted');
});

test('lane CLI maps exact unowned Claude reconciliation to NOT_OWNED and exit 2', async (t) => {
  const fixture = createRepoWithSeat(t);
  const result = await runNodeScript('scripts/lane.js', [
    'reconcile',
    '--repo-root', fixture.repoRoot,
    '--target', 'claude',
    '--lane', 'not-owned',
  ], {
    env: { TRANSMOGRIFY_STATE_DIR: fixture.stateDir },
  });
  assert.equal(result.code, 2);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'NOT_OWNED');
  assert.equal(error.delivery, 'notAttempted');
});

test('lane CLI reports a malformed post-dispatch Codex spawn as mutation-unknown', async (t) => {
  const fixture = createRepoWithSeat(t);
  const parentContext = createParentContext({
    hostProvider: 'codex',
    hostApp: 'codex-desktop',
    displayName: 'Malformed receipt test',
  }, fixture.env);
  const server = await startMockAppServer((request) => {
    if (request.method === 'model/list') {
      return { result: { data: [{
        id: 'sol-id',
        model: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        description: 'Reliable agentic workhorse.',
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }],
        defaultReasoningEffort: 'low',
        serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Premium fast speed' }],
        defaultServiceTier: null,
      }], nextCursor: null } };
    }
    assert.equal(request.method, 'thread/start');
    return { result: { thread: {} } };
  });
  t.after(() => server.close());
  const result = await runNodeScript('scripts/lane.js', [
    'spawn',
    '--repo-root', fixture.repoRoot,
    '--target', 'codex',
    '--url', server.url,
    '--cwd', fixture.seat,
    '--worktrees', fixture.worktreesRoot,
    '--name', '[test] malformed spawn receipt',
    '--input', 'test prompt',
    '--parent-context-file', parentContext.file,
    '--allow-protocol-only',
  ], { env: { TRANSMOGRIFY_STATE_DIR: fixture.stateDir } });
  assert.equal(result.code, 3);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'PROTOCOL_ERROR');
  assert.equal(error.delivery, 'unknown');
  assert.deepEqual(error.effect, { providerMutation: 'unknown' });
  assert.equal(server.requests.filter((request) => request.method === 'thread/start').length, 1);
});

test('lane CLI reports a dispatched Codex archive error as mutation-unknown', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return { result: { thread: {
        id: 'thread-archive-error',
        cwd: fs.realpathSync(fixture.seat),
        status: { type: 'idle' },
      } } };
    }
    if (request.method === 'thread/turns/list') return { result: { data: [] } };
    if (request.method === 'thread/archive') {
      return { error: { code: -32000, message: 'archive failed after dispatch' } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'thread-archive-error',
    displayName: '[test] archive error receipt',
    state: 'idle',
    runtime: {
      endpoint: new URL(server.url).toString(),
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
    },
    seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot),
  }, fixture.env);
  const result = await runNodeScript('scripts/lane.js', [
    'retire',
    '--repo-root', fixture.repoRoot,
    '--lane', lane.laneId,
    '--url', server.url,
    '--harvested-output-sha256', 'a'.repeat(64),
  ], { env: { TRANSMOGRIFY_STATE_DIR: fixture.stateDir } });
  assert.equal(result.code, 3);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'RPC_ERROR');
  assert.equal(error.delivery, 'unknown');
  assert.deepEqual(error.effect, { providerMutation: 'unknown' });
  assert.equal(server.requests.filter((request) => request.method === 'thread/archive').length, 1);
  const pending = pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env);
  assert.equal(pending.state, 'unknown');
  assert.equal(pending.details.archiveFailurePhase, 'dispatch');
  assert.equal(pending.details.causeCode, 'RPC_ERROR');
  assert.match(pending.details.archiveDeliveryBecameUnknownAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(JSON.stringify(pending).includes('archive failed after dispatch'), false);
});

test('lane CLI recursively redacts credential-like failure details', () => {
  assert.deepEqual(safeDetails({
    laneId: 'lane-safe',
    nested: {
      accessToken: 'secret',
      bridgeId: 'session_private',
      Authorization: 'Bearer secret',
      cookie: 'sensitive',
      state: 'unknown',
    },
  }), {
    laneId: 'lane-safe',
  });
  assert.equal(
    safeString('Authorization=secret Bearer token-value session_private https://x.invalid/?token=abc'),
    'Authorization=[redacted] Bearer [redacted] [redacted-provider-id] https://x.invalid/?token=[redacted]',
  );
  assert.deepEqual(errorEffect('FORKED_COPY'), { providerMutation: 'unknown' });
  assert.deepEqual(errorEffect('PROTOCOL_ERROR'), { providerMutation: 'unknown' });
  assert.deepEqual(errorEffect('PRIVATE_AUTH_UNAVAILABLE', {
    providerMutation: 'verified', stop: 'verified', archive: 'notAttempted',
  }), {
    providerMutation: 'verified', stop: 'verified', archive: 'notAttempted',
  });
  assert.deepEqual(errorEffect('CLEANUP_BLOCKED'), {
    providerMutation: 'verified',
    cleanup: 'blocked',
  });
  assert.deepEqual(errorEffect('CLEANUP_RETRYABLE'), {
    providerMutation: 'verified',
    cleanup: 'retryable',
  });
  assert.equal(exitCodeForError('NOT_DELIVERED'), 2);
  assert.equal(exitCodeForError('CLEANUP_BLOCKED'), 2);
  assert.equal(exitCodeForError('CLEANUP_RETRYABLE'), 2);
  assert.equal(exitCodeForError('DELIVERY_UNCERTAIN'), 3);
  assert.equal(resultExitCode({
    ok: false,
    results: [{ outcome: 'retirementPending' }, { outcome: 'verified' }],
  }), 2);
  assert.equal(resultExitCode({
    ok: false,
    recovered: [{ skipped: 'differentRuntime' }],
  }), 2);
  assert.equal(resultExitCode({
    ok: false,
    results: [{ outcome: 'cleanupRetryable', code: 'CLEANUP_RETRYABLE' }],
  }), 2);
  assert.equal(resultExitCode({
    ok: false,
    results: [{ outcome: 'steerUnknown' }],
  }), 3);
  assert.equal(publicErrorMessage('SPAWN_UNCERTAIN'), 'provider spawn outcome is unknown');
  assert.match(publicErrorMessage('NATIVE_VISIBILITY_REQUIRED'), /native-visibility receipt/);
  assert.equal(publicErrorMessage('UNKNOWN_CODE_WITH_secret-value'), 'operator operation failed');
});

test('lane CLI success projection retains lane receipts but removes provider control handles and paths', () => {
  const projected = publicSuccess({
    version: 1,
    ok: true,
    operation: 'spawn',
    laneId: 'lane-public',
    operationId: 'operation-public',
    providerId: 'thread-private',
    state: 'active',
    turn: { id: 'turn-private', status: 'inProgress' },
    receipt: {
      sessionId: '11111111-1111-4111-8111-111111111111',
      jobId: '11111111',
      bridgeIdSha256: 'a'.repeat(64),
      cwd: '/Users/private/repository',
      mode: 'queuedSafePointPublicCli',
    },
    results: [{
      laneId: 'lane-public',
      providerId: 'thread-private',
      outcome: 'verified',
      error: 'private provider failure',
    }],
  });
  assert.deepEqual(projected, {
    version: 1,
    ok: true,
    operation: 'spawn',
    laneId: 'lane-public',
    operationId: 'operation-public',
    state: 'active',
    turn: { status: 'inProgress' },
    receipt: {
      bridgeIdSha256: 'a'.repeat(64),
      mode: 'queuedSafePointPublicCli',
    },
    results: [{
      laneId: 'lane-public',
      outcome: 'verified',
    }],
  });
  assert.equal(JSON.stringify(projected).includes('thread-private'), false);
  assert.equal(JSON.stringify(projected).includes('/Users/private'), false);
});

test('lane CLI input files are no-follow, owner-safe, and bounded', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-lane-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const good = path.join(root, 'input.txt');
  fs.writeFileSync(good, 'hello', { mode: 0o600 });
  assert.equal(readInput({ 'input-file': good }), 'hello');
  const link = path.join(root, 'link.txt');
  fs.symlinkSync(good, link);
  assert.throws(() => readInput({ 'input-file': link }), /safe bounded regular file/);
  const large = path.join(root, 'large.txt');
  fs.writeFileSync(large, Buffer.alloc(64 * 1024 + 1), { mode: 0o600 });
  assert.throws(() => readInput({ 'input-file': large }), /safe bounded regular file/);
  const invalid = path.join(root, 'invalid.txt');
  fs.writeFileSync(invalid, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
  assert.throws(() => readInput({ 'input-file': invalid }), /valid UTF-8/);
  assert.throws(() => readInput({ input: 'contains\0nul' }), /must not contain NUL/);
});

test('public messages cover the Remote Control failure code', () => {
  assert.match(publicErrorMessage('REMOTE_CONTROL_UNAVAILABLE'), /Remote Control/);
});
