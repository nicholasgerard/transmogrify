'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AppServerClient, MAX_INBOUND_MESSAGE_BYTES } = require('../scripts/lib/app-server');
const { NO_RESPONSE, startMockAppServer } = require('./helpers/mock-app-server');

test('app-server client initializes before sending requests and always supplies params', async (t) => {
  const server = await startMockAppServer((request) => {
    assert.equal(request.method, 'model/list');
    assert.deepEqual(request.params, {});
    return { result: { data: [] } };
  });
  t.after(() => server.close());
  const client = new AppServerClient({ url: server.url });
  t.after(() => client.close());

  await client.connect();
  const result = await client.call('model/list');
  assert.deepEqual(result, { data: [] });
  assert.deepEqual(server.requests.slice(0, 3).map((request) => request.method), [
    'initialize', 'initialized', 'model/list',
  ]);
});

test('app-server connect gives initialize only the transport deadline remainder', async (t) => {
  const server = await startMockAppServer();
  t.after(() => server.close());
  const client = new AppServerClient({ url: server.url, timeoutMs: 2_000 });
  t.after(() => client.close());
  const call = client.call.bind(client);
  let initializeTimeoutMs;
  client.call = (method, params, timeoutMs) => {
    if (method === 'initialize') initializeTimeoutMs = timeoutMs;
    return call(method, params, timeoutMs);
  };

  await client.connect();
  assert.equal(Number.isInteger(initializeTimeoutMs), true);
  assert.equal(initializeTimeoutMs > 0 && initializeTimeoutMs <= 2_000, true);
});

test('app-server client fails closed on a non-Codex initialize response', async (t) => {
  const server = await startMockAppServer(undefined, {
    initializeResult: { userAgent: 'different-service/1.0' },
  });
  t.after(() => server.close());
  const client = new AppServerClient({ url: server.url });
  t.after(() => client.close());
  await assert.rejects(() => client.connect(), /invalid Codex app-server initialize response/);
});

test('app-server client accepts the live-verified Codex Desktop user-agent family', async (t) => {
  const server = await startMockAppServer(undefined, {
    initializeResult: {
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'macos',
      userAgent: 'Codex Desktop/0.151.0 (test)',
    },
  });
  t.after(() => server.close());
  const client = new AppServerClient({ url: server.url });
  t.after(() => client.close());
  const initialized = await client.connect();
  assert.equal(client.verifiedRuntime, true);
  assert.equal(initialized.userAgent, 'Codex Desktop/0.151.0');
  assert.equal(client.userAgent, 'Codex Desktop/0.151.0');
});

test('app-server client never returns or retains a user-agent suffix', async (t) => {
  const secret = 'token=must-not-persist';
  const server = await startMockAppServer(undefined, {
    initializeResult: {
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'macos',
      userAgent: `codex_cli_rs/0.151.0 ${secret}`,
      extraProviderField: secret,
    },
  });
  t.after(() => server.close());
  const client = new AppServerClient({ url: server.url });
  t.after(() => client.close());
  const initialized = await client.connect();
  assert.equal(initialized.userAgent, 'codex_cli_rs/0.151.0');
  assert.equal(JSON.stringify(initialized).includes(secret), false);
  assert.deepEqual(Object.keys(initialized).sort(), [
    'codexHome', 'platformFamily', 'platformOs', 'userAgent',
  ]);
  assert.equal(client.userAgent.includes(secret), false);
});

test('app-server client rejects hostile or non-normalized Codex home paths', async (t) => {
  for (const codexHome of ['/tmp/../tmp/codex-home', '/tmp/codex-home\nsecret']) {
    const server = await startMockAppServer(undefined, {
      initializeResult: {
        codexHome,
        platformFamily: 'unix',
        platformOs: 'macos',
        userAgent: 'codex_cli_rs/0.151.0',
      },
    });
    t.after(() => server.close());
    const client = new AppServerClient({ url: server.url });
    t.after(() => client.close());
    await assert.rejects(() => client.connect(), /invalid Codex app-server initialize response/);
  }
});

test('server request ids cannot collide with pending client request ids', async (t) => {
  let refusal;
  let markRefusal;
  const refusalReceived = new Promise((resolve) => { markRefusal = resolve; });
  const server = await startMockAppServer((request, socket) => {
    if (!request.method) {
      refusal = request;
      markRefusal();
      return NO_RESPONSE;
    }
    assert.equal(request.method, 'model/list');
    socket.send(JSON.stringify({
      id: request.id,
      method: 'item/commandExecution/requestApproval',
      params: { reason: 'test collision' },
    }));
    setTimeout(() => {
      socket.send(JSON.stringify({ id: request.id, result: { data: ['actual response'] } }));
    }, 10);
    return NO_RESPONSE;
  });
  t.after(() => server.close());
  const client = new AppServerClient({ url: server.url });
  t.after(() => client.close());

  await client.connect();
  assert.deepEqual(await client.call('model/list'), { data: ['actual response'] });
  await refusalReceived;
  assert.equal(refusal.error.code, -32000);
});

test('app-server client rejects malformed JSON-RPC response envelopes', async (t) => {
  const server = await startMockAppServer((request) => {
    assert.equal(request.method, 'model/list');
    return { result: { data: [] }, error: { code: -32000, message: 'both are invalid' } };
  });
  t.after(() => server.close());
  const client = new AppServerClient({ url: server.url });
  t.after(() => client.close());

  await client.connect();
  await assert.rejects(
    () => client.call('model/list'),
    (error) => error.code === 'PROTOCOL_ERROR' && /response envelope/.test(error.message),
  );
});

test('app-server client rejects unsafe timer values', () => {
  assert.throws(() => new AppServerClient({
    url: 'ws://127.0.0.1:8843',
    timeoutMs: 2_147_483_648,
  }), /invalid timeout/);
  assert.throws(() => new AppServerClient({
    url: 'ws://example.com:8843',
  }), /non-loopback/);
  assert.throws(() => new AppServerClient({
    url: 'ws://localhost:8843',
  }), /non-loopback/);
});

test('app-server client rejects secret-bearing or non-root endpoint URLs without echoing them', () => {
  for (const url of [
    'ws://operator:supersecret@127.0.0.1:8843',
    'ws://127.0.0.1:8843/control',
    'ws://127.0.0.1:8843/?token=supersecret',
    'ws://127.0.0.1:8843/#supersecret',
  ]) {
    assert.throws(
      () => new AppServerClient({ url }),
      (error) => error.code === 'USAGE_ERROR' &&
        /credentials, paths, queries, and fragments/.test(error.message) &&
        !error.message.includes('supersecret'),
    );
  }
});

test('an explicit server-request handler can return a typed response', async (t) => {
  let resolveHandled;
  const handled = new Promise((resolve) => { resolveHandled = resolve; });
  const server = await startMockAppServer((request, socket) => {
    if (!request.method) {
      resolveHandled(request);
      return NO_RESPONSE;
    }
    socket.send(JSON.stringify({
      id: 991,
      method: 'item/tool/requestUserInput',
      params: { threadId: 'thread-test' },
    }));
    setTimeout(() => socket.send(JSON.stringify({
      id: request.id,
      result: { data: [] },
    })), 10);
    return NO_RESPONSE;
  });
  t.after(() => server.close());
  const client = new AppServerClient({
    url: server.url,
    serverRequestHandler: async (request) => ({ result: { requestId: request.id, answer: 'test' } }),
  });
  t.after(() => client.close());
  await client.connect();
  await client.call('model/list');
  assert.deepEqual(await handled, { id: 991, result: { requestId: 991, answer: 'test' } });
});

test('provider notifications cannot impersonate reserved client events', async (t) => {
  const methods = ['error', 'connection/closed', 'notification', 'newListener', 'removeListener'];
  const server = await startMockAppServer((request, socket) => {
    assert.equal(request.method, 'model/list');
    for (const method of methods) {
      socket.send(JSON.stringify({ method, params: { hostile: true } }));
    }
    return { result: { data: [] } };
  });
  t.after(() => server.close());
  const client = new AppServerClient({ url: server.url });
  t.after(() => client.close());
  const notifications = [];
  let closedEvents = 0;
  client.on('notification', (event) => notifications.push(event));
  client.on('connection/closed', () => { closedEvents += 1; });

  await client.connect();
  assert.deepEqual(await client.call('model/list'), { data: [] });
  assert.deepEqual(notifications.map((event) => event.method), methods);
  assert.equal(closedEvents, 0);
});

test('server-request handler failures return a fixed error without secret egress', async (t) => {
  const secret = 'handler-secret-must-not-egress';
  let resolveHandled;
  const handled = new Promise((resolve) => { resolveHandled = resolve; });
  const server = await startMockAppServer((request, socket) => {
    if (!request.method) {
      resolveHandled(request);
      return NO_RESPONSE;
    }
    socket.send(JSON.stringify({
      id: 992,
      method: 'item/tool/requestUserInput',
      params: { threadId: 'thread-test' },
    }));
    setTimeout(() => socket.send(JSON.stringify({
      id: request.id,
      result: { data: [] },
    })), 10);
    return NO_RESPONSE;
  });
  t.after(() => server.close());
  const client = new AppServerClient({
    url: server.url,
    serverRequestHandler: async () => { throw new Error(secret); },
  });
  t.after(() => client.close());
  await client.connect();
  await client.call('model/list');
  const response = await handled;
  assert.equal(response.error.message, 'transmogrify server request handler failed');
  assert.equal(JSON.stringify(response).includes(secret), false);
});

test('app-server client rejects binary and over-bound inbound frames', async (t) => {
  for (const [name, payload] of [
    ['binary', Buffer.from('{}')],
    ['oversized text', 'x'.repeat(MAX_INBOUND_MESSAGE_BYTES + 1)],
  ]) {
    const server = await startMockAppServer((request, socket) => {
      assert.equal(request.method, 'model/list');
      socket.send(payload);
      return NO_RESPONSE;
    });
    t.after(() => server.close());
    const client = new AppServerClient({ url: server.url, timeoutMs: 5000 });
    t.after(() => client.close());
    await client.connect();
    await assert.rejects(
      () => client.call('model/list'),
      (error) => ['TRANSPORT_ERROR', 'TRANSPORT_UNKNOWN'].includes(error.code),
      name,
    );
  }
});

test('app-server client closes cleanly on malformed JSON-RPC frames', async (t) => {
  for (const [name, frame] of [
    ['null', 'null'],
    ['array', '[]'],
    ['object method', JSON.stringify({ method: { hostile: true }, params: {} })],
    ['array params', JSON.stringify({ method: 'turn/started', params: [] })],
  ]) {
    const server = await startMockAppServer((request, socket) => {
      assert.equal(request.method, 'model/list');
      socket.send(frame);
      return NO_RESPONSE;
    });
    t.after(() => server.close());
    const client = new AppServerClient({ url: server.url, timeoutMs: 5000 });
    t.after(() => client.close());
    await client.connect();
    await assert.rejects(
      () => client.call('model/list'),
      (error) => error.code === 'TRANSPORT_UNKNOWN',
      name,
    );
  }
});

test('app-server client judges the runtime by version, not by product name', async (t) => {
  const { canonicalCodexUserAgent, supportedAppServerVersion, MINIMUM_APP_SERVER_VERSION } = require('../scripts/lib/app-server');
  assert.equal(MINIMUM_APP_SERVER_VERSION, '0.151.0');
  // The managed daemon reports the originator of its first client.
  assert.equal(canonicalCodexUserAgent('relay-probe/0.151.0 (Mac OS 15.7.8; arm64) unknown (probe; 0)'), 'relay-probe/0.151.0');
  assert.equal(canonicalCodexUserAgent('Codex Desktop/0.153.0 (test)'), 'Codex Desktop/0.153.0');
  assert.equal(canonicalCodexUserAgent('codex_cli_rs/0.151.0'), 'codex_cli_rs/0.151.0');
  assert.equal(canonicalCodexUserAgent('nope'), null);
  assert.equal(canonicalCodexUserAgent('bad\nname/0.151.0'), null);
  assert.equal(supportedAppServerVersion('codex_cli_rs/0.151.0'), true);
  assert.equal(supportedAppServerVersion('anything/0.160.2'), true);
  assert.equal(supportedAppServerVersion('codex_cli_rs/0.148.0'), false);
  assert.equal(supportedAppServerVersion('codex_cli_rs/0.150.9'), false);
  assert.equal(supportedAppServerVersion(null), false);

  const server = await startMockAppServer(undefined, {
    initializeResult: { codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'macos', userAgent: 'codex_cli_rs/0.148.0 (test)' },
  });
  t.after(() => server.close());
  const client = new AppServerClient({ url: server.url });
  t.after(() => client.close());
  const initialized = await client.connect();
  assert.equal(initialized.userAgent, 'codex_cli_rs/0.148.0');
  assert.equal(client.verifiedRuntime, false, 'below the minimum line is connected but not supported');
});
