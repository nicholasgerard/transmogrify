'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');
const {
  executionCapabilities,
  interrupt,
  recover,
  resume,
  retire,
  spawn,
  status,
  steer,
} = require('../scripts/lib/codex-adapter');
const { AppServerClient } = require('../scripts/lib/app-server');
const {
  beginLaneOperation,
  completeLaneOperation,
  listLanes,
  listOperations,
  pendingOperationForLane,
  registerLane,
  requireOwnedLane,
  reserveSpawn,
  updateLane,
  updatePendingLaneOperation,
} = require('../scripts/lib/state');
const {
  captureHarvestReceipt,
  createManagedSeat,
  removeManagedSeat,
  verifySeat,
} = require('../scripts/lib/worktree');
const { createParentContext, listEvents, readDispatch } = require('../scripts/lib/dispatch');
const { NO_RESPONSE, startMockAppServer } = require('./helpers/mock-app-server');
const { createRepoWithSeat } = require('./helpers/repo-fixture');

function baseOptions(fixture, url) {
  return {
    repoRoot: fixture.repoRoot,
    worktrees: fixture.worktreesRoot,
    cwd: fixture.seat,
    url,
    allowProtocolOnly: true,
    name: 'lane: materialize before name',
    input: 'Return one short sentence without using tools.',
  };
}

function turnStartResult(request, id, status = 'inProgress') {
  return { result: { turn: {
    id,
    status,
    items: [{
      id: `user-${id}`,
      type: 'userMessage',
      clientId: request.params.clientUserMessageId,
      content: request.params.input,
    }],
  } } };
}

function providerCwd(fixture) {
  return fs.realpathSync(fixture.seat);
}

function threadStartResult(fixture, id) {
  const cwd = providerCwd(fixture);
  return { result: { cwd, thread: { id, cwd } } };
}

function threadReadResult(fixture, thread) {
  return { result: { thread: { ...thread, cwd: providerCwd(fixture) } } };
}

function threadReadAt(cwd, thread) {
  return { result: { thread: { ...thread, cwd } } };
}

test('Codex spawn fails closed without explicit protocol-only authorization', async (t) => {
  const fixture = createRepoWithSeat(t);
  await assert.rejects(
    () => spawn({
      ...baseOptions(fixture, 'ws://127.0.0.1:65534'),
      allowProtocolOnly: false,
    }, fixture.env),
    (error) => error.code === 'NATIVE_VISIBILITY_REQUIRED',
  );
  assert.deepEqual(listLanes(fixture.repoRoot, fixture.env), []);
  assert.deepEqual(listOperations(fixture.repoRoot, fixture.env), []);
});

test('Codex spawn records a measured Desktop attachment receipt without the protocol-only flag', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request, socket) => {
    if (request.method === 'thread/start') return threadStartResult(fixture, 'thread-attached');
    if (request.method === 'turn/start') {
      socket.send(JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-attached', turn: { id: 'turn-1', status: 'inProgress' } },
      }));
      return turnStartResult(request, 'turn-1');
    }
    if (request.method === 'thread/name/set') return { result: {} };
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-attached',
        name: '::: lane: materialize before name',
        status: { type: 'active', activeFlags: [] },
      });
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  const probes = [];
  const attachment = {
    state: 'attached',
    evidence: 'lsof-established-loopback-connection',
    clientPid: 96049,
    connection: '127.0.0.1:53519->127.0.0.1:8843',
    observedAt: '2026-09-02T22:00:00.000Z',
  };
  const result = await spawn({
    ...baseOptions(fixture, server.url),
    allowProtocolOnly: false,
    desktopAttachment: async (probe) => {
      probes.push(probe.url);
      return {
        attachment,
        desktop: { bundleId: 'com.openai.codex', version: '26.901.20858', build: '7658', buildTested: true },
      };
    },
  }, fixture.env);
  assert.equal(result.ok, true);
  assert.deepEqual(probes, [new URL(server.url).href]);
  assert.deepEqual(result.visibility, {
    surface: 'codex',
    state: 'desktopAttached',
    receipt: {
      runtimeUrl: new URL(server.url).href,
      evidence: 'lsof-established-loopback-connection',
      clientPid: 96049,
      connection: '127.0.0.1:53519->127.0.0.1:8843',
      observedAt: '2026-09-02T22:00:00.000Z',
      bundleId: 'com.openai.codex',
      desktopVersion: '26.901.20858',
      desktopBuild: '7658',
      buildTested: true,
    },
  });
  const [lane] = listLanes(fixture.repoRoot, fixture.env);
  assert.equal(lane.visibility.state, 'desktopAttached');
  assert.equal(lane.visibility.receipt.clientPid, 96049);
  assert.equal(lane.state, 'active');
});

test('Codex spawn names the missing attachment when it fails closed', async (t) => {
  const fixture = createRepoWithSeat(t);
  await assert.rejects(
    () => spawn({
      ...baseOptions(fixture, 'ws://127.0.0.1:65534'),
      allowProtocolOnly: false,
      desktopAttachment: async () => ({ attachment: { state: 'unattached' }, desktop: { running: true } }),
    }, fixture.env),
    (error) => error.code === 'NATIVE_VISIBILITY_REQUIRED' &&
      /running without a connection to the selected runtime/.test(error.message) &&
      /desktop-attach\.js ensure/.test(error.message),
  );
  assert.deepEqual(listLanes(fixture.repoRoot, fixture.env), []);
});

test('Codex capabilities expose the live provider catalog and neutral intent vocabulary', async (t) => {
  const server = await startMockAppServer((request) => {
    if (request.method !== 'model/list') throw new Error(`unexpected ${request.method}`);
    return { result: { data: [{
      id: 'terra-id', model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra',
      description: 'Everyday model', hidden: false, isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: 'medium', description: 'Balanced' },
      ],
      defaultReasoningEffort: 'medium',
      serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Premium fast speed' }],
      defaultServiceTier: null,
    }], nextCursor: null } };
  });
  t.after(() => server.close());
  const result = await executionCapabilities({ url: server.url });
  assert.equal(result.target, 'codex');
  assert.equal(result.catalog.models[0].selector, 'gpt-5.6-terra');
  assert.deepEqual(result.intents.map((entry) => entry.id), [
    'provider-default', 'fast-loop', 'balanced', 'deep', 'max-quality',
  ]);
});

test('Codex spawn validates bounded single-line names before state or transport mutation', async (t) => {
  const fixture = createRepoWithSeat(t);
  for (const name of ['', '--option', 'line\nbreak', `x${'y'.repeat(256)}`]) {
    await assert.rejects(
      () => spawn({ ...baseOptions(fixture, 'ws://127.0.0.1:65534'), name }, fixture.env),
      (error) => error.code === 'USAGE_ERROR' && /single-line text/.test(error.message),
    );
  }
  assert.equal(listLanes(fixture.repoRoot, fixture.env).length, 0);
});

test('Codex spawn validates receipt verification bounds before state or transport mutation', async (t) => {
  const fixture = createRepoWithSeat(t);
  for (const invalid of [
    { inputReceiptVerifyAttempts: 0 },
    { inputReceiptVerifyAttempts: 101 },
    { inputReceiptVerifyDelayMs: -1 },
    { inputReceiptVerifyDelayMs: 1001 },
  ]) {
    await assert.rejects(
      () => spawn({ ...baseOptions(fixture, 'ws://127.0.0.1:65534'), ...invalid }, fixture.env),
      (error) => error.code === 'USAGE_ERROR' && /verification bounds/.test(error.message),
    );
  }
  assert.equal(listLanes(fixture.repoRoot, fixture.env).length, 0);
  assert.equal(listOperations(fixture.repoRoot, fixture.env).length, 0);
});

test('Codex spawn persists identity, materializes, then names and verifies', async (t) => {
  const fixture = createRepoWithSeat(t);
  const order = [];
  const server = await startMockAppServer((request, socket) => {
    order.push(request.method);
    if (request.method === 'thread/start') {
      assert.deepEqual(request.params, {
        cwd: fs.realpathSync(fixture.seat),
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
      });
      return threadStartResult(fixture, 'thread-1');
    }
    if (request.method === 'turn/start') {
      assert.equal(request.params.cwd, providerCwd(fixture));
      socket.send(JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } },
      }));
      return turnStartResult(request, 'turn-1');
    }
    if (request.method === 'thread/name/set') return { result: {} };
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-1',
        name: '::: lane: materialize before name',
        status: { type: 'active', activeFlags: [] },
      });
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());

  const result = await spawn(baseOptions(fixture, server.url), fixture.env);
  assert.equal(result.ok, true);
  assert.equal(result.receipt.providerId, 'thread-1');
  assert.deepEqual(result.visibility, {
    surface: 'codex',
    state: 'protocolOnlyByOwnerOverride',
    attachment: 'disabled',
  });
  assert.deepEqual(order, ['thread/start', 'turn/start', 'thread/name/set', 'thread/read']);
  const [lane] = listLanes(fixture.repoRoot, fixture.env);
  assert.equal(lane.providerId, 'thread-1');
  assert.equal(lane.turnId, 'turn-1');
  assert.equal(lane.state, 'active');
  assert.deepEqual(lane.visibility, {
    surface: 'codex', state: 'protocolOnlyByOwnerOverride', attachment: 'disabled',
  });
  assert.deepEqual(lane.ownership.creationReceipt, {
    providerId: 'thread-1',
    requestedCwd: providerCwd(fixture),
    responseCwd: providerCwd(fixture),
    cwd: providerCwd(fixture),
    initializedUserAgent: 'codex_cli_rs/0.151.0',
    createdAt: lane.ownership.creationReceipt.createdAt,
  });
  assert.equal(listOperations(fixture.repoRoot, fixture.env)[0].state, 'complete');
});

test('Codex dispatched profiles use live capabilities, render provenance, and receipt observation', async (t) => {
  const fixture = createRepoWithSeat(t);
  const parentContext = createParentContext({
    hostProvider: 'claude',
    hostApp: 'claude-desktop',
    displayName: 'Cross-provider operator',
  }, fixture.env);
  const catalog = { data: [{
    id: 'sol-id',
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    description: 'Reliable agentic workhorse.',
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Low' },
      { reasoningEffort: 'high', description: 'High' },
      { reasoningEffort: 'max', description: 'Maximum' },
    ],
    defaultReasoningEffort: 'low',
    serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Premium fast speed' }],
    defaultServiceTier: null,
  }], nextCursor: null };
  const methods = [];
  let verifiedSpawn = false;
  let turnStarts = 0;
  let reportedResumeTier = 'default';
  const server = await startMockAppServer((request) => {
    methods.push(request.method);
    if (request.method === 'model/list') return { result: catalog };
    if (request.method === 'thread/start') {
      assert.equal(request.params.model, 'gpt-5.6-sol');
      assert.equal(request.params.serviceTier, 'default');
      return { result: {
        ...threadStartResult(fixture, 'thread-profile').result,
        model: 'gpt-5.6-sol',
        reasoningEffort: 'low',
        serviceTier: 'default',
      } };
    }
    if (request.method === 'turn/start') {
      turnStarts += 1;
      assert.equal(request.params.model, 'gpt-5.6-sol');
      assert.equal(request.params.effort, 'high');
      assert.equal(request.params.serviceTier, 'default');
      assert.equal(request.params.serviceTierForTurn, 'default');
      if (turnStarts === 1) {
        assert.match(request.params.input[0].text, /^╭─ Transmogrify · a task from your user's own session ─+\n/);
        assert.match(request.params.input[0].text, /^│ From {6}Claude Code on Claude Desktop$/m);
        assert.match(request.params.input[0].text, /^│ Task {6}"Cross-provider operator"$/m);
        assert.match(request.params.input[0].text, /^│ Intent {4}deep$/m);
        assert.match(request.params.input[0].text, /^│ Dispatch {2}[0-9a-f-]{36}$/m);
        assert.match(request.params.input[0].text, /^╰─ v3 · work within your normal permissions; that session is notified when you finish ─+\n\n/m);
        assert.match(request.params.input[0].text,
          /^│ To {8}Codex · gpt-5.6-sol · high effort · standard speed$/m);
        return turnStartResult(request, 'turn-profile');
      }
      assert.equal(request.params.input[0].text, 'Continue with the same execution profile.');
      return turnStartResult(request, 'turn-profile-resumed');
    }
    if (request.method === 'thread/name/set') return { result: {} };
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-profile',
        name: '::: lane: materialize before name',
        status: verifiedSpawn ? { type: 'idle' } : { type: 'active', activeFlags: [] },
      });
    }
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{ id: 'turn-profile', status: 'completed', items: [] }] } };
    }
    if (request.method === 'thread/resume') {
      assert.equal(request.params.model, 'gpt-5.6-sol');
      assert.equal(request.params.serviceTier, 'default');
      return { result: {
        ...threadStartResult(fixture, 'thread-profile').result,
        serviceTier: reportedResumeTier,
      } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());

  const result = await spawn({
    ...baseOptions(fixture, server.url),
    parentContext,
    intent: 'deep',
  }, fixture.env);
  verifiedSpawn = true;
  assert.deepEqual(methods, [
    'model/list', 'model/list', 'thread/start', 'turn/start', 'thread/name/set', 'thread/read',
  ]);
  const lane = listLanes(fixture.repoRoot, fixture.env)[0];
  assert.equal(lane.executionProfile.resolved.effort.level, 'high');
  assert.equal(lane.lineage.parentRef, parentContext.parent.parentRef);
  assert.equal(result.receipt.executionProfile.observed.model, 'gpt-5.6-sol');
  assert.equal(result.receipt.executionProfile.observed.effort, null);
  const dispatch = readDispatch(lane.lineage.dispatchId, fixture.env);
  assert.equal(dispatch.resolvedProfile.speed.nativeControl.value, 'default');
  assert.equal(dispatch.observedProfile.speed, 'standard');
  assert.equal(listEvents(parentContext, {}, fixture.env)[0].type, 'child.spawned');

  await status({ repoRoot: fixture.repoRoot, laneId: lane.laneId, url: server.url }, fixture.env);
  const resumed = await resume({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
    message: 'Continue with the same execution profile.',
  }, fixture.env);
  assert.equal(resumed.receipt.turnId, 'turn-profile-resumed');
  assert.equal(turnStarts, 2);

  await status({ repoRoot: fixture.repoRoot, laneId: lane.laneId, url: server.url }, fixture.env);
  reportedResumeTier = 'priority';
  await assert.rejects(() => resume({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
    message: 'This turn must not start under a contradictory provider tier.',
  }, fixture.env), (error) => error.code === 'RECOVERY_UNCERTAIN');
  assert.equal(turnStarts, 2);
  assert.equal(
    pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).details.causeCode,
    'EXECUTION_PROFILE_UNSUPPORTED',
  );
});

test('Codex spawn fails closed when provider cwd does not match the reserved seat', async (t) => {
  const cases = [
    {
      name: 'missing response cwd',
      causeCode: 'PROTOCOL_ERROR',
      response: (fixture) => ({ result: {
        thread: { id: 'thread-seat-mismatch', cwd: providerCwd(fixture) },
      } }),
    },
    {
      name: 'missing thread cwd',
      causeCode: 'PROTOCOL_ERROR',
      response: (fixture) => ({ result: {
        cwd: providerCwd(fixture),
        thread: { id: 'thread-seat-mismatch' },
      } }),
    },
    {
      name: 'non-string response cwd',
      causeCode: 'PROTOCOL_ERROR',
      response: (fixture) => ({ result: {
        cwd: 42,
        thread: { id: 'thread-seat-mismatch', cwd: providerCwd(fixture) },
      } }),
    },
    {
      name: 'non-string thread cwd',
      causeCode: 'PROTOCOL_ERROR',
      response: (fixture) => ({ result: {
        cwd: providerCwd(fixture),
        thread: { id: 'thread-seat-mismatch', cwd: null },
      } }),
    },
    {
      name: 'wrong response cwd',
      causeCode: 'OWNERSHIP_MISMATCH',
      response: (fixture) => ({ result: {
        cwd: `${providerCwd(fixture)}-wrong`,
        thread: { id: 'thread-seat-mismatch', cwd: providerCwd(fixture) },
      } }),
    },
    {
      name: 'wrong thread cwd',
      causeCode: 'OWNERSHIP_MISMATCH',
      response: (fixture) => ({ result: {
        cwd: providerCwd(fixture),
        thread: { id: 'thread-seat-mismatch', cwd: `${providerCwd(fixture)}-wrong` },
      } }),
    },
  ];

  for (const mismatch of cases) {
    await t.test(mismatch.name, async (st) => {
      const fixture = createRepoWithSeat(st);
      const server = await startMockAppServer((request) => {
        if (request.method === 'thread/start') return mismatch.response(fixture);
        throw new Error(`unexpected ${request.method}`);
      });
      st.after(() => server.close());

      await assert.rejects(
        () => spawn(baseOptions(fixture, server.url), fixture.env),
        (error) => error.code === 'PARTIAL_SUCCESS' &&
          error.details.providerId === 'thread-seat-mismatch' &&
          error.details.providerMutation === 'createdNoTurn' &&
          error.details.causeCode === mismatch.causeCode,
      );
      assert.equal(
        server.requests.filter((request) => request.method === 'turn/start').length,
        0,
      );
      const [lane] = listLanes(fixture.repoRoot, fixture.env);
      assert.equal(lane.providerId, 'thread-seat-mismatch');
      assert.equal(lane.state, 'deliveryUnknown');
      assert.equal(
        pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).state,
        'partial',
      );
      assert.equal(
        pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).details.causeCode,
        mismatch.causeCode,
      );
    });
  }
});

test('Codex spawn treats a post-turn provider cwd mismatch as partial success', async (t) => {
  const fixture = createRepoWithSeat(t);
  let turnStarts = 0;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/start') return threadStartResult(fixture, 'thread-postcondition');
    if (request.method === 'turn/start') {
      turnStarts += 1;
      return turnStartResult(request, 'turn-postcondition');
    }
    if (request.method === 'thread/name/set') return { result: {} };
    if (request.method === 'thread/read') {
      return threadReadAt(`${providerCwd(fixture)}-wrong`, {
        id: 'thread-postcondition',
        name: '::: lane: materialize before name',
        status: { type: 'active', activeFlags: [] },
      });
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());

  await assert.rejects(
    () => spawn(baseOptions(fixture, server.url), fixture.env),
    (error) => error.code === 'PARTIAL_SUCCESS' &&
      /provider cwd/.test(error.message) && error.details.turnId === 'turn-postcondition' &&
      error.details.causeCode === 'OWNERSHIP_MISMATCH',
  );
  assert.equal(turnStarts, 1);
  const [lane] = listLanes(fixture.repoRoot, fixture.env);
  assert.equal(lane.state, 'deliveryUnknown');
  const pending = pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env);
  assert.equal(pending.state, 'partial');
  assert.equal(pending.details.causeCode, 'OWNERSHIP_MISMATCH');
});

test('Codex spawn verifies a persisted input receipt when turn/start omits its client marker', async (t) => {
  const fixture = createRepoWithSeat(t);
  const order = [];
  let turnRequest;
  let itemListCalls = 0;
  const server = await startMockAppServer((request) => {
    order.push(request.method);
    if (request.method === 'thread/start') {
      return threadStartResult(fixture, 'thread-persisted-receipt');
    }
    if (request.method === 'turn/start') {
      turnRequest = request;
      return { result: { turn: {
        id: 'turn-persisted-receipt',
        status: 'inProgress',
        items: [{
          id: 'user-persisted-receipt',
          type: 'userMessage',
          content: request.params.input,
        }],
      } } };
    }
    if (request.method === 'thread/items/list') {
      itemListCalls += 1;
      if (itemListCalls === 1) {
        return { error: { code: -32600, message: 'thread/items/list is not supported yet' } };
      }
      return { result: {
        data: [{
          turnId: 'turn-persisted-receipt',
          item: {
            id: 'user-persisted-receipt',
            type: 'userMessage',
            clientId: turnRequest.params.clientUserMessageId,
            content: turnRequest.params.input,
          },
        }],
        nextCursor: null,
      } };
    }
    if (request.method === 'thread/name/set') return { result: {} };
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-persisted-receipt',
        name: '::: [test] persisted receipt',
        status: { type: 'active', activeFlags: [] },
      });
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());

  const result = await spawn({
    ...baseOptions(fixture, server.url),
    name: '[test] persisted receipt',
  }, fixture.env);
  assert.equal(result.receipt.inputReceiptSource, 'threadItemsList');
  assert.deepEqual(order, [
    'thread/start',
    'turn/start',
    'thread/items/list',
    'thread/items/list',
    'thread/name/set',
    'thread/read',
  ]);
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'active');
});

test('Codex spawn handles its completion wait when input receipt verification fails closed', async (t) => {
  const fixture = createRepoWithSeat(t);
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/start') {
      return threadStartResult(fixture, 'thread-missing-receipt');
    }
    if (request.method === 'turn/start') {
      return { result: { turn: {
        id: 'turn-missing-receipt',
        status: 'inProgress',
        items: [],
      } } };
    }
    if (request.method === 'thread/items/list') {
      return { result: { data: [], nextCursor: null } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());

  await assert.rejects(
    () => spawn({
      ...baseOptions(fixture, server.url),
      waitForCompletion: true,
      maxExecutionMs: 1000,
      inputReceiptVerifyAttempts: 1,
    }, fixture.env),
    (error) => error.code === 'PROTOCOL_ERROR',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

test('Codex spawn fails closed on adversarial input-receipt evidence without replay', async (t) => {
  const cases = [
    {
      name: 'duplicate exact response markers',
      turnItems(request) {
        return [
          { id: 'user-1', type: 'userMessage', clientId: request.params.clientUserMessageId,
            content: request.params.input },
          { id: 'user-2', type: 'userMessage', clientId: request.params.clientUserMessageId,
            content: request.params.input },
        ];
      },
      expectedCode: 'PROTOCOL_ERROR',
      expectedItemListCalls: 0,
    },
    {
      name: 'exact response marker with different content',
      turnItems(request) {
        return [{ id: 'user-wrong', type: 'userMessage',
          clientId: request.params.clientUserMessageId,
          content: [{ type: 'text', text: 'tampered content' }] }];
      },
      expectedCode: 'PROTOCOL_ERROR',
      expectedItemListCalls: 0,
    },
    {
      name: 'persisted marker attached to another turn',
      listResponse(request) {
        return { result: { data: [{
          turnId: 'turn-other',
          item: { id: 'user-other', type: 'userMessage',
            clientId: request.params.clientUserMessageId, content: request.params.input },
        }], nextCursor: null } };
      },
      expectedCode: 'PROTOCOL_ERROR',
      expectedItemListCalls: 1,
    },
    {
      name: 'duplicate persisted markers',
      listResponse(request) {
        const item = { type: 'userMessage', clientId: request.params.clientUserMessageId,
          content: request.params.input };
        return { result: { data: [
          { turnId: 'turn-started', item: { ...item, id: 'user-a' } },
          { turnId: 'turn-started', item: { ...item, id: 'user-b' } },
        ], nextCursor: null } };
      },
      expectedCode: 'PROTOCOL_ERROR',
      expectedItemListCalls: 1,
    },
    {
      name: 'non-transient RPC failure',
      listResponse() {
        return { error: { code: -32600, message: 'thread/items/list hard failure' } };
      },
      expectedCode: 'RPC_ERROR',
      expectedItemListCalls: 1,
    },
    {
      name: 'transport timeout',
      listResponse() { return NO_RESPONSE; },
      expectedCode: 'TRANSPORT_UNKNOWN',
      expectedItemListCalls: 1,
      timeoutMs: 25,
    },
  ];

  for (const receiptCase of cases) {
    await t.test(receiptCase.name, async (st) => {
      const fixture = createRepoWithSeat(st);
      let turnRequest;
      let itemListCalls = 0;
      const server = await startMockAppServer((request) => {
        if (request.method === 'thread/start') {
          return threadStartResult(fixture, 'thread-receipt-adversarial');
        }
        if (request.method === 'turn/start') {
          turnRequest = request;
          return { result: { turn: {
            id: 'turn-started',
            status: 'inProgress',
            items: receiptCase.turnItems ? receiptCase.turnItems(request) : [],
          } } };
        }
        if (request.method === 'thread/items/list') {
          itemListCalls += 1;
          return receiptCase.listResponse(turnRequest);
        }
        throw new Error(`unexpected ${request.method}`);
      });
      st.after(() => server.close());

      await assert.rejects(() => spawn({
        ...baseOptions(fixture, server.url),
        timeoutMs: receiptCase.timeoutMs || 1000,
        inputReceiptVerifyAttempts: 1,
      }, fixture.env), (error) => error.code === receiptCase.expectedCode);
      const [lane] = listLanes(fixture.repoRoot, fixture.env);
      assert.equal(lane.state, 'deliveryUnknown');
      assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).state, 'unknown');
      assert.equal(server.requests.filter((request) => request.method === 'turn/start').length, 1);
      assert.equal(itemListCalls, receiptCase.expectedItemListCalls);
    });
  }
});

test('Codex input receipt retries share one aggregate pagination budget', async (t) => {
  const fixture = createRepoWithSeat(t);
  let itemListCalls = 0;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/start') {
      return threadStartResult(fixture, 'thread-receipt-budget');
    }
    if (request.method === 'turn/start') {
      return { result: { turn: { id: 'turn-receipt-budget', status: 'inProgress', items: [] } } };
    }
    if (request.method === 'thread/items/list') {
      itemListCalls += 1;
      return { result: { data: [], nextCursor: `cursor-${itemListCalls}` } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());

  await assert.rejects(() => spawn({
    ...baseOptions(fixture, server.url),
    inputReceiptVerifyAttempts: 100,
    inputReceiptVerifyDelayMs: 0,
  }, fixture.env), (error) => error.code === 'PROTOCOL_ERROR' && /aggregate page bound/.test(error.message));
  assert.equal(itemListCalls, 100);
  assert.equal(server.requests.filter((request) => request.method === 'turn/start').length, 1);
});

test('Codex spawn creates and records an operator-managed seat when cwd is omitted', async (t) => {
  const fixture = createRepoWithSeat(t);
  let startedCwd;
  const server = await startMockAppServer((request, socket) => {
    if (request.method === 'thread/start') {
      startedCwd = request.params.cwd;
      const cwd = request.params.cwd;
      return { result: { cwd, thread: { id: 'thread-managed', cwd } } };
    }
    if (request.method === 'turn/start') {
      socket.send(JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-managed', turn: { id: 'turn-managed', status: 'inProgress' } },
      }));
      return turnStartResult(request, 'turn-managed');
    }
    if (request.method === 'thread/name/set') return { result: {} };
    if (request.method === 'thread/read') {
      return threadReadResult({ ...fixture, seat: startedCwd }, {
        id: 'thread-managed',
        name: '::: [test] managed',
        status: { type: 'active', activeFlags: [] },
      });
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());

  const options = baseOptions(fixture, server.url);
  delete options.cwd;
  options.name = '[test] managed';
  const result = await spawn(options, fixture.env);
  const [lane] = listLanes(fixture.repoRoot, fixture.env);
  assert.equal(result.laneId, lane.laneId);
  assert.equal(lane.seat.managed, true);
  assert.equal(startedCwd, lane.seat.path);
  assert.equal(fs.existsSync(lane.seat.path), true);
  assert.equal(listOperations(fixture.repoRoot, fixture.env)[0].details.seat.path, lane.seat.path);
});

test('Codex spawn can keep its driver attached through turn completion', async (t) => {
  const fixture = createRepoWithSeat(t);
  let launchState;
  const server = await startMockAppServer((request, socket) => {
    if (request.method === 'thread/start') return threadStartResult(fixture, 'thread-driven');
    if (request.method === 'turn/start') {
      socket.send(JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-driven', turn: { id: 'turn-driven', status: 'inProgress', items: [] } },
      }));
      setTimeout(() => socket.send(JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thread-driven', turn: { id: 'turn-driven', status: 'completed', items: [] } },
      })), 25);
      return turnStartResult(request, 'turn-driven');
    }
    if (request.method === 'thread/name/set') return { result: {} };
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-driven',
        name: '::: [test] driven',
        status: { type: 'active', activeFlags: [] },
      });
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());

  const result = await spawn({
    ...baseOptions(fixture, server.url),
    name: '[test] driven',
    waitForCompletion: true,
    maxExecutionMs: 1000,
    onLaunch: (launched) => { launchState = launched.state; },
  }, fixture.env);
  assert.equal(launchState, 'active');
  assert.equal(result.state, 'idle');
  assert.equal(result.receipt.completedTurnId, 'turn-driven');
});

test('Codex spawn preserves a verified provider effect when completion observation times out', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/start') {
      return threadStartResult(fixture, 'thread-completion-timeout');
    }
    if (request.method === 'turn/start') return turnStartResult(request, 'turn-completion-timeout');
    if (request.method === 'thread/name/set') return { result: {} };
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-completion-timeout',
        name: '::: [test] completion timeout',
        status: { type: 'active', activeFlags: [] },
      });
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());

  await assert.rejects(() => spawn({
    ...baseOptions(fixture, server.url),
    name: '[test] completion timeout',
    waitForCompletion: true,
    maxExecutionMs: 25,
  }, fixture.env), (error) =>
    error.code === 'COMPLETION_UNKNOWN' && error.details.providerMutation === 'verified'
  );
  const lane = listLanes(fixture.repoRoot, fixture.env)[0];
  assert.equal(lane.state, 'active');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  assert.equal(server.requests.filter((request) => request.method === 'thread/start').length, 1);
});

test('Codex spawn preserves a verified provider effect when its host callback fails', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/start') {
      return threadStartResult(fixture, 'thread-callback-failure');
    }
    if (request.method === 'turn/start') return turnStartResult(request, 'turn-callback-failure');
    if (request.method === 'thread/name/set') return { result: {} };
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-callback-failure',
        name: '::: [test] callback failure',
        status: { type: 'active', activeFlags: [] },
      });
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());

  await assert.rejects(() => spawn({
    ...baseOptions(fixture, server.url),
    name: '[test] callback failure',
    onLaunch: () => { throw new Error('host callback exploded'); },
  }, fixture.env), (error) =>
    error.code === 'HOST_CALLBACK_FAILED' && error.details.providerMutation === 'verified'
  );
  const lane = listLanes(fixture.repoRoot, fixture.env)[0];
  assert.equal(lane.state, 'active');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
});

test('Codex spawn reports partial success without replaying input when naming fails', async (t) => {
  const fixture = createRepoWithSeat(t);
  let turnStarts = 0;
  const server = await startMockAppServer((request, socket) => {
    if (request.method === 'thread/start') return threadStartResult(fixture, 'thread-partial');
    if (request.method === 'turn/start') {
      turnStarts += 1;
      socket.send(JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-partial', turn: { id: 'turn-partial', status: 'inProgress' } },
      }));
      return turnStartResult(request, 'turn-partial');
    }
    if (request.method === 'thread/name/set') {
      return { error: { code: -32600, message: 'name write failed' } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());

  await assert.rejects(
    () => spawn(baseOptions(fixture, server.url), fixture.env),
    (error) => error.code === 'PARTIAL_SUCCESS' && error.details.providerId === 'thread-partial',
  );
  assert.equal(turnStarts, 1);
  const lane = listLanes(fixture.repoRoot, fixture.env)[0];
  assert.equal(lane.state, 'materialized');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).state, 'partial');
  assert.equal(listOperations(fixture.repoRoot, fixture.env)[0].state, 'partial');
});

test('concurrent Codex spawns reserve a shared seat before provider mutation', async (t) => {
  const fixture = createRepoWithSeat(t);
  let threadStarts = 0;
  const server = await startMockAppServer((request, socket) => {
    if (request.method === 'thread/start') {
      threadStarts += 1;
      return threadStartResult(fixture, 'thread-reserved-once');
    }
    if (request.method === 'turn/start') {
      socket.send(JSON.stringify({
        method: 'turn/started',
        params: {
          threadId: 'thread-reserved-once',
          turn: { id: 'turn-reserved-once', status: 'inProgress', items: [] },
        },
      }));
      return turnStartResult(request, 'turn-reserved-once');
    }
    if (request.method === 'thread/name/set') return { result: {} };
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-reserved-once',
        name: '::: [test] reserve race',
        status: { type: 'active', activeFlags: [] },
      });
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  const options = {
    ...baseOptions(fixture, server.url),
    name: '[test] reserve race',
  };
  const settled = await Promise.allSettled([
    spawn(options, fixture.env),
    spawn(options, fixture.env),
  ]);
  assert.equal(settled.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(settled.filter((entry) => entry.status === 'rejected').length, 1);
  assert.match(settled.find((entry) => entry.status === 'rejected').reason.message, /seat is already owned/);
  assert.equal(threadStarts, 1);
});

function registerOwned(fixture, url, state = 'active') {
  return registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'thread-owned',
    displayName: '[test] owned',
    state,
    runtime: {
      endpoint: new URL(url).toString(),
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
    },
    seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot),
    capabilities: {
      midTurnSteer: true,
      interrupt: true,
      retirement: 'archive',
      recovery: 'crossRoot',
    },
  }, fixture.env);
}

test('Codex resume validates receipt verification bounds before transport mutation', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    throw new Error(`unexpected provider request ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url, 'idle');

  await assert.rejects(() => resume({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message: 'Do not send this message.',
    url: server.url,
    inputReceiptVerifyAttempts: 0,
  }, fixture.env), (error) => error.code === 'USAGE_ERROR');
  assert.deepEqual(server.requests, []);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
});

test('Codex steer and interrupt use only the newest exact active turn', async (t) => {
  const fixture = createRepoWithSeat(t);
  const mutations = [];
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-owned',
        status: { type: 'active', activeFlags: [] },
      });
    }
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{ id: 'turn-newest', status: 'inProgress', items: [] }] } };
    }
    if (request.method === 'turn/steer') {
      mutations.push(request);
      return { result: { turnId: 'turn-newest' } };
    }
    if (request.method === 'turn/interrupt') {
      mutations.push(request);
      return { result: {} };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  registerOwned(fixture, server.url);

  await steer({
    repoRoot: fixture.repoRoot,
    providerId: 'thread-owned',
    message: 'Orchestrator: adjust',
    url: server.url,
  }, fixture.env);
  await interrupt({ repoRoot: fixture.repoRoot, providerId: 'thread-owned', url: server.url }, fixture.env);
  assert.equal(mutations.length, 2);
  const { clientUserMessageId, ...steerParams } = mutations[0].params;
  const steerOperation = listOperations(fixture.repoRoot, fixture.env)
    .find((entry) => entry.type === 'steer');
  assert.equal(clientUserMessageId, steerOperation.operationId);
  assert.deepEqual(steerParams, {
    threadId: 'thread-owned',
    expectedTurnId: 'turn-newest',
    input: [{ type: 'text', text: 'Orchestrator: adjust' }],
  });
  assert.deepEqual(mutations[1].params, { threadId: 'thread-owned', turnId: 'turn-newest' });
});

test('Codex steer journals dispatch before delivery and never replays an unknown result', async (t) => {
  const fixture = createRepoWithSeat(t);
  let steerCalls = 0;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-owned',
        status: { type: 'active', activeFlags: [] },
      });
    }
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{ id: 'turn-unknown-steer', status: 'inProgress', items: [] }] } };
    }
    if (request.method === 'turn/steer') {
      steerCalls += 1;
      return NO_RESPONSE;
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url);
  const request = {
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message: 'deliver exactly once',
    url: server.url,
    timeoutMs: 25,
  };

  await assert.rejects(() => steer(request, fixture.env), (error) =>
    error.code === 'DELIVERY_UNCERTAIN'
  );
  const pending = pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env);
  assert.equal(pending.type, 'steer');
  assert.equal(pending.state, 'unknown');
  assert.equal(typeof pending.details.dispatchStartedAt, 'string');
  const requestsAfterUnknown = server.requests.length;

  await assert.rejects(() => steer(request, fixture.env), (error) =>
    error.code === 'DELIVERY_UNCERTAIN'
  );
  assert.equal(steerCalls, 1);
  assert.equal(server.requests.length, requestsAfterUnknown);
  assert.equal(
    pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).operationId,
    pending.operationId,
  );
});

test('Codex recovery observes an unknown interrupt postcondition without replaying it', async (t) => {
  const fixture = createRepoWithSeat(t);
  let interrupted = false;
  let interruptCalls = 0;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{
        id: 'turn-unknown-interrupt',
        status: interrupted ? 'interrupted' : 'inProgress',
        items: [],
      }] } };
    }
    if (request.method === 'turn/interrupt') {
      interruptCalls += 1;
      return NO_RESPONSE;
    }
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-owned',
        status: { type: 'idle' },
      });
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url);

  await assert.rejects(() => interrupt({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
    timeoutMs: 25,
  }, fixture.env), (error) => error.code === 'DELIVERY_UNCERTAIN');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).state, 'unknown');

  await assert.rejects(() => interrupt({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
  }, fixture.env), (error) => error.code === 'DELIVERY_UNCERTAIN');
  assert.equal(interruptCalls, 1);
  interrupted = true;

  const result = await recover({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
  }, fixture.env);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results[0].repaired, ['interruptPostcondition']);
  assert.equal(interruptCalls, 1);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
});

test('Codex boundary resume accepts only an exact persisted input receipt when its response omits the marker', async (t) => {
  const fixture = createRepoWithSeat(t);
  let turnRequest;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-owned',
        status: { type: 'idle' },
      });
    }
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{
        id: 'turn-baseline',
        status: 'completed',
        items: [],
      }] } };
    }
    if (request.method === 'thread/resume') {
      assert.equal(request.params.cwd, providerCwd(fixture));
      return threadStartResult(fixture, 'thread-owned');
    }
    if (request.method === 'turn/start') {
      turnRequest = request;
      assert.equal(request.params.cwd, providerCwd(fixture));
      return { result: { turn: {
        id: 'turn-resumed-persisted',
        status: 'inProgress',
        items: [{
          id: 'user-resumed-persisted',
          type: 'userMessage',
          content: request.params.input,
        }],
      } } };
    }
    if (request.method === 'thread/items/list') {
      return { result: {
        data: [{
          turnId: 'turn-resumed-persisted',
          item: {
            id: 'user-resumed-persisted',
            type: 'userMessage',
            clientId: turnRequest.params.clientUserMessageId,
            content: turnRequest.params.input,
          },
        }],
        nextCursor: null,
      } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url, 'idle');

  const result = await resume({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
    message: 'Start one new boundary turn.',
  }, fixture.env);
  assert.equal(result.state, 'active');
  assert.equal(result.receipt.inputReceiptSource, 'threadItemsList');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
});

test('Codex resume verifies provider cwd before dispatching a new turn', async (t) => {
  const fixture = createRepoWithSeat(t);
  let turnStarts = 0;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-owned',
        status: { type: 'idle' },
      });
    }
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{ id: 'turn-complete', status: 'completed', items: [] }] } };
    }
    if (request.method === 'thread/resume') {
      assert.equal(request.params.cwd, providerCwd(fixture));
      return { result: {
        cwd: providerCwd(fixture),
        thread: { id: 'thread-owned', cwd: `${providerCwd(fixture)}-wrong` },
      } };
    }
    if (request.method === 'turn/start') {
      turnStarts += 1;
      throw new Error('turn/start must not be called after a seat mismatch');
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url, 'idle');

  await assert.rejects(() => resume({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
    message: 'Must not be dispatched into a mismatched seat.',
  }, fixture.env), (error) => error.code === 'RECOVERY_UNCERTAIN');
  assert.equal(turnStarts, 0);
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'deliveryUnknown');
  assert.equal(
    pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).state,
    'unknownResume',
  );
  assert.equal(
    pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).details.causeCode,
    'OWNERSHIP_MISMATCH',
  );
  assert.equal(
    pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).details.providerSeatVerification,
    'mismatch',
  );
});

test('Codex resume retry refuses replay until recovery observes the new turn', async (t) => {
  const fixture = createRepoWithSeat(t);
  let turnWasDispatched = false;
  let turnStarts = 0;
  let clientUserMessageId;
  let dispatchedInput;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{
        id: turnWasDispatched ? 'turn-resumed' : 'turn-baseline',
        status: turnWasDispatched ? 'inProgress' : 'completed',
        items: [],
      }] } };
    }
    if (request.method === 'thread/resume') {
      assert.equal(request.params.cwd, providerCwd(fixture));
      return threadStartResult(fixture, 'thread-owned');
    }
    if (request.method === 'turn/start') {
      turnStarts += 1;
      assert.equal(request.params.cwd, providerCwd(fixture));
      clientUserMessageId = request.params.clientUserMessageId;
      dispatchedInput = request.params.input;
      return NO_RESPONSE;
    }
    if (request.method === 'thread/items/list') {
      return { result: { data: turnWasDispatched ? [{
        turnId: 'turn-resumed',
        item: {
          id: 'user-turn-resumed',
          type: 'userMessage',
          clientId: clientUserMessageId,
          content: dispatchedInput,
        },
      }] : [], nextCursor: null } };
    }
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-owned',
        status: { type: 'active', activeFlags: [] },
      });
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url, 'idle');

  await assert.rejects(() => resume({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message: 'continue once',
    url: server.url,
    timeoutMs: 25,
    turnStartTimeoutMs: 25,
  }, fixture.env), (error) => error.code === 'RECOVERY_UNCERTAIN');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).state, 'unknownTurn');

  await assert.rejects(() => resume({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message: 'continue once',
    url: server.url,
  }, fixture.env), (error) => error.code === 'RECOVERY_UNCERTAIN');
  assert.equal(turnStarts, 1);
  turnWasDispatched = true;

  const result = await recover({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
  }, fixture.env);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results[0].repaired, ['resumeInputReceipt']);
  assert.equal(turnStarts, 1);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
});

test('Codex planned resume proves non-delivery when history changes before dispatch', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-owned',
        status: { type: 'idle' },
      });
    }
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{ id: 'turn-new', status: 'completed', items: [] }] } };
    }
    throw new Error(`unexpected provider mutation ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url, 'idle');
  const message = 'Do not dispatch this changed-history resume.';
  const operation = beginLaneOperation(fixture.repoRoot, lane.laneId, {
    type: 'resume',
    details: {
      target: 'codex',
      messageSha256: crypto.createHash('sha256').update(message).digest('hex'),
      baselineTurnId: 'turn-baseline',
    },
  }, fixture.env);

  await assert.rejects(() => resume({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
    message,
  }, fixture.env), (error) => error.code === 'INVALID_STATE');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  assert.equal(listOperations(fixture.repoRoot, fixture.env)
    .find((entry) => entry.operationId === operation.operationId).state, 'notDelivered');
  assert.equal(server.requests.some((request) =>
    ['thread/resume', 'turn/start'].includes(request.method)
  ), false);
});

test('Codex recovery closes a resume that never reached turn/start as input not delivered', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, { id: 'thread-owned', status: { type: 'idle' } });
    }
    throw new Error(`unexpected provider request ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url, 'idle');
  const message = 'Resume input that was journaled but never dispatched as a turn.';
  const operation = beginLaneOperation(fixture.repoRoot, lane.laneId, {
    type: 'resume',
    state: 'resumeAcknowledged',
    details: {
      target: 'codex',
      messageSha256: crypto.createHash('sha256').update(message).digest('hex'),
      baselineTurnId: 'turn-baseline',
    },
  }, fixture.env);

  const result = await recover({ repoRoot: fixture.repoRoot, laneId: lane.laneId, url: server.url }, fixture.env);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].delivery, 'notDelivered');
  assert.deepEqual(result.results[0].repaired, ['clearedUndispatchedResume']);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  assert.equal(listOperations(fixture.repoRoot, fixture.env)
    .find((entry) => entry.operationId === operation.operationId).state, 'notDelivered');
  assert.equal(server.requests.some((request) =>
    ['thread/resume', 'turn/start', 'thread/turns/list', 'thread/items/list'].includes(request.method)
  ), false);
});

test('Codex recovery clears a terminal operation pointer without provider replay', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    throw new Error(`unexpected provider request ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url, 'idle');
  const operation = beginLaneOperation(fixture.repoRoot, lane.laneId, {
    type: 'steer',
    details: { messageSha256: 'e'.repeat(64), expectedTurnId: 'turn-complete' },
  }, fixture.env);
  updatePendingLaneOperation(fixture.repoRoot, lane.laneId, operation.operationId, {
    state: 'complete',
  }, fixture.env);

  const result = await recover({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
  }, fixture.env);
  assert.deepEqual(result.results[0].repaired, ['terminalOperationPointer']);
  assert.equal(result.results[0].delivery, 'confirmed');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  assert.deepEqual(server.requests.map((request) => request.method), []);
});

test('Codex recovery normalizes a providerless spawn whose failure became terminal before lane update', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    throw new Error(`unexpected provider request ${request.method}`);
  });
  t.after(() => server.close());
  const laneId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  reserveSpawn(fixture.repoRoot, {
    operation: {
      operationId,
      type: 'spawn',
      laneId,
      details: { target: 'codex', name: '[test] failed spawn recovery' },
    },
    lane: {
      laneId,
      backend: 'codex-app-server',
      target: 'codex',
      displayName: '[test] failed spawn recovery',
      state: 'planned',
      operationId,
      runtime: { endpoint: new URL(server.url).toString() },
      seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot),
      capabilities: {},
    },
  }, fixture.env);
  updatePendingLaneOperation(fixture.repoRoot, laneId, operationId, { state: 'failed' }, fixture.env);

  const result = await recover({
    repoRoot: fixture.repoRoot,
    laneId,
    url: server.url,
  }, fixture.env);
  assert.equal(result.results[0].state, 'failed');
  assert.equal(result.results[0].delivery, 'notDelivered');
  assert.deepEqual(result.results[0].repaired, [
    'failedSpawnState',
    'terminalOperationPointer',
  ]);
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'failed');
  assert.equal(pendingOperationForLane(fixture.repoRoot, laneId, fixture.env), null);
  assert.deepEqual(server.requests.map((request) => request.method), []);
});

test('Codex recovery preserves the complete cwd receipt when binding a provider-created spawn', async (t) => {
  const fixture = createRepoWithSeat(t);
  const providerId = 'thread-provider-created-recovery';
  const displayName = '[test] provider-created recovery';
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: providerId,
        name: displayName,
        status: { type: 'idle' },
      });
    }
    if (request.method === 'thread/turns/list') return { result: { data: [] } };
    if (request.method === 'thread/items/list') return { result: { data: [], nextCursor: null } };
    throw new Error(`unexpected provider request ${request.method}`);
  });
  t.after(() => server.close());
  const laneId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  reserveSpawn(fixture.repoRoot, {
    operation: {
      operationId,
      type: 'spawn',
      laneId,
      details: {
        target: 'codex',
        name: displayName,
        inputSha256: 'a'.repeat(64),
      },
    },
    lane: {
      laneId,
      backend: 'codex-app-server',
      target: 'codex',
      displayName,
      state: 'planned',
      operationId,
      runtime: { endpoint: new URL(server.url).toString() },
      seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot),
      capabilities: {},
    },
  }, fixture.env);
  updatePendingLaneOperation(fixture.repoRoot, laneId, operationId, {
    state: 'providerCreated',
    providerId,
  }, fixture.env);

  const result = await recover({
    repoRoot: fixture.repoRoot,
    laneId,
    url: server.url,
  }, fixture.env);
  assert.equal(result.results[0].delivery, 'unknown');
  const lane = listLanes(fixture.repoRoot, fixture.env)[0];
  assert.equal(lane.providerId, providerId);
  assert.equal(lane.ownership.creationReceipt.providerId, providerId);
  assert.equal(lane.ownership.creationReceipt.requestedCwd, providerCwd(fixture));
  assert.equal(lane.ownership.creationReceipt.responseCwd, null);
  assert.equal(lane.ownership.creationReceipt.cwd, providerCwd(fixture));
  assert.match(lane.ownership.creationReceipt.recoveredAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('Codex recovery normalizes a failed spawn after its terminal pointer was already cleared', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    throw new Error(`unexpected provider request ${request.method}`);
  });
  t.after(() => server.close());
  const laneId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  reserveSpawn(fixture.repoRoot, {
    operation: {
      operationId,
      type: 'spawn',
      laneId,
      details: { target: 'codex', name: '[test] cleared failed spawn recovery' },
    },
    lane: {
      laneId,
      backend: 'codex-app-server',
      target: 'codex',
      displayName: '[test] cleared failed spawn recovery',
      state: 'planned',
      operationId,
      runtime: { endpoint: new URL(server.url).toString() },
      seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot),
      capabilities: {},
    },
  }, fixture.env);
  completeLaneOperation(fixture.repoRoot, laneId, operationId, { state: 'failed' }, fixture.env);

  const result = await recover({
    repoRoot: fixture.repoRoot,
    laneId,
    url: server.url,
  }, fixture.env);
  assert.equal(result.results[0].state, 'failed');
  assert.equal(result.results[0].delivery, 'notDelivered');
  assert.deepEqual(result.results[0].repaired, ['failedSpawnState']);
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'failed');
  assert.equal(pendingOperationForLane(fixture.repoRoot, laneId, fixture.env), null);

  const steady = await recover({
    repoRoot: fixture.repoRoot,
    laneId,
    url: server.url,
  }, fixture.env);
  assert.equal(steady.results[0].state, 'failed');
  assert.equal(steady.results[0].delivery, 'notDelivered');
  assert.deepEqual(steady.results[0].repaired, []);
  assert.deepEqual(
    server.requests.filter((request) => request.id !== undefined).map((request) => request.method),
    [],
  );
});

test('Codex exact recovery rejects missing and wrong-backend lanes before connecting', async (t) => {
  const fixture = createRepoWithSeat(t);
  await assert.rejects(() => recover({
    repoRoot: fixture.repoRoot,
    laneId: 'missing-lane',
    url: 'ws://127.0.0.1:65534',
  }, fixture.env), (error) => error.code === 'NOT_OWNED');

  const wrong = registerLane(fixture.repoRoot, {
    backend: 'other-provider',
    providerId: 'other-resource',
    displayName: '[test] wrong backend',
    state: 'idle',
    runtime: null,
    seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot),
  }, fixture.env);
  await assert.rejects(() => recover({
    repoRoot: fixture.repoRoot,
    laneId: wrong.laneId,
    url: 'ws://127.0.0.1:65534',
  }, fixture.env), (error) => error.code === 'ADAPTER_MISMATCH');
});

test('Codex mutations reject retired lanes and runtime drift before mutation', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer(() => {
    throw new Error('no request expected');
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url, 'archivedVerified');
  await assert.rejects(() => steer({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message: 'must not send',
    url: server.url,
  }, fixture.env), (error) => error.code === 'LANE_RETIRED');
  assert.equal(server.requests.length, 0);

  const activeLane = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'thread-runtime-drift',
    displayName: '[test] runtime drift',
    state: 'active',
    runtime: lane.runtime,
    seat: { ...lane.seat, path: `${lane.seat.path}-other` },
  }, fixture.env);
  await assert.rejects(() => steer({
    repoRoot: fixture.repoRoot,
    laneId: activeLane.laneId,
    message: 'must not cross runtimes',
    url: 'ws://127.0.0.1:65534',
  }, fixture.env), (error) => error.code === 'RUNTIME_MISMATCH');
  assert.equal(server.requests.length, 0);
});

test('Codex mutations reject malformed turn history and mismatched steer receipts', async (t) => {
  const fixture = createRepoWithSeat(t);
  let mode = 'malformed';
  let mutations = 0;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-owned',
        status: { type: mode === 'malformed' ? 'idle' : 'active', activeFlags: [] },
      });
    }
    if (request.method === 'thread/turns/list') {
      if (mode === 'malformed') return { result: {} };
      return { result: { data: [{ id: 'turn-exact', status: 'inProgress', items: [] }] } };
    }
    if (request.method === 'turn/steer') {
      mutations += 1;
      return { result: { turnId: 'turn-other' } };
    }
    if (request.method === 'thread/archive') mutations += 1;
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url, 'idle');
  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
    harvestedOutputSha256: 'a'.repeat(64),
  }, fixture.env), (error) => error.code === 'PROTOCOL_ERROR');
  assert.equal(mutations, 0);

  updateLane(fixture.repoRoot, lane.laneId, { state: 'active' }, fixture.env);
  mode = 'valid';
  await assert.rejects(() => steer({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    message: 'exact turn only',
    url: server.url,
  }, fixture.env), (error) => error.code === 'DELIVERY_UNCERTAIN');
  assert.equal(mutations, 1);
});

test('Codex retire requires an inactive newest turn and verifies archived pagination', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-owned',
        status: { type: 'idle' },
      });
    }
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{ id: 'turn-1', status: 'completed', items: [] }] } };
    }
    if (request.method === 'thread/archive') return { result: {} };
    if (request.method === 'thread/list' && request.params.cursor === null) {
      return { result: { data: [], nextCursor: 'page-2' } };
    }
    if (request.method === 'thread/list' && request.params.cursor === 'page-2') {
      return { result: {
        data: [{ id: 'thread-owned', cwd: providerCwd(fixture) }],
        nextCursor: null,
      } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  registerOwned(fixture, server.url, 'idle');

  const result = await retire({
    repoRoot: fixture.repoRoot,
    providerId: 'thread-owned',
    url: server.url,
    harvestedOutputSha256: 'b'.repeat(64),
  }, fixture.env);
  assert.equal(result.state, 'archivedVerified');
  assert.equal(result.receipt.archived, true);
  assert.equal(result.receipt.harvestedOutputSha256, 'b'.repeat(64));
  assert.equal(fs.existsSync(fixture.seat), true);
});

test('Codex retire refuses ambiguous or wrong-seat archived rows before cleanup', async (t) => {
  const cases = [
    {
      name: 'missing cwd',
      rows: () => [{ id: 'thread-owned' }],
      code: 'PROTOCOL_ERROR',
      phase: 'verification',
    },
    {
      name: 'wrong cwd',
      rows: (fixture) => [{ id: 'thread-owned', cwd: `${providerCwd(fixture)}-wrong` }],
      code: 'OWNERSHIP_MISMATCH',
      phase: 'verification',
    },
    {
      name: 'duplicate exact rows',
      rows: (fixture) => [
        { id: 'thread-owned', cwd: providerCwd(fixture) },
        { id: 'thread-owned', cwd: providerCwd(fixture) },
      ],
      code: 'PROTOCOL_ERROR',
      phase: 'verification',
    },
    {
      name: 'not observed',
      rows: () => [],
      code: 'TRANSPORT_UNKNOWN',
      phase: 'not-observed',
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const fixture = createRepoWithSeat(st);
      let archiveCalls = 0;
      const server = await startMockAppServer((request) => {
        if (request.method === 'thread/read') {
          return threadReadResult(fixture, {
            id: 'thread-owned',
            status: { type: 'idle' },
          });
        }
        if (request.method === 'thread/turns/list') return { result: { data: [] } };
        if (request.method === 'thread/archive') {
          archiveCalls += 1;
          return { result: {} };
        }
        if (request.method === 'thread/list') {
          return { result: { data: entry.rows(fixture), nextCursor: null } };
        }
        throw new Error(`unexpected ${request.method}`);
      });
      st.after(() => server.close());
      const lane = registerOwned(fixture, server.url, 'idle');

      await assert.rejects(() => retire({
        repoRoot: fixture.repoRoot,
        laneId: lane.laneId,
        url: server.url,
        harvestedOutputSha256: '7'.repeat(64),
        archiveVerifyAttempts: 1,
      }, fixture.env), (error) => error.code === entry.code);

      assert.equal(archiveCalls, 1);
      assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'archiveUnknown');
      assert.equal(fs.existsSync(fixture.seat), true);
      const pending = pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env);
      assert.equal(pending.state, 'unknown');
      assert.equal(pending.details.archiveFailurePhase, entry.phase);
      assert.equal(pending.details.causeCode, entry.code);
      assert.match(pending.details.archiveDeliveryBecameUnknownAt, /^\d{4}-\d{2}-\d{2}T/);
    });
  }
});

test('Codex recovery refuses a wrong-seat archived row without cleanup', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/list') {
      return { result: {
        data: [{ id: 'thread-owned', cwd: `${providerCwd(fixture)}-wrong` }],
        nextCursor: null,
      } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  let lane = registerOwned(fixture, server.url, 'idle');
  const harvestReceipt = captureHarvestReceipt(
    fixture.repoRoot,
    lane.seat,
    '8'.repeat(64),
  );
  const operation = beginLaneOperation(fixture.repoRoot, lane.laneId, {
    type: 'retire',
    providerId: lane.providerId,
    state: 'unknown',
    details: { target: 'codex', harvestReceipt },
  }, fixture.env);
  lane = updateLane(fixture.repoRoot, lane.laneId, { state: 'retireRequested' }, fixture.env);
  lane = updateLane(fixture.repoRoot, lane.laneId, { state: 'archiveUnknown' }, fixture.env);

  const result = await recover({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
    archiveVerifyAttempts: 1,
  }, fixture.env);

  assert.equal(result.ok, false);
  assert.equal(result.results[0].code, 'OWNERSHIP_MISMATCH');
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'archiveUnknown');
  assert.equal(fs.existsSync(fixture.seat), true);
  assert.equal(
    pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).operationId,
    operation.operationId,
  );
  assert.deepEqual(
    server.requests.filter((request) => request.id !== undefined).map((request) => request.method),
    ['initialize', 'thread/list'],
  );
});

test('Codex archive uncertainty preserves its managed worktree and branch without replay', async (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = '79797979-7979-4979-8979-797979797979';
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  let archiveCalls = 0;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadAt(seat.path, {
        id: 'thread-managed-archive-unknown',
        status: { type: 'idle' },
      });
    }
    if (request.method === 'thread/turns/list') return { result: { data: [] } };
    if (request.method === 'thread/archive') {
      archiveCalls += 1;
      return { error: { code: -32000, message: 'provider detail must not be journaled' } };
    }
    if (request.method === 'thread/list') {
      return { result: { data: [], nextCursor: null } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  registerLane(fixture.repoRoot, {
    laneId,
    backend: 'codex-app-server',
    providerId: 'thread-managed-archive-unknown',
    displayName: '[test] managed archive unknown',
    state: 'idle',
    runtime: {
      endpoint: new URL(server.url).toString(),
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
    },
    seat,
  }, fixture.env);

  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot,
    laneId,
    url: server.url,
    harvestedOutputSha256: '9'.repeat(64),
    archiveVerifyAttempts: 1,
  }, fixture.env), (error) => error.code === 'RPC_ERROR');

  const recovered = await recover({
    repoRoot: fixture.repoRoot,
    laneId,
    url: server.url,
    archiveVerifyAttempts: 1,
  }, fixture.env);
  assert.equal(recovered.ok, false);
  assert.equal(recovered.results[0].state, 'archiveUnknown');
  assert.equal(recovered.results[0].delivery, 'unknown');
  assert.equal(archiveCalls, 1);
  assert.equal(fs.existsSync(seat.path), true);
  assert.doesNotThrow(() => execFileSync(
    'git', ['-C', fixture.repoRoot, 'show-ref', '--verify', seat.branchRef],
  ));
  const pending = pendingOperationForLane(fixture.repoRoot, laneId, fixture.env);
  assert.equal(pending.state, 'unknown');
  assert.equal(pending.details.archiveFailurePhase, 'dispatch');
  assert.equal(JSON.stringify(pending).includes('provider detail must not be journaled'), false);
});

test('Codex retire refuses provider mutation without a durable harvest digest', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer(() => {
    throw new Error('no request expected');
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url, 'idle');

  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
  }, fixture.env), (error) => error.code === 'USAGE_ERROR');
  assert.equal(server.requests.length, 0);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
});

test('Codex retire automatically removes only its clean operator-managed worktree after archive verification', async (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = '99999999-9999-4999-8999-999999999999';
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadAt(seat.path, {
        id: 'thread-managed-retire',
        status: { type: 'idle' },
      });
    }
    if (request.method === 'thread/turns/list') return { result: { data: [] } };
    if (request.method === 'thread/archive') return { result: {} };
    if (request.method === 'thread/list') {
      return { result: { data: [{ id: 'thread-managed-retire', cwd: seat.path }], nextCursor: null } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  registerLane(fixture.repoRoot, {
    laneId,
    backend: 'codex-app-server',
    providerId: 'thread-managed-retire',
    displayName: '[test] managed retire',
    state: 'idle',
    runtime: {
      endpoint: new URL(server.url).toString(),
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
    },
    seat,
  }, fixture.env);
  const result = await retire({
    repoRoot: fixture.repoRoot,
    laneId,
    url: server.url,
    cleanupWorktree: true,
    archiveVerifyAttempts: 1,
    harvestedOutputSha256: 'c'.repeat(64),
  }, fixture.env);
  assert.equal(result.state, 'worktreeRemoved');
  assert.equal(result.receipt.worktreeRemoved, true);
  assert.equal(fs.existsSync(seat.path), false);
});

test('Codex retire keeps a post-harvest cleanup block permanent without replaying provider calls', async (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = '88888888-8888-4888-8888-888888888888';
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  fs.writeFileSync(`${seat.path}/.gitignore`, 'ignored/\n');
  execFileSync('git', ['-C', seat.path, 'add', '.gitignore']);
  execFileSync('git', ['-C', seat.path, 'commit', '-qm', 'ignore cleanup fixture']);
  let archiveCalls = 0;
  const changed = `${seat.path}/ignored/changed-after-harvest.txt`;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadAt(seat.path, {
        id: 'thread-cleanup-retry',
        status: { type: 'idle' },
      });
    }
    if (request.method === 'thread/turns/list') return { result: { data: [] } };
    if (request.method === 'thread/archive') {
      archiveCalls += 1;
      fs.mkdirSync(`${seat.path}/ignored`, { recursive: true });
      fs.writeFileSync(changed, 'post-harvest change\n');
      return { result: {} };
    }
    if (request.method === 'thread/list') {
      return { result: { data: [{ id: 'thread-cleanup-retry', cwd: seat.path }], nextCursor: null } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  registerLane(fixture.repoRoot, {
    laneId,
    backend: 'codex-app-server',
    providerId: 'thread-cleanup-retry',
    displayName: '[test] cleanup retry',
    state: 'idle',
    runtime: {
      endpoint: new URL(server.url).toString(),
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
    },
    seat,
  }, fixture.env);

  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot,
    laneId,
    url: server.url,
    harvestedOutputSha256: 'd'.repeat(64),
    archiveVerifyAttempts: 1,
  }, fixture.env), (error) =>
    error.code === 'CLEANUP_BLOCKED' && error.details.providerRetired === true
  );
  let lane = listLanes(fixture.repoRoot, fixture.env).find((entry) => entry.laneId === laneId);
  assert.equal(lane.state, 'archivedVerified');
  assert.equal(
    pendingOperationForLane(fixture.repoRoot, laneId, fixture.env).state,
    'providerRetiredCleanupBlocked',
  );
  assert.equal(
    pendingOperationForLane(fixture.repoRoot, laneId, fixture.env).details.cleanupBlocked,
    true,
  );
  const requestsBeforeRetry = server.requests.length;
  fs.unlinkSync(changed);

  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot,
    laneId,
    url: server.url,
  }, fixture.env), (error) => error.code === 'CLEANUP_BLOCKED');
  assert.equal(server.requests.length, requestsBeforeRetry);
  assert.equal(archiveCalls, 1);
  assert.equal(
    pendingOperationForLane(fixture.repoRoot, laneId, fixture.env).state,
    'providerRetiredCleanupBlocked',
  );
  lane = listLanes(fixture.repoRoot, fixture.env).find((entry) => entry.laneId === laneId);
  assert.equal(lane.state, 'archivedVerified');
  assert.equal(fs.existsSync(seat.path), true);
});

test('Codex retire leaves a transient local cleanup failure retryable without replaying archive', async (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = '89898989-8989-4898-8989-898989898989';
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  let archiveCalls = 0;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadAt(seat.path, {
        id: 'thread-cleanup-transient',
        status: { type: 'idle' },
      });
    }
    if (request.method === 'thread/turns/list') return { result: { data: [] } };
    if (request.method === 'thread/archive') {
      archiveCalls += 1;
      execFileSync('git', [
        '-C', fixture.repoRoot, 'worktree', 'lock', '--reason', 'transient test lock', '--', seat.path,
      ]);
      return { result: {} };
    }
    if (request.method === 'thread/list') {
      return { result: { data: [{ id: 'thread-cleanup-transient', cwd: seat.path }], nextCursor: null } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  registerLane(fixture.repoRoot, {
    laneId,
    backend: 'codex-app-server',
    providerId: 'thread-cleanup-transient',
    displayName: '[test] cleanup transient',
    state: 'idle',
    runtime: {
      endpoint: new URL(server.url).toString(),
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
    },
    seat,
  }, fixture.env);

  await assert.rejects(() => retire({
    repoRoot: fixture.repoRoot,
    laneId,
    url: server.url,
    harvestedOutputSha256: 'e'.repeat(64),
    archiveVerifyAttempts: 1,
  }, fixture.env), (error) =>
    error.code === 'CLEANUP_RETRYABLE' && error.details.providerRetired === true
  );
  const pending = pendingOperationForLane(fixture.repoRoot, laneId, fixture.env);
  assert.equal(pending.state, 'providerRetiredCleanupDeferred');
  assert.equal(pending.details.cleanupRetryable, true);
  assert.equal(pending.details.cleanupBlocked, undefined);
  const reconciled = await recover({
    repoRoot: fixture.repoRoot,
    url: server.url,
  }, fixture.env);
  assert.equal(reconciled.ok, false, JSON.stringify(reconciled));
  assert.equal(reconciled.results[0].outcome, 'cleanupRetryable');
  assert.equal(reconciled.results[0].code, 'CLEANUP_RETRYABLE');
  assert.equal(reconciled.results[0].providerRetired, true);
  assert.equal(reconciled.results[0].cleanup, 'retryable');
  assert.equal(archiveCalls, 1);
  const requestsBeforeRetry = server.requests.length;
  execFileSync('git', ['-C', fixture.repoRoot, 'worktree', 'unlock', '--', seat.path]);

  const retried = await retire({
    repoRoot: fixture.repoRoot,
    laneId,
    url: server.url,
  }, fixture.env);
  assert.equal(retried.state, 'worktreeRemoved');
  assert.equal(server.requests.length, requestsBeforeRetry);
  assert.equal(archiveCalls, 1);
  assert.equal(fs.existsSync(seat.path), false);
});

test('Codex deferred managed cleanup retains its harvest receipt and later removes without provider calls', async (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = '89898989-8989-4898-8989-898989898989';
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadAt(seat.path, {
        id: 'thread-cleanup-deferred',
        status: { type: 'idle' },
      });
    }
    if (request.method === 'thread/turns/list') return { result: { data: [] } };
    if (request.method === 'thread/archive') return { result: {} };
    if (request.method === 'thread/list') {
      return { result: { data: [{ id: 'thread-cleanup-deferred', cwd: seat.path }], nextCursor: null } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  registerLane(fixture.repoRoot, {
    laneId,
    backend: 'codex-app-server',
    providerId: 'thread-cleanup-deferred',
    displayName: '[test] cleanup deferred',
    state: 'idle',
    runtime: {
      endpoint: new URL(server.url).toString(),
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
    },
    seat,
  }, fixture.env);

  const deferred = await retire({
    repoRoot: fixture.repoRoot,
    laneId,
    url: server.url,
    cleanupWorktree: false,
    harvestedOutputSha256: 'f'.repeat(64),
    archiveVerifyAttempts: 1,
  }, fixture.env);
  assert.equal(deferred.state, 'archivedVerified');
  assert.equal(fs.existsSync(seat.path), true);
  assert.equal(
    pendingOperationForLane(fixture.repoRoot, laneId, fixture.env).state,
    'providerRetiredCleanupDeferred',
  );
  const requestsBeforeCleanup = server.requests.length;

  const cleaned = await retire({
    repoRoot: fixture.repoRoot,
    laneId,
    url: server.url,
  }, fixture.env);
  assert.equal(cleaned.state, 'worktreeRemoved');
  assert.equal(cleaned.receipt.harvestedOutputSha256, 'f'.repeat(64));
  assert.equal(server.requests.length, requestsBeforeCleanup);
  assert.equal(pendingOperationForLane(fixture.repoRoot, laneId, fixture.env), null);
});

test('Codex retirement completes its journal after a crash immediately following worktree removal', async (t) => {
  const fixture = createRepoWithSeat(t);
  const laneId = '90919191-9091-4909-8909-919191919191';
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  const lane = registerLane(fixture.repoRoot, {
    laneId,
    backend: 'codex-app-server',
    providerId: 'thread-remove-crash',
    displayName: '[test] removal crash',
    state: 'archivedVerified',
    runtime: {
      endpoint: 'ws://127.0.0.1:8843/',
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
    },
    seat,
  }, fixture.env);
  const harvestReceipt = captureHarvestReceipt(
    fixture.repoRoot,
    lane.seat,
    '1'.repeat(64),
  );
  const operation = beginLaneOperation(fixture.repoRoot, laneId, {
    type: 'retire',
    providerId: lane.providerId,
    state: 'providerRetired',
    details: { target: 'codex', harvestReceipt },
  }, fixture.env);
  removeManagedSeat(fixture.repoRoot, laneId, harvestReceipt, fixture.env);
  assert.equal(pendingOperationForLane(fixture.repoRoot, laneId, fixture.env).operationId, operation.operationId);

  const recovered = await retire({
    repoRoot: fixture.repoRoot,
    laneId,
  }, fixture.env);
  assert.equal(recovered.state, 'worktreeRemoved');
  assert.equal(recovered.receipt.harvestedOutputSha256, '1'.repeat(64));
  assert.equal(pendingOperationForLane(fixture.repoRoot, laneId, fixture.env), null);
});

test('Codex status and recovery read only exact registry-owned ids', async (t) => {
  const fixture = createRepoWithSeat(t);
  const readIds = [];
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{ id: 'turn-owned', status: 'inProgress', items: [] }] } };
    }
    assert.equal(request.method, 'thread/read');
    readIds.push(request.params.threadId);
    return threadReadResult(fixture, {
      id: request.params.threadId,
      status: { type: 'active', activeFlags: [] },
    });
  });
  t.after(() => server.close());
  registerOwned(fixture, server.url);

  const statusResult = await status({
    repoRoot: fixture.repoRoot,
    providerId: 'thread-owned',
    url: server.url,
  }, fixture.env);
  assert.equal(statusResult.rawState.type, 'active');
  const recovered = await recover({ repoRoot: fixture.repoRoot, url: server.url }, fixture.env);
  assert.equal(recovered.ok, true);
  assert.deepEqual(readIds, ['thread-owned', 'thread-owned']);
});

test('Codex recovery subtracts local reconciliation from its client connection budget', async (t) => {
  const fixture = createRepoWithSeat(t);
  registerOwned(fixture, 'ws://127.0.0.1:65534');
  const originalConnect = AppServerClient.prototype.connect;
  const originalNow = Date.now;
  let now = 10_000;
  let observedTimeoutMs;
  Date.now = () => now;
  AppServerClient.prototype.connect = async function connectProbe() {
    observedTimeoutMs = this.timeoutMs;
    throw new Error('connection budget captured');
  };
  try {
    const recovering = recover({
      repoRoot: fixture.repoRoot,
      url: 'ws://127.0.0.1:65534',
      timeoutMs: 1_000,
    }, fixture.env);
    now += 400;
    await assert.rejects(recovering, /connection budget captured/);
  } finally {
    AppServerClient.prototype.connect = originalConnect;
    Date.now = originalNow;
  }
  assert.equal(observedTimeoutMs, 600);
});

test('Codex status normalizes provider status before output and persistence', async (t) => {
  const fixture = createRepoWithSeat(t);
  const secret = 'must-not-persist';
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/turns/list') return { result: { data: [] } };
    return threadReadResult(fixture, {
      id: 'thread-owned',
      status: { type: 'active', activeFlags: ['waitingOnUserInput'], secret },
    });
  });
  t.after(() => server.close());
  registerOwned(fixture, server.url);
  const result = await status({
    repoRoot: fixture.repoRoot,
    providerId: 'thread-owned',
    url: server.url,
  }, fixture.env);
  assert.deepEqual(result.rawState, { type: 'active', activeFlags: ['waitingOnUserInput'] });
  assert.deepEqual(listLanes(fixture.repoRoot, fixture.env)[0].providerState, result.rawState);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('Codex status rejects a provider cwd mismatch without changing registry state', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadAt(`${providerCwd(fixture)}-wrong`, {
        id: 'thread-owned',
        status: { type: 'active', activeFlags: [] },
      });
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url, 'active');
  const before = JSON.stringify(listLanes(fixture.repoRoot, fixture.env));

  await assert.rejects(() => status({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
  }, fixture.env), (error) => error.code === 'OWNERSHIP_MISMATCH');
  assert.equal(JSON.stringify(listLanes(fixture.repoRoot, fixture.env)), before);
  assert.deepEqual(
    server.requests.filter((request) => request.id !== undefined).map((request) => request.method),
    ['initialize', 'thread/read'],
  );
});

test('Codex status classifies malformed provider cwd as a protocol error without state changes', async (t) => {
  for (const [name, cwd] of [['missing', undefined], ['non-string', null]]) {
    await t.test(name, async (st) => {
      const fixture = createRepoWithSeat(st);
      const server = await startMockAppServer((request) => {
        if (request.method === 'thread/read') {
          return { result: { thread: {
            id: 'thread-owned',
            ...(cwd === undefined ? {} : { cwd }),
            status: { type: 'active', activeFlags: [] },
          } } };
        }
        throw new Error(`unexpected ${request.method}`);
      });
      st.after(() => server.close());
      const lane = registerOwned(fixture, server.url, 'active');
      const before = JSON.stringify(listLanes(fixture.repoRoot, fixture.env));

      await assert.rejects(() => status({
        repoRoot: fixture.repoRoot,
        laneId: lane.laneId,
        url: server.url,
      }, fixture.env), (error) => error.code === 'PROTOCOL_ERROR');
      assert.equal(JSON.stringify(listLanes(fixture.repoRoot, fixture.env)), before);
      assert.deepEqual(
        server.requests.filter((request) => request.id !== undefined).map((request) => request.method),
        ['initialize', 'thread/read'],
      );
    });
  }
});

test('Codex control mutations refuse a provider cwd mismatch before dispatch', async (t) => {
  const cases = [
    {
      name: 'steer',
      state: 'active',
      run: (fixture, lane, url) => steer({
        repoRoot: fixture.repoRoot,
        laneId: lane.laneId,
        url,
        message: 'Must not cross seats.',
      }, fixture.env),
    },
    {
      name: 'interrupt',
      state: 'active',
      run: (fixture, lane, url) => interrupt({
        repoRoot: fixture.repoRoot,
        laneId: lane.laneId,
        url,
      }, fixture.env),
    },
    {
      name: 'retire',
      state: 'idle',
      run: (fixture, lane, url) => retire({
        repoRoot: fixture.repoRoot,
        laneId: lane.laneId,
        url,
        harvestedOutputSha256: 'c'.repeat(64),
      }, fixture.env),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const fixture = createRepoWithSeat(st);
      const server = await startMockAppServer((request) => {
        if (request.method === 'thread/read') {
          return threadReadAt(`${providerCwd(fixture)}-wrong`, {
            id: 'thread-owned',
            status: { type: entry.state, activeFlags: [] },
          });
        }
        throw new Error(`unexpected provider request ${request.method}`);
      });
      st.after(() => server.close());
      const lane = registerOwned(fixture, server.url, entry.state);

      await assert.rejects(
        () => entry.run(fixture, lane, server.url),
        (error) => error.code === 'OWNERSHIP_MISMATCH',
      );
      assert.deepEqual(
        server.requests.filter((request) => request.id !== undefined).map((request) => request.method),
        ['initialize', 'thread/read'],
      );
      assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
    });
  }
});

function registerOwnedElsewhere(fixture, state, identity = {}) {
  return registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'thread-owned',
    displayName: '[test] owned elsewhere',
    state,
    runtime: {
      endpoint: 'ws://127.0.0.1:65534/',
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
      ...identity,
    },
    seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot),
    capabilities: {
      midTurnSteer: true,
      interrupt: true,
      retirement: 'archive',
      recovery: 'crossRoot',
    },
  }, fixture.env);
}

function movedRuntimeServer(t, fixture) {
  return startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, {
        id: 'thread-owned',
        name: '::: lane: moved',
        status: { type: 'idle' },
      });
    }
    if (request.method === 'thread/turns/list') return { result: { data: [] } };
    throw new Error(`unexpected ${request.method}`);
  });
}

test('Codex recovery moves an owned lane to the connected endpoint when the runtime identity matches', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await movedRuntimeServer(t, fixture);
  t.after(() => server.close());
  const lane = registerOwnedElsewhere(fixture, 'idle');

  const result = await recover({ repoRoot: fixture.repoRoot, url: server.url }, fixture.env);
  assert.equal(result.ok, true);
  assert.equal(result.receipt.providerConnection, 'verified');
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0], {
    laneId: lane.laneId,
    providerId: 'thread-owned',
    state: 'idle',
    phase: 'idle',
    providerPhase: 'idle',
    outcome: 'runtimeRebound',
    delivery: 'confirmed',
    repaired: ['runtimeEndpoint'],
    pendingOperation: null,
  });
  const rebound = requireOwnedLane(fixture.repoRoot, lane.laneId, fixture.env);
  assert.equal(rebound.runtime.endpoint, new URL(server.url).toString());
  assert.equal(rebound.runtime.codexHome, '/tmp/codex-home');
  assert.deepEqual(
    server.requests.filter((request) => request.id !== undefined).map((request) => request.method),
    ['initialize', 'thread/read', 'thread/turns/list'],
  );

  // The lane now answers ordinary commands on the new endpoint.
  const observed = await status({ repoRoot: fixture.repoRoot, laneId: lane.laneId, url: server.url }, fixture.env);
  assert.equal(observed.phase, 'idle');
});

test('Codex single-lane recovery rebinds an endpoint move and refuses a different runtime', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await movedRuntimeServer(t, fixture);
  t.after(() => server.close());
  const lane = registerOwnedElsewhere(fixture, 'idle');

  const result = await recover({ repoRoot: fixture.repoRoot, laneId: lane.laneId, url: server.url }, fixture.env);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].outcome, 'runtimeRebound');
  assert.equal(requireOwnedLane(fixture.repoRoot, lane.laneId, fixture.env).runtime.endpoint, new URL(server.url).toString());

  const foreign = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId: 'thread-foreign-home',
    displayName: '[test] other home',
    state: 'idle',
    runtime: {
      endpoint: 'ws://127.0.0.1:65534/',
      codexHome: '/tmp/other-home',
      platformFamily: 'unix',
      platformOs: 'test',
    },
  }, fixture.env);
  const before = server.requests.length;
  await assert.rejects(
    () => recover({ repoRoot: fixture.repoRoot, laneId: foreign.laneId, url: server.url }, fixture.env),
    (error) => error.code === 'RUNTIME_MISMATCH',
  );
  assert.deepEqual(
    server.requests.slice(before).filter((request) => request.id !== undefined).map((request) => request.method),
    ['initialize'],
  );
  assert.equal(requireOwnedLane(fixture.repoRoot, foreign.laneId, fixture.env).runtime.endpoint, 'ws://127.0.0.1:65534/');
});

test('Codex aggregate recovery reports a lane on a different runtime without writing', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await movedRuntimeServer(t, fixture);
  t.after(() => server.close());
  const lane = registerOwnedElsewhere(fixture, 'idle', { codexHome: '/tmp/other-home' });

  const result = await recover({ repoRoot: fixture.repoRoot, url: server.url }, fixture.env);
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].outcome, 'differentRuntime');
  assert.equal(result.results[0].delivery, 'unknown');
  assert.deepEqual(result.results[0].repaired, []);
  assert.deepEqual(
    server.requests.filter((request) => request.id !== undefined).map((request) => request.method),
    ['initialize'],
  );
  assert.equal(requireOwnedLane(fixture.repoRoot, lane.laneId, fixture.env).runtime.endpoint, 'ws://127.0.0.1:65534/');
});

test('Codex recovery keeps a moved lane on its old endpoint when its thread is not readable there', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') return { error: { code: -32602, message: 'thread not found' } };
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwnedElsewhere(fixture, 'idle');

  const result = await recover({ repoRoot: fixture.repoRoot, url: server.url }, fixture.env);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].outcome, 'differentRuntime');
  assert.equal(typeof result.results[0].causeCode, 'string');
  assert.equal(requireOwnedLane(fixture.repoRoot, lane.laneId, fixture.env).runtime.endpoint, 'ws://127.0.0.1:65534/');
});

test('Codex recovery does not complete or dispatch an unstarted pending retirement', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url, 'idle');
  const harvestReceipt = captureHarvestReceipt(
    fixture.repoRoot,
    lane.seat,
    'e'.repeat(64),
  );
  const operation = beginLaneOperation(fixture.repoRoot, lane.laneId, {
    type: 'retire',
    providerId: lane.providerId,
    details: { target: 'codex', harvestReceipt },
  }, fixture.env);

  const recovered = await recover({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
  }, fixture.env);
  assert.equal(recovered.ok, false);
  assert.equal(recovered.results[0].pendingOperation, 'retire');
  assert.deepEqual(server.requests.map((request) => request.method), ['initialize']);
  assert.equal(
    pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env).operationId,
    operation.operationId,
  );
});

test('Codex recovery repairs a transport-unknown first turn without replaying input', async (t) => {
  const fixture = createRepoWithSeat(t);
  let mode = 'launch';
  let turnStarts = 0;
  let nameSets = 0;
  let clientUserMessageId;
  let dispatchedInput;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/start') {
      return threadStartResult(fixture, 'thread-recovery');
    }
    if (request.method === 'turn/start') {
      turnStarts += 1;
      clientUserMessageId = request.params.clientUserMessageId;
      dispatchedInput = request.params.input;
      return NO_RESPONSE;
    }
    if (request.method === 'thread/read') {
      return { result: { thread: {
        id: 'thread-recovery',
        cwd: fs.realpathSync(fixture.seat),
        name: nameSets ? '::: [test] recovery' : fs.realpathSync(fixture.seat),
        status: { type: 'active', activeFlags: [] },
      } } };
    }
    if (request.method === 'thread/turns/list') {
      assert.equal(mode, 'recover');
      return { result: { data: [{ id: 'turn-recovery', status: 'inProgress', items: [] }] } };
    }
    if (request.method === 'thread/items/list') {
      assert.equal(mode, 'recover');
      return { result: { data: [{
        turnId: 'turn-recovery',
        item: {
          id: 'user-turn-recovery',
          type: 'userMessage',
          clientId: clientUserMessageId,
          content: dispatchedInput,
        },
      }], nextCursor: null } };
    }
    if (request.method === 'thread/name/set') {
      nameSets += 1;
      return { result: {} };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  t.after(() => server.close());

  await assert.rejects(() => spawn({
    ...baseOptions(fixture, server.url),
    name: '[test] recovery',
    turnStartTimeoutMs: 25,
  }, fixture.env), /timeout awaiting turn\/start/);
  assert.equal(turnStarts, 1);
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'deliveryUnknown');

  mode = 'recover';
  const result = await recover({ repoRoot: fixture.repoRoot, url: server.url }, fixture.env);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results[0].repaired.sort(), ['name', 'spawnInputReceipt']);
  assert.equal(turnStarts, 1);
  assert.equal(nameSets, 1);
  const lane = listLanes(fixture.repoRoot, fixture.env)[0];
  assert.equal(lane.state, 'active');
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  assert.equal(listOperations(fixture.repoRoot, fixture.env)[0].state, 'complete');
});

// A pending spawn journal already bound to its provider thread, stuck in one
// of the states in which turn/start's input receipt may simply be absent.
function spawnAbsenceFixture(fixture, server, state, turnDispatchStartedAt) {
  const lane = registerOwned(fixture, server.url, 'created');
  const operation = beginLaneOperation(fixture.repoRoot, lane.laneId, {
    type: 'spawn',
    state,
    providerId: lane.providerId,
    details: {
      target: 'codex',
      name: lane.displayName,
      inputSha256: 'a'.repeat(64),
      turnDispatchStartedAt,
    },
  }, fixture.env);
  return { lane, operation };
}

const FORBIDDEN_MUTATIONS = ['turn/start', 'turn/steer', 'thread/resume', 'thread/archive'];

test('Codex recovery keeps a spawn absence pending before its grace period elapses', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, { id: 'thread-owned', status: { type: 'idle' } });
    }
    if (request.method === 'thread/turns/list') return { result: { data: [] } };
    if (request.method === 'thread/items/list') return { result: { data: [], nextCursor: null } };
    throw new Error(`unexpected provider request ${request.method}`);
  });
  t.after(() => server.close());
  const turnDispatchStartedAt = '2026-09-01T00:00:00.000Z';
  const { lane, operation } = spawnAbsenceFixture(fixture, server, 'turnRequestDispatched', turnDispatchStartedAt);

  const result = await recover({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
    clock: () => Date.parse(turnDispatchStartedAt) + 59_000,
  }, fixture.env);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].delivery, 'unknown');
  assert.equal(result.results[0].pendingOperation, 'spawn');
  assert.deepEqual(result.results[0].repaired, []);
  const pending = pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env);
  assert.equal(pending.operationId, operation.operationId);
  assert.equal(pending.state, 'turnRequestDispatched');
  assert.equal(server.requests.some((request) => FORBIDDEN_MUTATIONS.includes(request.method)), false);
});

test('Codex recovery settles an elapsed spawn absence as not delivered without dispatching input', async (t) => {
  for (const state of ['turnRequestDispatched', 'partial', 'unknown']) {
    await t.test(state, async (st) => {
      const fixture = createRepoWithSeat(st);
      const server = await startMockAppServer((request) => {
        if (request.method === 'thread/read') {
          return threadReadResult(fixture, { id: 'thread-owned', status: { type: 'idle' } });
        }
        if (request.method === 'thread/turns/list') return { result: { data: [] } };
        if (request.method === 'thread/items/list') return { result: { data: [], nextCursor: null } };
        throw new Error(`unexpected provider request ${request.method}`);
      });
      st.after(() => server.close());
      const turnDispatchStartedAt = '2026-09-01T00:00:00.000Z';
      const { lane, operation } = spawnAbsenceFixture(fixture, server, state, turnDispatchStartedAt);

      const result = await recover({
        repoRoot: fixture.repoRoot,
        laneId: lane.laneId,
        url: server.url,
        clock: () => Date.parse(turnDispatchStartedAt) + 61_000,
      }, fixture.env);
      assert.equal(result.ok, true);
      assert.equal(result.results[0].delivery, 'notDelivered');
      assert.deepEqual(result.results[0].repaired, ['spawnInputAbsent']);
      assert.equal(result.results[0].state, 'failed');
      assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'failed');
      assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
      const settled = listOperations(fixture.repoRoot, fixture.env)
        .find((entry) => entry.operationId === operation.operationId);
      assert.equal(settled.state, 'notDelivered');
      assert.equal(settled.details.outcome, 'spawnInputAbsent');
      assert.match(settled.details.observedAbsentAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(server.requests.some((request) => FORBIDDEN_MUTATIONS.includes(request.method)), false);
    });
  }
});

test('Codex recovery keeps a spawn absence pending while a turn is in progress', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, { id: 'thread-owned', status: { type: 'active', activeFlags: [] } });
    }
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{ id: 'turn-in-flight', status: 'inProgress', items: [] }] } };
    }
    if (request.method === 'thread/items/list') return { result: { data: [], nextCursor: null } };
    throw new Error(`unexpected provider request ${request.method}`);
  });
  t.after(() => server.close());
  const turnDispatchStartedAt = '2026-09-01T00:00:00.000Z';
  const { lane, operation } = spawnAbsenceFixture(fixture, server, 'unknown', turnDispatchStartedAt);

  const result = await recover({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
    clock: () => Date.parse(turnDispatchStartedAt) + 3_600_000,
  }, fixture.env);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].delivery, 'unknown');
  assert.equal(result.results[0].pendingOperation, 'spawn');
  assert.deepEqual(result.results[0].repaired, []);
  const pending = pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env);
  assert.equal(pending.operationId, operation.operationId);
  assert.equal(pending.state, 'unknown');
  assert.equal(server.requests.some((request) => FORBIDDEN_MUTATIONS.includes(request.method)), false);
});

test('Codex recovery settles a pending steer as complete when its persisted receipt is found', async (t) => {
  const fixture = createRepoWithSeat(t);
  const message = 'steer settles from receipt';
  let steerOperationId;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, { id: 'thread-owned', status: { type: 'active', activeFlags: [] } });
    }
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{ id: 'turn-steer-active', status: 'inProgress', items: [] }] } };
    }
    if (request.method === 'thread/items/list') {
      return { result: { data: [{
        turnId: 'turn-steer-active',
        item: {
          id: 'user-steer-1',
          type: 'userMessage',
          clientId: steerOperationId,
          content: [{ type: 'text', text: message }],
        },
      }], nextCursor: null } };
    }
    throw new Error(`unexpected provider request ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url, 'active');
  const operation = beginLaneOperation(fixture.repoRoot, lane.laneId, {
    type: 'steer',
    state: 'unknown',
    providerId: lane.providerId,
    details: {
      target: 'codex',
      expectedTurnId: 'turn-steer-active',
      messageSha256: crypto.createHash('sha256').update(message).digest('hex'),
    },
  }, fixture.env);
  steerOperationId = operation.operationId;

  const result = await recover({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
  }, fixture.env);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].delivery, 'confirmed');
  assert.deepEqual(result.results[0].repaired, ['steerInputReceipt']);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  const settled = listOperations(fixture.repoRoot, fixture.env)
    .find((entry) => entry.operationId === operation.operationId);
  assert.equal(settled.state, 'complete');
  assert.equal(settled.details.recoveredTurnId, 'turn-steer-active');
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'active');
});

test('Codex recovery settles a pending steer as not delivered once its target turn ends unreceipted', async (t) => {
  const fixture = createRepoWithSeat(t);
  const message = 'steer never landed';
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, { id: 'thread-owned', status: { type: 'idle' } });
    }
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{ id: 'turn-steer-done', status: 'completed', items: [] }] } };
    }
    if (request.method === 'thread/items/list') return { result: { data: [], nextCursor: null } };
    throw new Error(`unexpected provider request ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url, 'active');
  const operation = beginLaneOperation(fixture.repoRoot, lane.laneId, {
    type: 'steer',
    state: 'dispatching',
    providerId: lane.providerId,
    details: {
      target: 'codex',
      expectedTurnId: 'turn-steer-done',
      messageSha256: crypto.createHash('sha256').update(message).digest('hex'),
    },
  }, fixture.env);

  const result = await recover({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
  }, fixture.env);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].delivery, 'notDelivered');
  assert.deepEqual(result.results[0].repaired, ['steerInputAbsent']);
  assert.equal(pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env), null);
  const settled = listOperations(fixture.repoRoot, fixture.env)
    .find((entry) => entry.operationId === operation.operationId);
  assert.equal(settled.state, 'notDelivered');
  assert.match(settled.details.notDeliveredObservedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(listLanes(fixture.repoRoot, fixture.env)[0].state, 'idle');
  assert.equal(server.requests.some((request) => FORBIDDEN_MUTATIONS.includes(request.method)), false);
});

test('Codex recovery keeps a pending steer unknown while its target turn is still active and unreceipted', async (t) => {
  const fixture = createRepoWithSeat(t);
  const message = 'steer still in flight';
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, { id: 'thread-owned', status: { type: 'active', activeFlags: [] } });
    }
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{ id: 'turn-steer-active', status: 'inProgress', items: [] }] } };
    }
    if (request.method === 'thread/items/list') return { result: { data: [], nextCursor: null } };
    throw new Error(`unexpected provider request ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url, 'active');
  const operation = beginLaneOperation(fixture.repoRoot, lane.laneId, {
    type: 'steer',
    state: 'unknown',
    providerId: lane.providerId,
    details: {
      target: 'codex',
      expectedTurnId: 'turn-steer-active',
      messageSha256: crypto.createHash('sha256').update(message).digest('hex'),
    },
  }, fixture.env);

  const result = await recover({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
  }, fixture.env);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].delivery, 'unknown');
  assert.equal(result.results[0].pendingOperation, 'steer');
  assert.deepEqual(result.results[0].repaired, []);
  const pending = pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env);
  assert.equal(pending.operationId, operation.operationId);
  assert.equal(pending.state, 'unknown');
  assert.equal(server.requests.some((request) => FORBIDDEN_MUTATIONS.includes(request.method)), false);
});

test('Codex recovery fails closed when a persisted steer receipt names a different turn', async (t) => {
  const fixture = createRepoWithSeat(t);
  const message = 'steer receipt mismatch';
  let steerOperationId;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/read') {
      return threadReadResult(fixture, { id: 'thread-owned', status: { type: 'active', activeFlags: [] } });
    }
    if (request.method === 'thread/turns/list') {
      return { result: { data: [{ id: 'turn-steer-active', status: 'inProgress', items: [] }] } };
    }
    if (request.method === 'thread/items/list') {
      return { result: { data: [{
        turnId: 'turn-other',
        item: {
          id: 'user-steer-mismatch',
          type: 'userMessage',
          clientId: steerOperationId,
          content: [{ type: 'text', text: message }],
        },
      }], nextCursor: null } };
    }
    throw new Error(`unexpected provider request ${request.method}`);
  });
  t.after(() => server.close());
  const lane = registerOwned(fixture, server.url, 'active');
  const operation = beginLaneOperation(fixture.repoRoot, lane.laneId, {
    type: 'steer',
    state: 'unknown',
    providerId: lane.providerId,
    details: {
      target: 'codex',
      expectedTurnId: 'turn-steer-active',
      messageSha256: crypto.createHash('sha256').update(message).digest('hex'),
    },
  }, fixture.env);
  steerOperationId = operation.operationId;

  const result = await recover({
    repoRoot: fixture.repoRoot,
    laneId: lane.laneId,
    url: server.url,
  }, fixture.env);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].code, 'PROTOCOL_ERROR');
  assert.match(result.results[0].error, /different turn/);
  const pending = pendingOperationForLane(fixture.repoRoot, lane.laneId, fixture.env);
  assert.equal(pending.operationId, operation.operationId);
  assert.equal(pending.state, 'unknown');
});

test('Codex recovery reports a retired lane bound elsewhere as already retired without contacting the runtime', async (t) => {
  const fixture = createRepoWithSeat(t);
  const server = await startMockAppServer((request) => { throw new Error(`unexpected ${request.method}`); });
  t.after(() => server.close());
  const retired = registerLane(fixture.repoRoot, {
    backend: 'codex-app-server', providerId: 'thread-retired-elsewhere', displayName: '[test] retired elsewhere',
    state: 'worktreeRemoved',
    runtime: { endpoint: 'ws://127.0.0.1:65534/', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'test' },
  }, fixture.env);
  const result = await recover({ repoRoot: fixture.repoRoot, url: server.url }, fixture.env);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((r) => [r.laneId, r.outcome, r.delivery]), [[retired.laneId, 'alreadyRetired', 'confirmed']]);
  assert.equal(result.receipt.providerConnection, 'notRequired');
  assert.equal(server.requests.length, 0);
});
