'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { WebSocketServer } = require('ws');
const { once } = require('node:events');
const { startMockAppServer } = require('./helpers/mock-app-server');
const { runNodeScript } = require('./helpers/run-cli');

test('runtime probe exposes a no-side-effect help path', async () => {
  const result = await runNodeScript('scripts/runtime-probe.js', ['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /usage: runtime-probe\.js/);
  assert.equal(result.stderr, '');
});

test('runtime probe positively identifies a Codex app-server handshake', async (t) => {
  const server = await startMockAppServer();
  t.after(() => server.close());

  const result = await runNodeScript('scripts/runtime-probe.js', ['--url', server.url]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /codex_cli_rs\/0\.151\.0/);
});

test('runtime probe rejects a listener with a non-Codex handshake', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.id !== undefined) {
        socket.send(JSON.stringify({
          id: request.id,
          result: { userAgent: 'different-service/1.0' },
        }));
      }
    });
  });
  await once(server, 'listening');
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    server.close();
    await once(server, 'close');
  });

  const { port } = server.address();
  const result = await runNodeScript('scripts/runtime-probe.js', [
    '--url', `ws://127.0.0.1:${port}`,
  ]);
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stderr, /handshake or compatibility verification failed/i);
});

test('runtime probe never echoes provider-supplied initialize errors', async (t) => {
  const secret = 'SECRET_INITIALIZE_PAYLOAD';
  const server = await startMockAppServer(undefined, {
    initializeResponse: { error: { code: -32000, message: secret } },
  });
  t.after(() => server.close());
  const result = await runNodeScript('scripts/runtime-probe.js', ['--url', server.url]);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /handshake or compatibility verification failed/);
  assert.equal(result.stderr.includes(secret), false);
});
