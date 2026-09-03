'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  executionCapabilities,
  recover,
  reconcile,
  retire,
  spawn,
  status,
  steer,
  stop,
} = require('../scripts/lib/claude-adapter');
const { errorEffect } = require('../scripts/lane');
const { createParentContext, readDispatch } = require('../scripts/lib/dispatch');
const { exactOwnedAgent, MAX_STEER_BYTES } = require('../scripts/lib/claude-surface');
const {
  beginLaneOperation, completeLaneOperation, listLanes, listOperations,
  pendingOperationForLane, projectPaths, reserveSpawn, updatePendingLaneOperation,
} = require('../scripts/lib/state');
const { removeManagedSeat, verifySeat } = require('../scripts/lib/worktree');
const { createRepoWithSeat } = require('./helpers/repo-fixture');

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const BRIDGE_ID = 'session_testBridge';

function fakeRuntime() {
  return {
    protocolGeneration: 1,
    platform: 'darwin',
    arch: 'arm64',
    cliPath: '/tmp/fake-claude',
    cliVersion: '2.1.258',
    cliSha256: 'a'.repeat(64),
    configDir: '/tmp/fake-claude-config',
    configDevice: 1,
    configInode: 2,
    projectsDirectory: '/tmp/fake-claude-config/projects',
    projectsDevice: 1,
    projectsInode: 3,
    accountFingerprint: 'b'.repeat(64),
    orgId: 'org-test',
    cleanEnv: { PATH: '/bin' },
  };
}

function createFakeSurface(configuration = {}) {
  const runtime = fakeRuntime();
  const sessionId = configuration.sessionId || SESSION_ID;
  const jobId = configuration.jobId || sessionId.slice(0, 8).toLowerCase();
  const bridgeId = configuration.bridgeId || BRIDGE_ID;
  const calls = [];
  let rows = [];
  let currentPid = configuration.pid || 101;
  const surface = {
    calls,
    runtime,
    preflight(options) {
      calls.push({ method: 'preflight', options });
      return runtime;
    },
    async agents(_runtime, options = {}) {
      // The real surface reads only timeoutMs; any other key is a caller bug
      // that would silently drop a deadline.
      assert.ok(Object.keys(options).every((key) => key === 'timeoutMs'), `agents options ${JSON.stringify(options)}`);
      calls.push({ method: 'agents', options });
      if (surface.onAgents) surface.onAgents(rows);
      return rows.map((row) => ({ ...row }));
    },
    async launch(_runtime, args, options) {
      calls.push({ method: 'launch', args, options });
      rows = [{
        cwd: fs.realpathSync(options.cwd),
        id: jobId,
        kind: 'background',
        name: args[2],
        pid: currentPid,
        sessionId,
        startedAt: new Date().toISOString(),
        status: 'working',
      }];
      fs.writeFileSync(options.stdoutPath, `Started background agent ${jobId}\n`, { mode: 0o600 });
      fs.writeFileSync(options.stderrPath, '', { mode: 0o600 });
      return { stdout: `Started background agent ${jobId}\n`, stderr: '' };
    },
    exactOwnedAgent(agents, identity, expected) {
      return exactOwnedAgent(agents, identity, expected);
    },
    discoverExecution(_runtime, expected, agent, options = {}) {
      calls.push({ method: 'discoverExecution', expected, pid: agent.pid, options });
      if (surface.failDiscoveryOnce) {
        surface.failDiscoveryOnce = false;
        const error = new Error('simulated crash boundary');
        error.code = surface.discoveryErrorCode || 'SPAWN_UNCERTAIN';
        throw error;
      }
      return execution(agent.pid);
    },
    verifySpawnTranscript(_runtime, sessionId, expected) {
      calls.push({ method: 'verifySpawnTranscript', sessionId, expected });
      if (surface.failSpawnTranscript) {
        const error = new Error('spawn prompt is not uniquely receipted');
        error.code = 'SPAWN_UNCERTAIN';
        throw error;
      }
      return {
        state: 'spawnPromptObserved',
        device: 1,
        inode: 9,
        offset: 100,
        promptSha256: expected.promptSha256,
        promptMarkerSha256: expected.promptMarkerSha256,
      };
    },
    executionReceipt(_runtime, lane, agent, options = {}) {
      calls.push({ method: 'executionReceipt', laneId: lane.laneId, pid: agent.pid, options });
      return execution(agent.pid);
    },
    async dispatchDeepLink(_runtime, bridgeId, options = {}) {
      calls.push({ method: 'dispatchDeepLink', bridgeId, options });
      if (surface.deepLinkFailures > 0) {
        surface.deepLinkFailures -= 1;
        const error = new Error('deep link dispatch failed');
        error.code = 'PRESENTATION_UNCERTAIN';
        throw error;
      }
      return { state: 'deepLinkDispatched' };
    },
    transcriptSnapshot(_runtime, sessionId) {
      calls.push({ method: 'transcriptSnapshot', sessionId });
      return { file: '/tmp/transcript', offset: 10 };
    },
    async sendRemoteFollowup(_runtime, requestedBridgeId, content, options) {
      calls.push({ method: 'sendRemoteFollowup', bridgeId: requestedBridgeId, content, options });
      return {
        queued: true,
        channel: 'publicCloudFollowup',
        sessionIdSha256: 'c'.repeat(64),
        stdoutSha256: 'd'.repeat(64),
        stderrSha256: 'e'.repeat(64),
      };
    },
    async waitForTranscriptDelivery(_snapshot, content) {
      calls.push({ method: 'waitForTranscriptDelivery', content });
      return { state: 'queuedObserved', offset: 20 };
    },
    verifyDeliveryTranscript(_runtime, sessionId, expected) {
      calls.push({ method: 'verifyDeliveryTranscript', sessionId, expected });
      if (surface.deliveryReceiptErrorCode) {
        const error = new Error('delivery receipt inspection failed');
        error.code = surface.deliveryReceiptErrorCode;
        throw error;
      }
      if (surface.deliveryReceiptMissingCount > 0) {
        surface.deliveryReceiptMissingCount -= 1;
        const error = new Error('delivery receipt is not visible yet');
        error.code = 'DELIVERY_UNCERTAIN';
        throw error;
      }
      if (surface.deliveryReceiptMissing) {
        const error = new Error('delivery receipt is not visible');
        error.code = 'DELIVERY_UNCERTAIN';
        throw error;
      }
      return {
        state: 'queuedObserved',
        device: 1,
        inode: 9,
        offset: 20,
        messageSha256: expected.messageSha256,
        deliveryTokenSha256: 'f'.repeat(64),
      };
    },
    async run(_runtime, args, options) {
      calls.push({ method: 'run', args, options });
      if (args[0] === 'stop') {
        assert.ok(rows.some((row) => row.id === args[1]), 'stop targets a listed job');
        rows = rows.map((row) => row.id === args[1]
          ? { ...row, pid: null, status: 'stopped' }
          : row);
      } else if (args[0] === '--resume') {
        assert.deepEqual(args, surface.expectedResumeArgs || ['--resume', sessionId, '--bg']);
        if (!surface.resumeDoesNothing) {
          currentPid = 202;
          rows = rows.map((row) => row.sessionId === sessionId
            ? { ...row, pid: currentPid, status: 'idle' }
            : row);
        }
        if (surface.resumeExtraRows) {
          rows.push(...surface.resumeExtraRows.map((row) => ({ ...row })));
        }
      } else if (args[0] === 'rm') {
        assert.equal(args[1], jobId);
        rows = rows.filter((row) => row.sessionId !== sessionId);
      } else {
        throw new Error(`unexpected run ${args.join(' ')}`);
      }
      return { stdout: '', stderr: '' };
    },
    getRows() { return rows.map((row) => ({ ...row })); },
    setRows(next) { rows = next.map((row) => ({ ...row })); },
    sessionId,
    jobId,
    bridgeId,
  };
  function execution(pid) {
    return {
      pid,
      processBirth: `birth-${pid}`,
      socket: {
        path: `/tmp/fake-private/${pid}.sock`,
        device: 1,
        inode: pid,
        uid: 501,
        mode: 0o600,
      },
      bridgeId,
      worker: { path: runtime.cliPath, sha256: runtime.cliSha256 },
    };
  }
  return surface;
}

function spawnOptions(fixture, surface) {
  return {
    repoRoot: fixture.repoRoot,
    worktrees: fixture.worktreesRoot,
    cwd: fixture.seat,
    name: 'native Claude lane',
    input: 'Return CLAUDE_READY.',
    surface,
    discoveryAttempts: 2,
    discoveryDelayMs: 0,
    spawnVerifyTimeoutMs: 300,
    spawnVerifyDelayMs: 20,
  };
}

async function spawnedLane(t, overrides = {}) {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  const result = await spawn({ ...spawnOptions(fixture, surface), ...overrides }, fixture.env);
  return { fixture, surface, result, lane: listLanes(fixture.repoRoot, fixture.env)[0] };
}

test('Claude capabilities expose the pinned CLI catalog and neutral intent vocabulary', () => {
  const surface = createFakeSurface();
  surface.runtime.cliVersion = '2.1.258';
  const result = executionCapabilities({ surface });
  assert.equal(result.target, 'claude');
  assert.equal(result.catalog.models.some((entry) => entry.id === 'claude-opus-5'), true);
  assert.deepEqual(result.catalog.executionSettings.map((entry) => entry.id), ['ultracode']);
  assert.deepEqual(
    result.selectionGuide.executionSettings.map((entry) => entry.setting),
    ['ultracode'],
  );
  assert.deepEqual(result.intents.map((entry) => entry.id), [
    'provider-default', 'fast-loop', 'balanced', 'deep', 'max-quality',
  ]);
});

test('Claude spawn journals intent, uses exact argv, binds three identifiers, and dispatches the native bridge', async (t) => {
  const { fixture, surface, result, lane } = await spawnedLane(t);
  assert.equal(result.ok, true);
  assert.equal(lane.providerId, SESSION_ID);
  assert.equal(lane.providerIdentity.jobId, '11111111');
  assert.equal(lane.providerIdentity.bridgeId, BRIDGE_ID);
  assert.equal(lane.providerIdentity.executionEpochs.length, 1);
  assert.equal(lane.state, 'active');
  assert.equal(result.receipt.presentation, 'deepLinkDispatched');
  const launch = surface.calls.find((call) => call.method === 'launch');
  assert.deepEqual(launch.args.slice(0, 5), [
    '--bg', '--name', '::: native Claude lane', '--remote-control', '::: native Claude lane',
  ]);
  assert.match(launch.args[5], /^Return CLAUDE_READY\.\n\n\[transmogrify spawn [0-9a-f-]{36}\]$/);
  assert.equal(launch.options.cwd, fs.realpathSync(fixture.seat));
  assert.equal(listOperations(fixture.repoRoot, fixture.env)[0].state, 'complete');
  assert.equal(fs.existsSync(lane.ownership.spawnIntent.stdoutPath), false);
  assert.equal(fs.existsSync(lane.ownership.spawnIntent.stderrPath), false);
});

test('Claude spawn removes raw CLI capture files after a confirmed not-delivered result', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  surface.launch = async (_runtime, _args, options) => {
    fs.writeFileSync(options.stdoutPath, 'sensitive provider output', { mode: 0o600 });
    fs.writeFileSync(options.stderrPath, 'sensitive provider error', { mode: 0o600 });
    const error = new Error('provider executable was absent');
    error.code = 'ENOENT';
    throw error;
  };
  await assert.rejects(
    () => spawn(spawnOptions(fixture, surface), fixture.env),
    (error) => error.code === 'NOT_DELIVERED',
  );
  const [lane] = listLanes(fixture.repoRoot, fixture.env);
  assert.equal(lane.state, 'failed');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  assert.equal(fs.existsSync(lane.ownership.spawnIntent.stdoutPath), false);
  assert.equal(fs.existsSync(lane.ownership.spawnIntent.stderrPath), false);
});

test('Claude spawn records and forwards an explicit model selection', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  const result = await spawn({
    ...spawnOptions(fixture, surface),
    model: 'claude-opus-5',
  }, fixture.env);
  const lane = listLanes(fixture.repoRoot, fixture.env)[0];
  const launch = surface.calls.find((call) => call.method === 'launch');
  assert.deepEqual(launch.args.slice(0, 7), [
    '--bg', '--name', '::: native Claude lane',
    '--remote-control', '::: native Claude lane',
    '--model', 'claude-opus-5',
  ]);
  assert.match(launch.args[7], /^Return CLAUDE_READY\./);
  assert.equal(lane.ownership.spawnIntent.modelSelector, 'claude-opus-5');
  assert.equal(listOperations(fixture.repoRoot, fixture.env)[0].details.modelSelector, 'claude-opus-5');
  assert.equal(result.receipt.requestedModelSelector, 'claude-opus-5');
});

test('Claude dispatched profiles render provenance and survive exact-session recovery', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  surface.runtime.cliVersion = '2.1.258';
  const parentContext = createParentContext({
    hostProvider: 'codex',
    hostApp: 'codex-desktop',
    displayName: 'Release operator',
  }, fixture.env);
  const result = await spawn({
    ...spawnOptions(fixture, surface),
    parentContext,
    intent: 'deep',
  }, fixture.env);
  const lane = listLanes(fixture.repoRoot, fixture.env)[0];
  const launch = surface.calls.find((call) => call.method === 'launch');
  assert.deepEqual(launch.args.slice(0, 11), [
    '--bg', '--name', '::: native Claude lane',
    '--remote-control', '::: native Claude lane',
    '--model', 'claude-opus-5', '--effort', 'high',
    '--settings', '{"fastMode":false}',
  ]);
  assert.match(launch.args[11], /^╭─ Transmogrify · a task from your user's own session ─+\n/);
  assert.match(launch.args[11], /^│ From {6}Codex Desktop$/m);
  assert.match(launch.args[11], /^│ Task {6}"Release operator"$/m);
  assert.match(launch.args[11], /^│ To {8}Claude Code · claude-opus-5 · high effort · standard speed$/m);
  assert.match(launch.args[11], /^│ Intent {4}deep$/m);
  assert.equal(lane.executionProfile.requested.intent, 'deep');
  assert.equal(lane.lineage.parentRef, parentContext.parent.parentRef);
  const dispatch = readDispatch(lane.lineage.dispatchId, fixture.env);
  assert.equal(dispatch.resolvedProfile.model.selector, 'claude-opus-5');
  assert.equal(dispatch.observedProfile, null);
  assert.equal(result.receipt.executionProfile.observed, null);

  surface.expectedResumeArgs = [
    '--resume', SESSION_ID, '--bg', '--model', 'claude-opus-5',
    '--effort', 'high', '--settings', '{"fastMode":false}',
  ];
  await stop({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    stopVerifyAttempts: 2,
    stopVerifyDelayMs: 0,
  }, fixture.env);
  await recover({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    recoveryVerifyAttempts: 2,
    recoveryVerifyDelayMs: 0,
  }, fixture.env);
});

test('Claude ultracode compiles xhigh plus dynamic workflows and survives recovery', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  const parentContext = createParentContext({
    hostProvider: 'codex',
    hostApp: 'codex-desktop',
    displayName: 'Workflow operator',
  }, fixture.env);
  await spawn({
    ...spawnOptions(fixture, surface),
    parentContext,
    model: 'claude-opus-5',
    effort: 'ultracode',
  }, fixture.env);
  const lane = listLanes(fixture.repoRoot, fixture.env)[0];
  const launch = surface.calls.find((call) => call.method === 'launch');
  assert.deepEqual(launch.args.slice(0, 11), [
    '--bg', '--name', '::: native Claude lane',
    '--remote-control', '::: native Claude lane',
    '--model', 'claude-opus-5', '--effort', 'ultracode',
    '--settings', '{"fastMode":false}',
  ]);
  assert.equal(lane.executionProfile.requested.effort, null);
  assert.equal(lane.executionProfile.requested.setting, 'ultracode');
  assert.deepEqual(lane.executionProfile.resolved.effort, {
    level: 'xhigh', selection: 'execution-setting',
  });
  assert.equal(lane.executionProfile.resolved.setting.id, 'ultracode');

  surface.expectedResumeArgs = [
    '--resume', SESSION_ID, '--bg', '--model', 'claude-opus-5',
    '--effort', 'ultracode', '--settings', '{"fastMode":false}',
  ];
  await stop({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    stopVerifyAttempts: 2,
    stopVerifyDelayMs: 0,
  }, fixture.env);
  await recover({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    recoveryVerifyAttempts: 2,
    recoveryVerifyDelayMs: 0,
  }, fixture.env);
});

test('Claude spawn rejects unsafe model selectors before provider access or lane reservation', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  const beforeLanes = listLanes(fixture.repoRoot, fixture.env).length;
  const beforeOperations = listOperations(fixture.repoRoot, fixture.env).length;
  for (const model of ['', '--opus', 'opus 5', 'opus[1m]', `x${'y'.repeat(128)}`]) {
    await assert.rejects(() => spawn({
      ...spawnOptions(fixture, surface),
      model,
    }, fixture.env), (error) => error.code === 'USAGE_ERROR', model);
  }
  assert.equal(surface.calls.length, 0);
  assert.equal(listLanes(fixture.repoRoot, fixture.env).length, beforeLanes);
  assert.equal(listOperations(fixture.repoRoot, fixture.env).length, beforeOperations);
});

test('Claude steer reports only transcript-observed queued-safe-point delivery', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  const result = await steer({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message: 'Use the revised constraint.',
    surface,
  }, fixture.env);
  assert.equal(result.delivery, 'deliveredObserved');
  assert.equal(result.receipt.mode, 'queuedSafePointPublicCli');
  const write = surface.calls.find((call) => call.method === 'sendRemoteFollowup');
  assert.equal(write.bridgeId, BRIDGE_ID);
  assert.match(write.content, /^Use the revised constraint\.\n\n\[transmogrify delivery [0-9a-f-]{36}\]$/);
  const observed = surface.calls.find((call) => call.method === 'verifyDeliveryTranscript');
  assert.equal(observed.sessionId, lane.providerId);
  const [, deliveryToken] = write.content.match(/\[transmogrify delivery ([0-9a-f-]{36})\]$/);
  assert.equal(observed.expected.deliveryToken, deliveryToken);
});

test('Claude steer rejects a framed message over the transport bound before journaling or dispatch', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  await assert.rejects(() => steer({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message: 'x'.repeat(MAX_STEER_BYTES),
    surface,
  }, fixture.env), (error) => error.code === 'USAGE_ERROR');
  assert.equal(surface.calls.some((call) => call.method === 'sendRemoteFollowup'), false);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'active');
});

test('Claude steer retries transcript verification inline until the delivery marker lands', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  surface.deliveryReceiptMissingCount = 2;
  const result = await steer({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message: 'Observed a little late.',
    surface,
    steerVerifyDelayMs: 0,
  }, fixture.env);
  assert.equal(result.delivery, 'deliveredObserved');
  assert.equal(surface.calls.filter((call) => call.method === 'verifyDeliveryTranscript').length, 3);
  assert.equal(surface.calls.filter((call) => call.method === 'sendRemoteFollowup').length, 1);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  const operation = listOperations(fixture.repoRoot, fixture.env).find((entry) => entry.type === 'steer');
  assert.equal(operation.state, 'complete');
});

test('Claude steer declares delivery uncertain once its bounded verification window is spent', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  surface.deliveryReceiptMissing = true;
  await assert.rejects(() => steer({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message: 'This never lands before the window closes.',
    surface,
    steerVerifyTimeoutMs: 0,
    steerVerifyDelayMs: 0,
  }, fixture.env), (error) => error.code === 'DELIVERY_UNCERTAIN');
  assert.equal(surface.calls.filter((call) => call.method === 'verifyDeliveryTranscript').length, 1);
  assert.equal(surface.calls.filter((call) => call.method === 'sendRemoteFollowup').length, 1);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).state, 'unknown');
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'deliveryUnknown');
});

test('Claude steer rejects an invalid verification window before any dispatch', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  surface.calls.length = 0;
  for (const overrides of [
    { steerVerifyTimeoutMs: -1 },
    { steerVerifyTimeoutMs: 1.5 },
    { steerVerifyTimeoutMs: 'soon' },
    { steerVerifyDelayMs: -1 },
    { steerVerifyDelayMs: 1.5 },
  ]) {
    await assert.rejects(() => steer({
      repoRoot: fixture.repoRoot,
      laneId: lane.laneId,
      message: 'Should never be sent.',
      surface,
      ...overrides,
    }, fixture.env), (error) => error.code === 'USAGE_ERROR', JSON.stringify(overrides));
  }
  assert.equal(surface.calls.length, 0);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'active');
});

test('Claude steer verification stays bounded by the aggregate command deadline', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  surface.deliveryReceiptMissing = true;
  const startedAt = Date.now();
  await assert.rejects(() => steer({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message: 'The command deadline runs out long before the local window.',
    surface,
    steerVerifyTimeoutMs: 60_000,
    steerVerifyDelayMs: 30,
    commandTimeoutMs: 200,
  }, fixture.env), (error) => error.code === 'DELIVERY_UNCERTAIN');
  assert.ok(Date.now() - startedAt < 2_000, 'the command deadline, not the 60s local window, ended the wait');
  assert.equal(surface.calls.filter((call) => call.method === 'sendRemoteFollowup').length, 1);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).state, 'unknown');
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'deliveryUnknown');
});

test('Claude status, whole-session stop, and profile-pinned recovery preserve identity and append an epoch', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t, { model: 'claude-opus-5' });
  await steer({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message: 'Continue under the saved model selection.',
    surface,
  }, fixture.env);
  surface.setRows(surface.getRows().map((row) => ({ ...row, status: 'idle', state: 'done' })));
  const observed = await status({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
  }, fixture.env);
  assert.equal(observed.phase, 'idle');
  assert.equal(observed.state, 'idle');
  const stopped = await stop({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    stopVerifyAttempts: 2,
    stopVerifyDelayMs: 0,
  }, fixture.env);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.receipt.mode, 'wholeSession');
  const recovered = await recover({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    recoveryVerifyAttempts: 2,
    recoveryVerifyDelayMs: 0,
  }, fixture.env);
  assert.equal(recovered.providerId, SESSION_ID);
  assert.equal(recovered.receipt.sameBridgeId, true);
  assert.equal(recovered.receipt.executionEpoch, 2);
  const resume = surface.calls.find((call) => call.method === 'run' && call.args[0] === '--resume');
  assert.deepEqual(resume.args, ['--resume', SESSION_ID, '--bg']);
  assert.equal(
    listLanes(fixture.repoRoot, fixture.env)[0].ownership.spawnIntent.modelSelector,
    'claude-opus-5',
  );
  assert.equal(surface.calls.some((call) =>
    call.method === 'run' && call.args.includes('--model')), false);
});

test('Claude status persists only closed phase and waiting projections', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  const secret = 'private-provider-state';
  surface.setRows(surface.getRows().map((row) => ({
    ...row,
    status: secret,
    state: secret,
    waitingFor: secret,
  })));
  const result = await status({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
  }, fixture.env);
  assert.equal(result.phase, 'waiting');
  const persisted = listLanes(fixture.repoRoot, fixture.env)[0].providerState;
  assert.deepEqual(persisted, { phase: 'waiting', waiting: true, pid: 101 });
  assert.equal(JSON.stringify(persisted).includes(secret), false);
});

test('Claude status threads one bounded command budget through listing and worker verification', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  surface.calls.length = 0;
  await status({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    commandTimeoutMs: 2_000,
  }, fixture.env);
  const preflightCall = surface.calls.find((call) => call.method === 'preflight');
  const agentsCall = surface.calls.find((call) => call.method === 'agents');
  const receiptCall = surface.calls.find((call) => call.method === 'executionReceipt');
  assert.ok(preflightCall.options.commandTimeoutMs <= 2_000);
  assert.ok(agentsCall.options.timeoutMs <= preflightCall.options.commandTimeoutMs);
  assert.ok(receiptCall.options.timeoutMs <= agentsCall.options.timeoutMs);
});

test('Claude stop does not replay an unknown provider mutation while the exact agent remains running', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  let stopMutations = 0;
  surface.run = async (_runtime, args, options) => {
    surface.calls.push({ method: 'run', args, options });
    assert.equal(args[0], 'stop');
    stopMutations += 1;
    const error = new Error('simulated stop transport timeout');
    error.code = 'ETIMEDOUT';
    throw error;
  };

  await assert.rejects(() => stop({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
  }, fixture.env), (error) => error.code === 'STOP_UNCERTAIN');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).state, 'unknown');

  await assert.rejects(() => stop({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
  }, fixture.env), (error) => error.code === 'STOP_UNCERTAIN' && /refusing to replay/.test(error.message));
  assert.equal(stopMutations, 1);
});

test('Claude emergency stop preserves another pending operation and does not duplicate an unknown mutation', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  surface.deliveryReceiptMissing = true;
  await assert.rejects(() => steer({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message: 'Leave an exact pending delivery receipt.',
    surface,
    steerVerifyTimeoutMs: 0,
    steerVerifyDelayMs: 0,
  }, fixture.env), (error) => error.code === 'DELIVERY_UNCERTAIN');
  const preserved = pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env);
  assert.equal(preserved.type, 'steer');

  let stopMutations = 0;
  surface.run = async (_runtime, args, options) => {
    surface.calls.push({ method: 'run', args, options });
    assert.equal(args[0], 'stop');
    stopMutations += 1;
    throw new Error('simulated emergency stop timeout');
  };
  const stopOptions = { repoRoot: fixture.repoRoot, laneId: lane.laneId, surface };
  await assert.rejects(() => stop(stopOptions, fixture.env), (error) => error.code === 'STOP_UNCERTAIN');
  await assert.rejects(() => stop(stopOptions, fixture.env), (error) => error.code === 'STOP_UNCERTAIN');

  assert.equal(stopMutations, 1);
  assert.equal(
    pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).operationId,
    preserved.operationId,
  );
  const emergencies = listOperations(fixture.repoRoot, fixture.env).filter((operation) =>
    operation.type === 'stop' && operation.details.emergency === true
  );
  assert.equal(emergencies.length, 1);
  assert.equal(emergencies[0].state, 'unknown');
  assert.equal(emergencies[0].details.preservedPendingOperationId, preserved.operationId);
});

test('Claude post-dispatch recovery protocol errors remain mutation-uncertain', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  await stop({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    stopVerifyAttempts: 1,
  }, fixture.env);
  surface.failDiscoveryOnce = true;
  surface.discoveryErrorCode = 'PROTOCOL_ERROR';

  let caught;
  try {
    await recover({
      repoRoot: fixture.repoRoot,
      laneId: lane.laneId,
      surface,
      recoveryVerifyAttempts: 1,
    }, fixture.env);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.code, 'RECOVERY_UNCERTAIN');
  assert.equal(caught?.details.causeCode, 'PROTOCOL_ERROR');
  assert.deepEqual(errorEffect(caught.code), { providerMutation: 'unknown' });
  assert.equal(surface.calls.filter((call) => call.method === 'run' && call.args[0] === '--resume').length, 1);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).state, 'unknown');

  surface.failDiscoveryOnce = true;
  await assert.rejects(() => recover({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    recoveryVerifyAttempts: 1,
  }, fixture.env), (error) =>
    error.code === 'RECOVERY_UNCERTAIN' && error.details.causeCode === 'PROTOCOL_ERROR'
  );
  assert.equal(surface.calls.filter((call) => call.method === 'run' && call.args[0] === '--resume').length, 1);
});

test('Claude retirement archives but defers local removal for an external seat', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  const order = [];
  const privateApi = {
    preflight() { order.push('private-preflight'); },
    async ensureArchived() {
      order.push('remote-archived');
      return { archived: true, alreadyArchived: false };
    },
  };
  const originalRun = surface.run;
  surface.run = async (...args) => {
    order.push(args[1][0]);
    return originalRun(...args);
  };
  const result = await retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    privateApi,
    privateArchive: true,
    harvestedOutputSha256: 'a'.repeat(64),
    stopVerifyAttempts: 2,
    stopVerifyDelayMs: 0,
    removeVerifyAttempts: 2,
    removeVerifyDelayMs: 0,
  }, fixture.env);
  assert.deepEqual(order, ['private-preflight', 'stop', 'remote-archived']);
  assert.equal(result.state, 'archivedVerified');
  assert.equal(result.receipt.remoteArchived, true);
  assert.equal(result.receipt.localJobRemoved, false);
  assert.equal(result.receipt.localRemovalDeferred, true);
  assert.equal(fs.existsSync(fixture.seat), true);
  const retirement = listOperations(fixture.repoRoot, fixture.env)
    .find((operation) => operation.type === 'retire');
  assert.equal(retirement.details.localRemovalDeferred, true);
});

test('Claude retirement reports a verified stop when archive auth fails before dispatch', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  const privateApi = {
    preflight() {},
    async ensureArchived() {
      const error = new Error('Keychain credential unavailable');
      error.code = 'PRIVATE_AUTH_UNAVAILABLE';
      throw error;
    },
  };
  let caught;
  try {
    await retire({
      repoRoot: fixture.repoRoot,
      laneId: lane.laneId,
      surface,
      privateApi,
      privateArchive: true,
      harvestedOutputSha256: '9'.repeat(64),
      stopVerifyAttempts: 1,
    }, fixture.env);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.code, 'PRIVATE_AUTH_UNAVAILABLE');
  assert.deepEqual(errorEffect(caught.code, caught.details), {
    providerMutation: 'verified',
    stop: 'verified',
    archive: 'notAttempted',
  });
  assert.equal(
    surface.calls.filter((call) => call.method === 'run' && call.args[0] === 'stop').length,
    1,
  );
  const pending = pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env);
  assert.equal(pending.state, 'archiveNotDispatched');
  assert.equal(pending.details.stopVerified, true);
  assert.equal(pending.details.archiveNotDispatched, true);
  assert.equal(
    listLanes(fixture.repoRoot, fixture.env)
      .find((candidate) => candidate.laneId === lane.laneId).state,
    'retireRequested',
  );
});

test('Claude managed retirement removes the guarded worktree before its exact local record', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  const options = spawnOptions(fixture, surface);
  delete options.cwd;
  const spawned = await spawn(options, fixture.env);
  const lane = listLanes(fixture.repoRoot, fixture.env)
    .find((candidate) => candidate.laneId === spawned.laneId);
  const order = [];
  const privateApi = {
    preflight() { order.push('private-preflight'); },
    async ensureArchived() {
      order.push('remote-archived');
      return { archived: true, alreadyArchived: false };
    },
  };
  const originalRun = surface.run;
  surface.run = async (...args) => {
    const command = args[1][0];
    order.push(command);
    if (command === 'rm') assert.equal(fs.existsSync(lane.seat.path), false);
    return originalRun(...args);
  };
  const result = await retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    privateApi,
    privateArchive: true,
    harvestedOutputSha256: '2'.repeat(64),
    stopVerifyAttempts: 1,
    removeVerifyAttempts: 1,
  }, fixture.env);
  assert.deepEqual(order, ['private-preflight', 'stop', 'remote-archived', 'rm']);
  assert.equal(result.state, 'worktreeRemoved');
  assert.equal(result.receipt.localJobRemoved, true);
  assert.equal(fs.existsSync(lane.seat.path), false);
});

test('Claude retirement private preflight failure performs no provider mutation', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  const privateApi = {
    preflight() {
      const error = new Error('unverified private build');
      error.code = 'UNVERIFIED_PRIVATE_VERSION';
      throw error;
    },
  };
  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    privateApi,
    privateArchive: true,
    harvestedOutputSha256: 'b'.repeat(64),
  }, fixture.env), /unverified private build/);
  assert.equal(surface.calls.some((call) => call.method === 'run'), false);
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'active');
});

test('Claude reconcile clears a terminal operation pointer without provider replay', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  const operation = beginLaneOperation(fixture.repoRoot, lane.laneId, {
    type: 'steer',
    details: { messageSha256: '9'.repeat(64) },
  }, fixture.env);
  updatePendingLaneOperation(fixture.repoRoot, lane.laneId, operation.operationId, {
    state: 'complete',
  }, fixture.env);
  surface.calls.length = 0;

  const result = await reconcile({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
  }, fixture.env);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].outcome, 'terminalOperationPointerCleared');
  assert.equal(result.results[0].delivery, 'confirmed');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  assert.deepEqual(surface.calls, []);
});

function reserveUnstartedClaudeLane(fixture, operationState = 'planned') {
  const laneId = require('node:crypto').randomUUID();
  const operationId = require('node:crypto').randomUUID();
  const spawnNonce = require('node:crypto').randomUUID();
  const name = '::: unstarted Claude recovery';
  const paths = projectPaths(fixture.repoRoot, fixture.env);
  const runtime = fakeRuntime();
  delete runtime.cleanEnv;
  delete runtime.orgId;
  reserveSpawn(fixture.repoRoot, {
    operation: {
      operationId,
      type: 'spawn',
      laneId,
      details: {
        target: 'claude',
        name,
        promptSha256: 'a'.repeat(64),
        promptMarkerSha256: 'b'.repeat(64),
        spawnNonce,
        stdoutPath: path.join(paths.operations, `${operationId}.spawn.stdout`),
        stderrPath: path.join(paths.operations, `${operationId}.spawn.stderr`),
      },
    },
    lane: {
      laneId,
      backend: 'claude-code',
      target: 'claude',
      displayName: name,
      state: 'planned',
      operationId,
      runtime,
      seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot),
      capabilities: {},
      providerIdentity: {
        version: 1,
        sessionId: null,
        jobId: null,
        bridgeId: null,
        executionEpochs: [],
        runtimeEpochs: [],
      },
      spawnIntent: {
        operationId,
        spawnNonce,
        displayName: name,
        promptSha256: 'a'.repeat(64),
        promptMarkerSha256: 'b'.repeat(64),
        preflightSessionIds: [],
        stdoutPath: path.join(paths.operations, `${operationId}.spawn.stdout`),
        stderrPath: path.join(paths.operations, `${operationId}.spawn.stderr`),
      },
    },
  }, fixture.env);
  if (operationState !== 'planned') {
    updatePendingLaneOperation(fixture.repoRoot, laneId, operationId, {
      state: operationState,
    }, fixture.env);
  }
  return { laneId, operationId };
}

for (const operationState of ['planned', 'seatReady']) {
  test(`Claude reconcile proves an unstarted ${operationState} spawn was not delivered`, async (t) => {
    const fixture = createRepoWithSeat(t);
    const surface = createFakeSurface();
    const { laneId } = reserveUnstartedClaudeLane(fixture, operationState);
    surface.calls.length = 0;
    const result = await reconcile({ repoRoot: fixture.repoRoot, laneId, surface }, fixture.env);
    assert.equal(result.ok, true);
    assert.equal(result.results[0].outcome, 'spawnNotDelivered');
    assert.equal(result.results[0].delivery, 'notDelivered');
    assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'failed');
    assert.equal(pendingOperationForLane(fixture.repoRoot, laneId, fixture.env), null);
    assert.deepEqual(surface.calls, []);
  });
}

test('Claude reconcile repairs a providerless spawn after its terminal pointer was already cleared', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  const { laneId, operationId } = reserveUnstartedClaudeLane(fixture);
  completeLaneOperation(fixture.repoRoot, laneId, operationId, {
    state: 'notDelivered',
  }, fixture.env);
  surface.calls.length = 0;
  const result = await reconcile({ repoRoot: fixture.repoRoot, laneId, surface }, fixture.env);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].delivery, 'notDelivered');
  assert.deepEqual(result.results[0].repaired, ['failedSpawnState']);
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'failed');
  assert.equal(pendingOperationForLane(fixture.repoRoot, laneId, fixture.env), null);
  assert.deepEqual(surface.calls, []);
});

test('Claude reconcile binds only an exact job from the durable spawn receipt and never respawns', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  surface.failDiscoveryOnce = true;
  await assert.rejects(() => spawn(spawnOptions(fixture, surface), fixture.env), /simulated crash boundary/);
  const uncertain = listLanes(fixture.repoRoot, fixture.env)[0];
  assert.equal(uncertain.providerId, null);
  assert.equal(uncertain.state, 'deliveryUnknown');
  assert.equal(fs.existsSync(uncertain.ownership.spawnIntent.stdoutPath), true);
  assert.equal(fs.existsSync(uncertain.ownership.spawnIntent.stderrPath), true);
  const launchesBefore = surface.calls.filter((call) => call.method === 'launch').length;
  // The whole reconcile shares one deadline; a loaded CI runner needs more than
  // a few hundred milliseconds for preflight, census, transcript, and worker
  // verification, while the deep-link dispatch below must still inherit it.
  const result = await reconcile({
    repoRoot: fixture.repoRoot,
    surface,
    discoveryAttempts: 2,
    discoveryDelayMs: 0,
    commandTimeoutMs: 3000,
  }, fixture.env);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].outcome, 'spawnBoundFromDurableReceipt');
  const rebound = listLanes(fixture.repoRoot, fixture.env)[0];
  assert.equal(rebound.providerId, SESSION_ID);
  assert.equal(fs.existsSync(rebound.ownership.spawnIntent.stdoutPath), false);
  assert.equal(fs.existsSync(rebound.ownership.spawnIntent.stderrPath), false);
  assert.equal(surface.calls.filter((call) => call.method === 'launch').length, launchesBefore);
  const presentation = surface.calls.find((call) => call.method === 'dispatchDeepLink');
  assert.ok(presentation.options.timeoutMs <= 3_000);
});

test('Claude reconcile finishes not-delivered spawn capture cleanup without provider replay', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  let launches = 0;
  surface.launch = async (_runtime, _args, options) => {
    launches += 1;
    fs.writeFileSync(options.stdoutPath, 'bounded provider output', { mode: 0o644 });
    fs.writeFileSync(options.stderrPath, 'bounded provider error', { mode: 0o644 });
    const error = new Error('provider executable was absent');
    error.code = 'ENOENT';
    throw error;
  };
  await assert.rejects(
    () => spawn(spawnOptions(fixture, surface), fixture.env),
    (error) => error.code === 'SPAWN_UNCERTAIN' && /unsafe to remove/.test(error.message),
  );
  const [blocked] = listLanes(fixture.repoRoot, fixture.env);
  assert.equal(blocked.state, 'failed');
  assert.equal(pendingOperationForLane(fixture.repoRoot, blocked.laneId, fixture.env).state,
    'notDeliveredCaptureCleanup');
  fs.chmodSync(blocked.ownership.spawnIntent.stdoutPath, 0o600);
  fs.chmodSync(blocked.ownership.spawnIntent.stderrPath, 0o600);

  const result = await reconcile({
    repoRoot: fixture.repoRoot,
    laneId: blocked.laneId,
    surface,
  }, fixture.env);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].outcome, 'spawnNotDelivered');
  assert.equal(launches, 1);
  assert.equal(pendingOperationForLane(fixture.repoRoot, blocked.laneId, fixture.env), null);
  assert.equal(fs.existsSync(blocked.ownership.spawnIntent.stdoutPath), false);
  assert.equal(fs.existsSync(blocked.ownership.spawnIntent.stderrPath), false);
});

test('Claude reconciliation refuses a selector journal mismatch without replaying spawn', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  surface.failDiscoveryOnce = true;
  await assert.rejects(() => spawn({
    ...spawnOptions(fixture, surface),
    model: 'claude-opus-5',
  }, fixture.env), /simulated crash boundary/);
  const [operation] = listOperations(fixture.repoRoot, fixture.env);
  const { operations } = projectPaths(fixture.repoRoot, fixture.env);
  const file = path.join(operations, `${operation.operationId}.json`);
  const corrupt = JSON.parse(fs.readFileSync(file, 'utf8'));
  corrupt.details.modelSelector = 'claude-sonnet-5';
  fs.writeFileSync(file, `${JSON.stringify(corrupt, null, 2)}\n`, { mode: 0o600 });
  const launchesBefore = surface.calls.filter((call) => call.method === 'launch').length;

  const result = await reconcile({
    repoRoot: fixture.repoRoot,
    laneId: listLanes(fixture.repoRoot, fixture.env)[0].laneId,
    surface,
  }, fixture.env);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].code, 'OWNERSHIP_MISMATCH');
  assert.equal(surface.calls.filter((call) => call.method === 'launch').length, launchesBefore);
});

test('Claude spawn refuses provider binding without the exact prompt-marker transcript receipt', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  surface.failSpawnTranscript = true;
  await assert.rejects(
    () => spawn(spawnOptions(fixture, surface), fixture.env),
    (error) => error.code === 'SPAWN_UNCERTAIN' && /not uniquely receipted/.test(error.message),
  );
  const [lane] = listLanes(fixture.repoRoot, fixture.env);
  assert.equal(lane.providerId, null);
  assert.equal(lane.state, 'deliveryUnknown');
  assert.equal(surface.calls.some((call) => call.method === 'discoverExecution'), false);
});

test('Claude post-dispatch spawn protocol errors remain mutation-uncertain', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  surface.failDiscoveryOnce = true;
  surface.discoveryErrorCode = 'PROTOCOL_ERROR';
  let caught;
  try {
    await spawn(spawnOptions(fixture, surface), fixture.env);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.code, 'SPAWN_UNCERTAIN');
  assert.equal(caught?.details.causeCode, 'PROTOCOL_ERROR');
  assert.deepEqual(errorEffect(caught.code), { providerMutation: 'unknown' });
  assert.equal(surface.calls.filter((call) => call.method === 'launch').length, 1);
});

test('Claude presentation failure preserves one completed provider lane and reconcile retries only presentation', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  surface.deepLinkFailures = 1;
  const spawned = await spawn(spawnOptions(fixture, surface), fixture.env);
  assert.equal(spawned.receipt.presentation, 'dispatchUnknown');
  let lanes = listLanes(fixture.repoRoot, fixture.env);
  assert.equal(lanes.length, 1);
  assert.equal(['active', 'idle'].includes(lanes[0].state), true);
  assert.equal(lanes[0].providerId, SESSION_ID);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lanes[0].laneId, fixture.env), null);
  assert.equal(listOperations(fixture.repoRoot, fixture.env)[0].state, 'complete');
  const launches = surface.calls.filter((call) => call.method === 'launch').length;
  const callsBeforeReconcile = surface.calls.length;

  const repaired = await reconcile({
    repoRoot: fixture.repoRoot,
    laneId: lanes[0].laneId,
    surface,
    commandTimeoutMs: 2_000,
  }, fixture.env);
  assert.equal(repaired.results[0].outcome, 'repaired');
  assert.deepEqual(repaired.results[0].repaired, ['presentation']);
  lanes = listLanes(fixture.repoRoot, fixture.env);
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].visibility.state, 'deepLinkDispatched');
  assert.equal(surface.calls.filter((call) => call.method === 'launch').length, launches);
  const calls = surface.calls.slice(callsBeforeReconcile).filter((call) => [
    'preflight', 'agents', 'discoverExecution', 'dispatchDeepLink',
  ].includes(call.method));
  const timeouts = calls.map((call) => call.method === 'preflight'
    ? call.options.commandTimeoutMs : call.options.timeoutMs);
  assert.equal(timeouts.every((timeout) => Number.isInteger(timeout) && timeout > 0), true);
  assert.deepEqual([...timeouts].sort((a, b) => b - a), timeouts);
});

test('Claude status journals an externally stopped exact session as stopped', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  surface.setRows(surface.getRows().map((row) => ({ ...row, pid: null, status: 'stopped' })));
  const result = await status({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
  }, fixture.env);
  assert.equal(result.phase, 'stopped');
  assert.equal(result.state, 'stopped');
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'stopped');
  assert.equal(surface.calls.some((call) => call.method === 'run'), false);
});

test('Claude short-job collisions block stop and local removal before either destructive command', async (t) => {
  const first = await spawnedLane(t);
  first.surface.setRows([...first.surface.getRows(), {
    cwd: first.fixture.seat,
    id: '11111111',
    kind: 'background',
    name: '[foreign] collision',
    pid: 303,
    sessionId: '11111111-2222-4222-8222-222222222222',
    startedAt: Date.now(),
    status: 'idle',
  }]);
  await assert.rejects(() => stop({
    repoRoot: first.fixture.repoRoot,
    laneId: first.lane.laneId,
    surface: first.surface,
  }, first.fixture.env), (error) =>
    error.code === 'OWNERSHIP_MISMATCH' && /short job id is not unique/.test(error.message)
  );
  assert.equal(first.surface.calls.some((call) => call.method === 'run'), false);

  const secondFixture = createRepoWithSeat(t);
  const secondSurface = createFakeSurface();
  const secondOptions = spawnOptions(secondFixture, secondSurface);
  delete secondOptions.cwd;
  const secondSpawn = await spawn(secondOptions, secondFixture.env);
  const secondLane = listLanes(secondFixture.repoRoot, secondFixture.env)
    .find((candidate) => candidate.laneId === secondSpawn.laneId);
  secondSurface.setRows(secondSurface.getRows().map((row) => ({
    ...row, pid: null, status: 'stopped',
  })));
  let archiveCalls = 0;
  const privateApi = {
    preflight() {},
    async ensureArchived() {
      archiveCalls += 1;
      secondSurface.setRows([...secondSurface.getRows(), {
        cwd: secondLane.seat.path,
        id: '11111111',
        kind: 'background',
        name: '[foreign] collision after archive',
        pid: null,
        sessionId: '11111111-3333-4333-8333-333333333333',
        startedAt: Date.now(),
        status: 'stopped',
      }]);
      return { archived: true, alreadyArchived: false };
    },
  };
  await assert.rejects(() => retire({
    repoRoot: secondFixture.repoRoot,
    laneId: secondLane.laneId,
    surface: secondSurface,
    privateApi,
    privateArchive: true,
    harvestedOutputSha256: 'c'.repeat(64),
  }, secondFixture.env), (error) => error.code === 'OWNERSHIP_MISMATCH');
  assert.equal(archiveCalls, 1);
  assert.equal(fs.existsSync(secondLane.seat.path), false);
  assert.equal(secondSurface.calls.some((call) => call.method === 'run' && call.args[0] === 'rm'), false);
});

test('Claude local removal rechecks short-job uniqueness immediately before rm dispatch', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  const options = spawnOptions(fixture, surface);
  delete options.cwd;
  const spawned = await spawn(options, fixture.env);
  const lane = listLanes(fixture.repoRoot, fixture.env)
    .find((candidate) => candidate.laneId === spawned.laneId);
  surface.setRows(surface.getRows().map((row) => ({ ...row, pid: null, status: 'stopped' })));
  let collisionAdded = false;
  let postCleanupCensuses = 0;
  surface.onAgents = (rows) => {
    const pending = pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env);
    if (pending?.state !== 'worktreeRemoved' || collisionAdded) return;
    postCleanupCensuses += 1;
    if (postCleanupCensuses !== 2) return;
    collisionAdded = true;
    rows.push({
      cwd: '/tmp/foreign',
      id: lane.providerIdentity.jobId,
      kind: 'background',
      name: '[foreign] collision',
      pid: null,
      sessionId: `${lane.providerIdentity.jobId}-2222-4222-8222-222222222222`,
      startedAt: new Date().toISOString(),
      status: 'stopped',
    });
  };
  const privateApi = {
    preflight() {},
    async ensureArchived() { return { archived: true, alreadyArchived: false }; },
  };

  let caught;
  try {
    await retire({
      repoRoot: fixture.repoRoot,
      laneId: lane.laneId,
      surface,
      privateApi,
      privateArchive: true,
      harvestedOutputSha256: '3'.repeat(64),
      removeVerifyAttempts: 1,
    }, fixture.env);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.code, 'OWNERSHIP_MISMATCH');
  assert.deepEqual(errorEffect(caught.code, caught.details), {
    providerMutation: 'verified',
    stop: 'verified',
    archive: 'verified',
    cleanup: 'verified',
    localRemoval: 'notAttempted',
  });
  assert.equal(collisionAdded, true);
  assert.equal(
    surface.calls.some((call) => call.method === 'run' && call.args[0] === 'rm'),
    false,
  );
  assert.equal(fs.existsSync(lane.seat.path), false);
  assert.equal(
    pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).state,
    'worktreeRemoved',
  );
  surface.setRows(surface.getRows().filter((row) => row.sessionId === lane.providerId));
  const retried = await retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    removeVerifyAttempts: 1,
  }, fixture.env);
  assert.equal(retried.state, 'worktreeRemoved');
  assert.equal(
    surface.calls.filter((call) => call.method === 'run' && call.args[0] === 'rm').length,
    1,
  );
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
});

test('Claude delayed steer receipt reconciles without writing the message twice', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  surface.deliveryReceiptMissing = true;
  await assert.rejects(() => steer({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message: 'Delayed but unique.',
    surface,
    steerVerifyTimeoutMs: 0,
    steerVerifyDelayMs: 0,
  }, fixture.env), (error) => error.code === 'DELIVERY_UNCERTAIN');
  assert.equal(surface.calls.filter((call) => call.method === 'sendRemoteFollowup').length, 1);
  const pending = pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env);
  assert.equal(pending.type, 'steer');
  assert.equal(pending.state, 'unknown');

  surface.deliveryReceiptMissing = false;
  const reconciled = await reconcile({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
  }, fixture.env);
  assert.equal(reconciled.results[0].outcome, 'steerDeliveredObserved');
  assert.equal(reconciled.results[0].state, 'active');
  assert.equal(surface.calls.filter((call) => call.method === 'sendRemoteFollowup').length, 1);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'active');
});

test('Claude pending steer reconciliation stops when its aggregate deadline is spent', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  surface.deliveryReceiptMissing = true;
  await assert.rejects(() => steer({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message: 'Observe this exactly once.',
    surface,
    steerVerifyTimeoutMs: 0,
    steerVerifyDelayMs: 0,
  }, fixture.env), (error) => error.code === 'DELIVERY_UNCERTAIN');
  surface.calls.length = 0;

  const originalNow = Date.now;
  const originalPreflight = surface.preflight.bind(surface);
  let now = 20_000;
  Date.now = () => now;
  surface.preflight = (options) => {
    const runtime = originalPreflight(options);
    now += 500;
    return runtime;
  };
  let reconciled;
  try {
    reconciled = await reconcile({
      repoRoot: fixture.repoRoot,
      laneId: lane.laneId,
      surface,
      commandTimeoutMs: 400,
    }, fixture.env);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(reconciled.ok, false);
  assert.equal(reconciled.results[0].outcome, 'steerUnknown');
  assert.equal(surface.calls.some((call) => call.method === 'verifyDeliveryTranscript'), false);
});

test('Claude pending stop reconciliation receives the aggregate deadline remainder', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  const run = surface.run.bind(surface);
  surface.run = async (...args) => {
    await run(...args);
    throw new Error('stop response lost after effect');
  };
  await assert.rejects(() => stop({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    stopVerifyAttempts: 1,
  }, fixture.env), (error) => error.code === 'STOP_UNCERTAIN');
  surface.calls.length = 0;

  const reconciled = await reconcile({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    commandTimeoutMs: 2_000,
  }, fixture.env);
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.results[0].outcome, 'stoppedObserved');
  const preflightCall = surface.calls.find((call) => call.method === 'preflight');
  const agentsCall = surface.calls.find((call) => call.method === 'agents');
  assert.equal(Number.isInteger(agentsCall.options.timeoutMs), true);
  assert.equal(agentsCall.options.timeoutMs <= preflightCall.options.commandTimeoutMs, true);
});

test('Claude pending recovery reconciliation shares one deadline across observation', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  await stop({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    stopVerifyAttempts: 1,
  }, fixture.env);
  surface.failDiscoveryOnce = true;
  await assert.rejects(() => recover({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    recoveryVerifyAttempts: 1,
    recoveryVerifyDelayMs: 0,
  }, fixture.env), (error) => error.code === 'RECOVERY_UNCERTAIN');
  surface.calls.length = 0;

  const reconciled = await reconcile({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    commandTimeoutMs: 2_000,
    recoveryVerifyAttempts: 1,
    recoveryVerifyDelayMs: 0,
  }, fixture.env);
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.results[0].outcome, 'recoveryVerified');
  const calls = surface.calls.filter((call) => [
    'preflight', 'agents', 'discoverExecution', 'dispatchDeepLink',
  ].includes(call.method));
  const timeouts = calls.map((call) => call.method === 'preflight'
    ? call.options.commandTimeoutMs : call.options.timeoutMs);
  assert.equal(timeouts.every((timeout) => Number.isInteger(timeout) && timeout > 0), true);
  assert.deepEqual([...timeouts].sort((a, b) => b - a), timeouts);
});

test('Claude pending steer maps hostile receipt inspection to delivery-uncertain without replay', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  const message = 'Keep this mutation exactly once.';
  surface.deliveryReceiptMissing = true;
  await assert.rejects(() => steer({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message,
    surface,
    steerVerifyTimeoutMs: 0,
    steerVerifyDelayMs: 0,
  }, fixture.env), (error) => error.code === 'DELIVERY_UNCERTAIN');
  surface.deliveryReceiptErrorCode = 'UNSAFE_LOCAL_STATE';

  await assert.rejects(() => steer({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message,
    surface,
  }, fixture.env), (error) => error.code === 'DELIVERY_UNCERTAIN');
  assert.equal(surface.calls.filter((call) => call.method === 'sendRemoteFollowup').length, 1);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).state, 'unknown');
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'deliveryUnknown');
});

test('Claude recovery ignores unrelated concurrent rows but rejects a correlated same-seat copy', async (t) => {
  const unrelated = await spawnedLane(t);
  await stop({
    repoRoot: unrelated.fixture.repoRoot,
    laneId: unrelated.lane.laneId,
    surface: unrelated.surface,
    stopVerifyAttempts: 1,
  }, unrelated.fixture.env);
  unrelated.surface.resumeExtraRows = [{
    cwd: unrelated.fixture.seat,
    id: '33333333',
    kind: 'background',
    name: '[foreign] unrelated',
    pid: 303,
    sessionId: '33333333-3333-4333-8333-333333333333',
    startedAt: Date.now(),
    status: 'working',
  }];
  const recovered = await recover({
    repoRoot: unrelated.fixture.repoRoot,
    laneId: unrelated.lane.laneId,
    surface: unrelated.surface,
    recoveryVerifyAttempts: 1,
  }, unrelated.fixture.env);
  assert.equal(recovered.providerId, SESSION_ID);

  const correlated = await spawnedLane(t);
  await stop({
    repoRoot: correlated.fixture.repoRoot,
    laneId: correlated.lane.laneId,
    surface: correlated.surface,
    stopVerifyAttempts: 1,
  }, correlated.fixture.env);
  correlated.surface.resumeExtraRows = [{
    cwd: correlated.fixture.seat,
    id: '44444444',
    kind: 'background',
    name: '::: native Claude lane',
    pid: 404,
    sessionId: '44444444-4444-4444-8444-444444444444',
    startedAt: Date.now(),
    status: 'working',
  }];
  await assert.rejects(() => recover({
    repoRoot: correlated.fixture.repoRoot,
    laneId: correlated.lane.laneId,
    surface: correlated.surface,
    recoveryVerifyAttempts: 1,
  }, correlated.fixture.env), (error) =>
    error.code === 'FORKED_COPY' && error.details.causeCode === 'FORKED_COPY' &&
    error.details.copiesStopped === 1 && /fork/.test(error.details.ownerAction)
  );
  // The fork was created by this recovery's own command, so it is stopped,
  // never removed, and never adopted; the lane returns to stopped with a
  // closed journal.
  const copyCalls = correlated.surface.calls.filter((call) =>
    call.method === 'run' && call.args.some((argument) => argument === '44444444'));
  assert.deepEqual(copyCalls.map((call) => call.args[0]), ['stop']);
  assert.equal(correlated.surface.getRows().find((row) => row.id === '44444444').status, 'stopped');
  assert.equal(pendingOperationForLane(correlated.fixture.repoRoot, correlated.lane.laneId, correlated.fixture.env), null);
  assert.equal(listLanes(correlated.fixture.repoRoot, correlated.fixture.env)
    .find((entry) => entry.laneId === correlated.lane.laneId).state, 'stopped');
  const recoverOperation = listOperations(correlated.fixture.repoRoot, correlated.fixture.env)
    .find((operation) => operation.type === 'recover' && operation.laneId === correlated.lane.laneId);
  assert.equal(recoverOperation.state, 'failed');
  assert.equal(recoverOperation.details.outcome, 'forkedCopyStopped');
});

test('Claude reconcile settles a recovery that never produced a running session', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  await stop({ repoRoot: fixture.repoRoot, laneId: lane.laneId, surface, stopVerifyAttempts: 1 }, fixture.env);
  surface.resumeDoesNothing = true;
  await assert.rejects(() => recover({
    repoRoot: fixture.repoRoot, laneId: lane.laneId, surface,
    recoveryVerifyAttempts: 1, recoveryVerifyDelayMs: 0, commandTimeoutMs: 1000, recoveryWindowSlackMs: 0,
  }, fixture.env), (error) => error.code === 'RECOVERY_UNCERTAIN');
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'deliveryUnknown');
  const early = await reconcile({
    repoRoot: fixture.repoRoot, laneId: lane.laneId, surface, recoveryVerifyAttempts: 1, recoveryVerifyDelayMs: 0,
  }, fixture.env);
  assert.equal(early.results[0].outcome, 'recoveryUnknown');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const result = await reconcile({
    repoRoot: fixture.repoRoot, laneId: lane.laneId, surface, recoveryVerifyAttempts: 1, recoveryVerifyDelayMs: 0,
  }, fixture.env);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].outcome, 'recoveryNotAchieved');
  assert.equal(result.results[0].state, 'stopped');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  assert.equal(surface.calls.filter((call) => call.method === 'run' && call.args[0] === '--resume').length, 1);
});

test('Claude retirement without a harvest digest performs no provider or private mutation', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  let privateCalls = 0;
  const privateApi = {
    preflight() { privateCalls += 1; },
    async ensureArchived() { privateCalls += 1; },
  };
  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    privateApi,
    privateArchive: true,
  }, fixture.env), (error) => error.code === 'HARVEST_REQUIRED');
  assert.equal(privateCalls, 0);
  assert.equal(surface.calls.some((call) => call.method === 'run'), false);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
});

test('Claude external retirement remains locally deferred when the exact session disappears after archive', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  surface.setRows(surface.getRows().map((row) => ({ ...row, pid: null, status: 'stopped' })));
  const privateApi = {
    preflight() {},
    async ensureArchived() {
      surface.setRows([]);
      return { archived: true, alreadyArchived: false };
    },
  };
  const retired = await retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    privateApi,
    privateArchive: true,
    harvestedOutputSha256: 'd'.repeat(64),
    removeVerifyAttempts: 1,
  }, fixture.env);
  assert.equal(retired.state, 'archivedVerified');
  assert.equal(retired.receipt.localJobRemoved, false);
  assert.equal(retired.receipt.localRemovalDeferred, true);
  assert.equal(surface.calls.some((call) => call.method === 'run' && call.args[0] === 'rm'), false);
});

test('Claude retirement never runs rm for a managed seat that was dirty at harvest', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  const options = spawnOptions(fixture, surface);
  delete options.cwd;
  const spawned = await spawn(options, fixture.env);
  const lane = listLanes(fixture.repoRoot, fixture.env)
    .find((candidate) => candidate.laneId === spawned.laneId);
  fs.writeFileSync(path.join(lane.seat.path, 'dirty-at-harvest.txt'), 'unharvested\n');
  const privateApi = {
    preflight() {},
    async ensureArchived() { return { archived: true, alreadyArchived: false }; },
  };
  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    privateApi,
    privateArchive: true,
    harvestedOutputSha256: '3'.repeat(64),
    stopVerifyAttempts: 1,
  }, fixture.env), (error) => error.code === 'CLEANUP_BLOCKED');
  assert.equal(fs.existsSync(lane.seat.path), true);
  assert.equal(surface.calls.some((call) => call.method === 'run' && call.args[0] === 'rm'), false);
});

test('Claude deferred managed cleanup retains its harvest and later cleans without provider calls', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  const options = spawnOptions(fixture, surface);
  delete options.cwd;
  const spawned = await spawn(options, fixture.env);
  let lane = listLanes(fixture.repoRoot, fixture.env)
    .find((candidate) => candidate.laneId === spawned.laneId);
  assert.equal(lane.seat.managed, true);
  surface.setRows(surface.getRows().map((row) => ({ ...row, pid: null, status: 'stopped' })));
  let archiveCalls = 0;
  const privateApi = {
    preflight() {},
    async ensureArchived() {
      archiveCalls += 1;
      surface.setRows([]);
      return { archived: true, alreadyArchived: false };
    },
  };
  const deferred = await retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    privateApi,
    privateArchive: true,
    cleanupWorktree: false,
    harvestedOutputSha256: 'e'.repeat(64),
    removeVerifyAttempts: 1,
  }, fixture.env);
  assert.equal(deferred.state, 'archivedVerified');
  assert.equal(deferred.receipt.localJobRemoved, false);
  assert.equal(deferred.receipt.localRemovalDeferred, true);
  assert.equal(fs.existsSync(lane.seat.path), true);
  const pending = pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env);
  assert.equal(pending.details.harvestReceipt.outputSha256, 'e'.repeat(64));
  assert.equal(surface.calls.some((call) => call.method === 'run' && call.args[0] === 'rm'), false);

  const cleaned = await retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
  }, fixture.env);
  assert.equal(cleaned.state, 'worktreeRemoved');
  assert.equal(cleaned.receipt.harvestedOutputSha256, 'e'.repeat(64));
  assert.equal(fs.existsSync(lane.seat.path), false);
  assert.equal(archiveCalls, 1);
  assert.equal(surface.calls.some((call) => call.method === 'run' && call.args[0] === 'rm'), false);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
});

test('Claude cleanup block remains permanent after the managed worktree is restored clean', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  const options = spawnOptions(fixture, surface);
  delete options.cwd;
  const spawned = await spawn(options, fixture.env);
  const lane = listLanes(fixture.repoRoot, fixture.env)
    .find((candidate) => candidate.laneId === spawned.laneId);
  fs.writeFileSync(path.join(lane.seat.path, '.gitignore'), 'ignored/\n');
  execFileSync('git', ['-C', lane.seat.path, 'add', '.gitignore']);
  execFileSync('git', ['-C', lane.seat.path, 'commit', '-qm', 'ignore cleanup fixture']);
  surface.setRows(surface.getRows().map((row) => ({ ...row, pid: null, status: 'stopped' })));
  const changedAfterHarvest = path.join(lane.seat.path, 'ignored', 'changed-after-harvest.txt');
  let archiveCalls = 0;
  const privateApi = {
    preflight() {},
    async ensureArchived() {
      archiveCalls += 1;
      fs.mkdirSync(path.dirname(changedAfterHarvest), { recursive: true });
      fs.writeFileSync(changedAfterHarvest, 'requires manual review\n');
      return { archived: true, alreadyArchived: false };
    },
  };

  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    privateApi,
    privateArchive: true,
    harvestedOutputSha256: '1'.repeat(64),
    removeVerifyAttempts: 1,
  }, fixture.env), (error) => error.code === 'CLEANUP_BLOCKED');
  const blocked = pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env);
  assert.equal(blocked.details.cleanupBlocked, true);
  assert.equal(fs.existsSync(lane.seat.path), true);
  assert.equal(surface.calls.some((call) => call.method === 'run' && call.args[0] === 'rm'), false);

  fs.unlinkSync(changedAfterHarvest);
  const providerCalls = surface.calls.length;
  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
  }, fixture.env), (error) => error.code === 'CLEANUP_BLOCKED' && error.details.providerRetired === true);
  assert.equal(fs.existsSync(lane.seat.path), true);
  assert.equal(surface.calls.length, providerCalls);
  assert.equal(archiveCalls, 1);
  assert.equal(surface.calls.some((call) => call.method === 'run' && call.args[0] === 'rm'), false);

  execFileSync('git', [
    '-C', fixture.repoRoot, 'worktree', 'remove', '--force', '--', lane.seat.path,
  ]);
  fs.symlinkSync(path.join(fixture.root, 'missing-seat-target'), lane.seat.path);
  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    acceptManualSeatRemoval: true,
    removeVerifyAttempts: 1,
  }, fixture.env), (error) => error.code === 'CLEANUP_BLOCKED');
  fs.unlinkSync(lane.seat.path);
  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    removeVerifyAttempts: 1,
  }, fixture.env), (error) => error.code === 'CLEANUP_BLOCKED');
  const reviewed = await retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    acceptManualSeatRemoval: true,
    removeVerifyAttempts: 1,
  }, fixture.env);
  assert.equal(reviewed.state, 'worktreeRemoved');
  assert.equal(reviewed.receipt.worktree.removed, true);
  assert.equal(archiveCalls, 1);
  assert.equal(fs.existsSync(lane.seat.path), false);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
});

test('Claude retire leaves a transient local cleanup failure retryable without replaying archive', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  const options = spawnOptions(fixture, surface);
  delete options.cwd;
  const spawned = await spawn(options, fixture.env);
  const lane = listLanes(fixture.repoRoot, fixture.env)
    .find((candidate) => candidate.laneId === spawned.laneId);
  surface.setRows(surface.getRows().map((row) => ({ ...row, pid: null, status: 'stopped' })));
  let archiveCalls = 0;
  const privateApi = {
    preflight() {},
    async ensureArchived() {
      archiveCalls += 1;
      execFileSync('git', [
        '-C', fixture.repoRoot, 'worktree', 'lock', '--reason', 'transient test lock', '--', lane.seat.path,
      ]);
      return { archived: true, alreadyArchived: false };
    },
  };

  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    privateApi,
    privateArchive: true,
    harvestedOutputSha256: '2'.repeat(64),
    removeVerifyAttempts: 1,
  }, fixture.env), (error) =>
    error.code === 'CLEANUP_RETRYABLE' && error.details.providerRetired === true
  );
  const pending = pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env);
  assert.equal(pending.state, 'providerRetiredCleanupDeferred');
  assert.equal(pending.details.cleanupRetryable, true);
  assert.equal(pending.details.cleanupBlocked, undefined);
  const reconciled = await reconcile({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    finishRetirements: true,
  }, fixture.env);
  assert.equal(reconciled.ok, false);
  assert.equal(reconciled.results[0].outcome, 'cleanupRetryable');
  assert.equal(reconciled.results[0].code, 'CLEANUP_RETRYABLE');
  assert.equal(reconciled.results[0].providerRetired, true);
  assert.equal(reconciled.results[0].cleanup, 'retryable');
  assert.equal(archiveCalls, 1);
  const providerCalls = surface.calls.length;
  execFileSync('git', ['-C', fixture.repoRoot, 'worktree', 'unlock', '--', lane.seat.path]);

  const retried = await retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    removeVerifyAttempts: 1,
  }, fixture.env);
  assert.equal(retried.state, 'worktreeRemoved');
  assert.equal(archiveCalls, 1);
  assert.equal(
    surface.calls.slice(providerCalls)
      .filter((call) => call.method === 'run' && call.args[0] === 'rm').length,
    1,
  );
  assert.equal(fs.existsSync(lane.seat.path), false);
});

test('Claude retirement recovers after worktree removal and only then removes its local record', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  const options = spawnOptions(fixture, surface);
  delete options.cwd;
  const spawned = await spawn(options, fixture.env);
  let lane = listLanes(fixture.repoRoot, fixture.env)
    .find((candidate) => candidate.laneId === spawned.laneId);
  surface.setRows(surface.getRows().map((row) => ({ ...row, pid: null, status: 'stopped' })));
  const privateApi = {
    preflight() {},
    async ensureArchived() {
      return { archived: true, alreadyArchived: false };
    },
  };
  await retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    privateApi,
    privateArchive: true,
    cleanupWorktree: false,
    harvestedOutputSha256: 'f'.repeat(64),
    removeVerifyAttempts: 1,
  }, fixture.env);
  lane = listLanes(fixture.repoRoot, fixture.env)
    .find((candidate) => candidate.laneId === spawned.laneId);
  assert.equal(lane.state, 'archivedVerified');
  const harvestReceipt = pendingOperationForLane(
    fixture.repoRoot, lane.laneId, fixture.env,
  ).details.harvestReceipt;
  removeManagedSeat(fixture.repoRoot, lane.laneId, harvestReceipt, fixture.env);
  assert.equal(fs.existsSync(lane.seat.path), false);
  const originalRun = surface.run;
  let rmCalls = 0;
  surface.run = async (...args) => {
    if (args[1][0] === 'rm') {
      rmCalls += 1;
      assert.equal(fs.existsSync(lane.seat.path), false);
    }
    return originalRun(...args);
  };

  const recovered = await retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
  }, fixture.env);
  assert.equal(recovered.state, 'worktreeRemoved');
  assert.equal(recovered.receipt.worktree.recoveredAfterRemoval, true);
  assert.equal(recovered.receipt.harvestedOutputSha256, 'f'.repeat(64));
  assert.equal(rmCalls, 1);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
});

test('Claude retirement never replays an uncertain rm while the exact local record remains', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  const options = spawnOptions(fixture, surface);
  delete options.cwd;
  const spawned = await spawn(options, fixture.env);
  const lane = listLanes(fixture.repoRoot, fixture.env)
    .find((candidate) => candidate.laneId === spawned.laneId);
  const privateApi = {
    preflight() {},
    async ensureArchived() { return { archived: true, alreadyArchived: false }; },
  };
  const originalRun = surface.run;
  let rmCalls = 0;
  surface.run = async (...args) => {
    if (args[1][0] === 'rm') {
      rmCalls += 1;
      throw new Error('simulated rm timeout before observation');
    }
    return originalRun(...args);
  };
  const retirement = {
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    privateApi,
    privateArchive: true,
    harvestedOutputSha256: '4'.repeat(64),
    stopVerifyAttempts: 1,
  };
  await assert.rejects(() => retire(retirement, fixture.env),
    (error) => error.code === 'LOCAL_REMOVAL_UNCERTAIN');
  assert.equal(fs.existsSync(lane.seat.path), false);
  assert.equal(rmCalls, 1);

  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot, laneId: lane.laneId, surface,
  }, fixture.env), (error) =>
    error.code === 'LOCAL_REMOVAL_UNCERTAIN' && /refusing to replay/.test(error.message)
  );
  assert.equal(rmCalls, 1);
});

test('Claude retirement completes an uncertain rm only after observing the local record absent', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  const options = spawnOptions(fixture, surface);
  delete options.cwd;
  const spawned = await spawn(options, fixture.env);
  const lane = listLanes(fixture.repoRoot, fixture.env)
    .find((candidate) => candidate.laneId === spawned.laneId);
  const privateApi = {
    preflight() {},
    async ensureArchived() { return { archived: true, alreadyArchived: false }; },
  };
  const originalRun = surface.run;
  let rmCalls = 0;
  surface.run = async (...args) => {
    if (args[1][0] === 'rm') {
      rmCalls += 1;
      await originalRun(...args);
      throw new Error('simulated lost rm acknowledgment');
    }
    return originalRun(...args);
  };
  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    privateApi,
    privateArchive: true,
    harvestedOutputSha256: '5'.repeat(64),
    stopVerifyAttempts: 1,
  }, fixture.env), (error) => error.code === 'LOCAL_REMOVAL_UNCERTAIN');
  assert.equal(rmCalls, 1);

  const recovered = await retire({
    repoRoot: fixture.repoRoot, laneId: lane.laneId, surface,
  }, fixture.env);
  assert.equal(recovered.state, 'worktreeRemoved');
  assert.equal(recovered.receipt.localJobRemoved, true);
  assert.equal(rmCalls, 1);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
});

test('Claude reconcile with laneId inspects and mutates only that exact lane', async (t) => {
  const fixture = createRepoWithSeat(t);
  const firstSurface = createFakeSurface();
  const first = await spawn(spawnOptions(fixture, firstSurface), fixture.env);
  const secondSurface = createFakeSurface({
    sessionId: '22222222-2222-4222-8222-222222222222',
    bridgeId: 'session_secondBridge',
    pid: 202,
  });
  const secondOptions = spawnOptions(fixture, secondSurface);
  delete secondOptions.cwd;
  secondOptions.name = '[test] second native Claude lane';
  const second = await spawn(secondOptions, fixture.env);
  secondSurface.setRows(secondSurface.getRows().map((row) => ({
    ...row, pid: null, status: 'stopped',
  })));
  const secondBefore = listLanes(fixture.repoRoot, fixture.env)
    .find((lane) => lane.laneId === second.laneId);
  const secondCalls = secondSurface.calls.length;

  const result = await reconcile({
    repoRoot: fixture.repoRoot,
    laneId: first.laneId,
    surface: firstSurface,
  }, fixture.env);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].laneId, first.laneId);
  const secondAfter = listLanes(fixture.repoRoot, fixture.env)
    .find((lane) => lane.laneId === second.laneId);
  assert.equal(secondAfter.state, secondBefore.state);
  assert.equal(secondAfter.lastVerifiedAt, secondBefore.lastVerifiedAt);
  assert.equal(secondSurface.calls.length, secondCalls);
});

test('Claude reconciliation reports failure when an owned lane belongs to another runtime', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  const callsBefore = surface.calls.length;
  surface.runtime.accountFingerprint = 'c'.repeat(64);

  const result = await reconcile({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
  }, fixture.env);
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].outcome, 'differentRuntime');
  assert.deepEqual(
    surface.calls.slice(callsBefore).map((call) => call.method),
    ['preflight'],
  );
});

test('Claude reconciliation durably rebinds an exact owned worker after a verified CLI update', async (t) => {
  const { fixture, surface, lane } = await spawnedLane(t);
  surface.runtime.cliPath = '/tmp/fake-claude-2.1.258';
  surface.runtime.cliVersion = '2.1.258';
  surface.runtime.cliSha256 = 'f'.repeat(64);
  surface.setRows(surface.getRows().map((row) => ({
    ...row,
    pid: 202,
    status: 'idle',
    state: 'done',
  })));
  const callsBeforeReconcile = surface.calls.length;

  const result = await reconcile({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
    commandTimeoutMs: 2_000,
  }, fixture.env);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].outcome, 'runtimeRebound');
  assert.equal(result.results[0].runtimeTransition, 'verified');
  const rebound = listLanes(fixture.repoRoot, fixture.env)[0];
  assert.equal(rebound.runtime.cliVersion, '2.1.258');
  assert.equal(rebound.providerIdentity.runtimeEpochs.length, 1);
  assert.equal(rebound.providerIdentity.runtimeEpochs[0].runtime.cliVersion, '2.1.258');
  assert.equal(rebound.providerIdentity.executionEpochs.at(-1).pid, 202);
  const calls = surface.calls.slice(callsBeforeReconcile).filter((call) => [
    'preflight', 'agents', 'discoverExecution',
  ].includes(call.method));
  const timeouts = calls.map((call) => call.method === 'preflight'
    ? call.options.commandTimeoutMs : call.options.timeoutMs);
  assert.equal(timeouts.every((timeout) => Number.isInteger(timeout) && timeout > 0), true);
  assert.deepEqual([...timeouts].sort((a, b) => b - a), timeouts);

  const observed = await status({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    surface,
  }, fixture.env);
  assert.equal(observed.phase, 'idle');
  assert.equal(
    surface.calls.filter((call) => call.method === 'preflight').at(-1).options.claudeBin,
    '/tmp/fake-claude-2.1.258',
  );
});

test('Claude spawn surfaces the discovery cause when delivery is uncertain', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  surface.discoverExecution = () => {
    const error = new Error('simulated crash boundary: no bridge');
    error.code = 'REMOTE_CONTROL_UNAVAILABLE';
    throw error;
  };
  await assert.rejects(
    () => spawn(spawnOptions(fixture, surface), fixture.env),
    (error) => error.code === 'SPAWN_UNCERTAIN' &&
      error.details.causeCode === 'REMOTE_CONTROL_UNAVAILABLE' &&
      /simulated crash boundary/.test(error.details.causeMessage) &&
      /claude auth status/.test(error.details.ownerAction),
  );
  const [lane] = listLanes(fixture.repoRoot, fixture.env);
  const pending = pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env);
  assert.equal(pending.state, 'spawnUnknown');
  assert.equal(pending.details.causeCode, 'REMOTE_CONTROL_UNAVAILABLE');
  assert.match(pending.details.causeMessage, /simulated crash boundary/);
});

test('Claude reconcile settles a dispatched spawn whose job vanished as failed', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  surface.discoverExecution = () => {
    const error = new Error('simulated crash boundary: no bridge');
    error.code = 'REMOTE_CONTROL_UNAVAILABLE';
    throw error;
  };
  await assert.rejects(() => spawn(spawnOptions(fixture, surface), fixture.env), /simulated crash boundary/);
  const [uncertain] = listLanes(fixture.repoRoot, fixture.env);
  const pending = pendingOperationForLane(fixture.repoRoot, uncertain.laneId, fixture.env);
  const jobId = surface.jobId;

  // Too recent to settle: the job is missing but the launch might still be
  // registering, so the spawn stays open.
  surface.setRows([]);
  const early = await reconcile({
    repoRoot: fixture.repoRoot, surface, discoveryAttempts: 2, discoveryDelayMs: 0,
    spawnVerifyTimeoutMs: 300, spawnVerifyDelayMs: 20,
  }, fixture.env);
  assert.equal(early.results[0].outcome, 'uncertain');
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'deliveryUnknown');

  // Past the grace period, and absent on every poll: settle without any
  // provider mutation.
  const launchesBefore = surface.calls.filter((call) => call.method === 'launch').length;
  const runsBefore = surface.calls.filter((call) => call.method === 'run').length;
  const result = await reconcile({
    repoRoot: fixture.repoRoot, surface, discoveryAttempts: 2, discoveryDelayMs: 0, spawnAbsenceGraceMs: 0,
    commandTimeoutMs: 5000,
  }, fixture.env);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].outcome, 'spawnJobAbsent');
  // The census polls inside the settle path inherit the command deadline.
  const censusCalls = surface.calls.filter((call) => call.method === 'agents' && call.options.timeoutMs !== undefined);
  assert.ok(censusCalls.length >= 2, 'census polls carried a deadline');
  const [settled] = listLanes(fixture.repoRoot, fixture.env);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.providerId, null);
  assert.equal(pendingOperationForLane(fixture.repoRoot, settled.laneId, fixture.env), null);
  const [operation] = listOperations(fixture.repoRoot, fixture.env);
  assert.equal(operation.state, 'failed');
  assert.equal(operation.details.outcome, 'spawnJobAbsent');
  assert.equal(operation.details.jobId, jobId);
  assert.equal(operation.details.causeCode, 'REMOTE_CONTROL_UNAVAILABLE');
  assert.equal(fs.existsSync(uncertain.ownership.spawnIntent.stdoutPath), false);
  assert.equal(fs.existsSync(uncertain.ownership.spawnIntent.stderrPath), false);
  assert.equal(surface.calls.filter((call) => call.method === 'launch').length, launchesBefore);
  assert.equal(surface.calls.filter((call) => call.method === 'run').length, runsBefore);
});

test('Claude reconcile keeps an uncertain spawn open while its job is still listed without a bridge', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  surface.discoverExecution = () => {
    const error = new Error('Claude worker has no Remote Control bridge');
    error.code = 'REMOTE_CONTROL_UNAVAILABLE';
    throw error;
  };
  await assert.rejects(() => spawn(spawnOptions(fixture, surface), fixture.env), /no Remote Control bridge/);
  const [uncertain] = listLanes(fixture.repoRoot, fixture.env);
  const result = await reconcile({
    repoRoot: fixture.repoRoot, surface, discoveryAttempts: 2, discoveryDelayMs: 0, spawnAbsenceGraceMs: 0,
    spawnVerifyTimeoutMs: 300, spawnVerifyDelayMs: 20,
  }, fixture.env);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].outcome, 'uncertain');
  assert.equal(result.results[0].code, 'SPAWN_UNCERTAIN');
  assert.equal(result.results[0].causeCode, 'REMOTE_CONTROL_UNAVAILABLE');
  assert.match(result.results[0].ownerAction, /claude auth status/);
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'deliveryUnknown');
  assert.equal(pendingOperationForLane(fixture.repoRoot, uncertain.laneId, fixture.env).details.causeCode,
    'REMOTE_CONTROL_UNAVAILABLE');
});

test('Claude retire cleans the managed seat of a failed unbound lane without provider mutation', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  surface.failDiscoveryOnce = true;
  const options = spawnOptions(fixture, surface);
  delete options.cwd;
  await assert.rejects(() => spawn(options, fixture.env), /simulated crash boundary/);
  const [uncertain] = listLanes(fixture.repoRoot, fixture.env);
  assert.equal(uncertain.seat.managed, true);
  assert.equal(fs.existsSync(uncertain.seat.path), true);
  await assert.rejects(
    () => retire({
      repoRoot: fixture.repoRoot, laneId: uncertain.laneId, surface, harvestedOutputSha256: 'a'.repeat(64),
    }, fixture.env),
    (error) => error.code === 'PENDING_OPERATION' && /reconcile first/.test(error.message),
  );
  surface.setRows([]);
  const settled = await reconcile({
    repoRoot: fixture.repoRoot, surface, discoveryAttempts: 2, discoveryDelayMs: 0, spawnAbsenceGraceMs: 0,
  }, fixture.env);
  assert.equal(settled.results[0].outcome, 'spawnJobAbsent');
  await assert.rejects(
    () => retire({ repoRoot: fixture.repoRoot, laneId: uncertain.laneId, surface }, fixture.env),
    (error) => error.code === 'HARVEST_REQUIRED',
  );
  const runsBefore = surface.calls.filter((call) => call.method === 'run').length;
  const retired = await retire({
    repoRoot: fixture.repoRoot, laneId: uncertain.laneId, surface, harvestedOutputSha256: 'a'.repeat(64),
  }, fixture.env);
  assert.equal(retired.ok, true);
  assert.equal(retired.state, 'worktreeRemoved');
  assert.deepEqual(retired.receipt.provider, {
    unbound: true, stop: 'notAttempted', archive: 'notAttempted', localRemoval: 'notAttempted',
  });
  assert.equal(retired.receipt.worktree.removed, true);
  assert.equal(retired.receipt.harvestedOutputSha256, 'a'.repeat(64));
  assert.equal(fs.existsSync(uncertain.seat.path), false);
  assert.equal(surface.calls.filter((call) => call.method === 'run').length, runsBefore);
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'worktreeRemoved');
  assert.equal(pendingOperationForLane(fixture.repoRoot, uncertain.laneId, fixture.env), null);
  const again = await retire({
    repoRoot: fixture.repoRoot, laneId: uncertain.laneId, surface, harvestedOutputSha256: 'a'.repeat(64),
  }, fixture.env);
  assert.equal(again.receipt.alreadyRetired, true);
});

test('Claude retire of a failed unbound lane preserves an external seat', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  surface.failDiscoveryOnce = true;
  await assert.rejects(() => spawn(spawnOptions(fixture, surface), fixture.env), /simulated crash boundary/);
  const [uncertain] = listLanes(fixture.repoRoot, fixture.env);
  surface.setRows([]);
  await reconcile({
    repoRoot: fixture.repoRoot, surface, discoveryAttempts: 2, discoveryDelayMs: 0, spawnAbsenceGraceMs: 0,
  }, fixture.env);
  const retired = await retire({
    repoRoot: fixture.repoRoot, laneId: uncertain.laneId, surface, harvestedOutputSha256: 'b'.repeat(64),
  }, fixture.env);
  assert.equal(retired.ok, true);
  assert.equal(retired.receipt.worktree.external, true);
  assert.equal(fs.existsSync(fixture.seat), true);
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'worktreeRemoved');
});

test('Claude spawn waits for the transcript receipt and the Remote Control bridge to appear', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  let transcriptReads = 0;
  let discoveries = 0;
  const originalTranscript = surface.verifySpawnTranscript;
  const originalDiscovery = surface.discoverExecution;
  surface.verifySpawnTranscript = (...args) => {
    transcriptReads += 1;
    if (transcriptReads < 3) {
      const error = new Error('Claude spawn prompt is not receipted in the transcript yet');
      error.code = 'TRANSCRIPT_RECEIPT_PENDING';
      throw error;
    }
    return originalTranscript(...args);
  };
  surface.discoverExecution = (...args) => {
    discoveries += 1;
    if (discoveries < 3) {
      const error = new Error('Claude worker has no Remote Control bridge');
      error.code = 'REMOTE_CONTROL_UNAVAILABLE';
      throw error;
    }
    return originalDiscovery(...args);
  };
  const result = await spawn({
    ...spawnOptions(fixture, surface), spawnVerifyTimeoutMs: 5_000, spawnVerifyDelayMs: 5,
  }, fixture.env);
  assert.equal(result.ok, true);
  assert.equal(transcriptReads, 3);
  assert.equal(discoveries, 3);
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'active');
  assert.equal(surface.calls.filter((call) => call.method === 'launch').length, 1);
});

test('Claude spawn gives up on a receipt that never arrives once the window closes', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  surface.verifySpawnTranscript = () => {
    const error = new Error('Claude spawn prompt is not receipted in the transcript yet');
    error.code = 'TRANSCRIPT_RECEIPT_PENDING';
    throw error;
  };
  await assert.rejects(
    () => spawn({ ...spawnOptions(fixture, surface), spawnVerifyTimeoutMs: 100, spawnVerifyDelayMs: 10 }, fixture.env),
    (error) => error.code === 'SPAWN_UNCERTAIN' && error.details.causeCode === 'TRANSCRIPT_RECEIPT_PENDING',
  );
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'deliveryUnknown');
});

test('Claude fast-loop dispatch renders provenance for a model with no effort selector', async (t) => {
  const fixture = createRepoWithSeat(t);
  const surface = createFakeSurface();
  const parentContext = createParentContext({
    hostProvider: 'codex', hostApp: 'codex-desktop', displayName: 'Acceptance: Codex host',
  }, fixture.env);
  const result = await spawn({
    ...spawnOptions(fixture, surface), parentContext, intent: 'fast-loop',
  }, fixture.env);
  assert.equal(result.ok, true);
  const launch = surface.calls.find((call) => call.method === 'launch');
  assert.ok(launch.args.includes('claude-haiku-4-5-20251001'));
  assert.equal(launch.args.includes('--effort'), false);
  const prompt = launch.args[launch.args.length - 1];
  assert.match(prompt, /^│ To {8}Claude Code · claude-haiku-4-5-20251001 · standard speed$/m);
  assert.match(prompt, /^│ Intent {4}fast-loop$/m);
  const [lane] = listLanes(fixture.repoRoot, fixture.env);
  assert.equal(lane.executionProfile.resolved.effort.level, null);
});
