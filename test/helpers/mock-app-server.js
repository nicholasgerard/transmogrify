'use strict';

const { once } = require('node:events');
const { WebSocketServer } = require('ws');

const NO_RESPONSE = Symbol('NO_RESPONSE');

async function startMockAppServer(handler = () => ({ result: {} }), options = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const requests = [];

  server.handshakes = [];
  server.on('connection', (socket, request) => {
    server.handshakes.push({ headers: { ...(request?.headers || {}) } });
    socket.on('message', async (raw) => {
      const request = JSON.parse(raw.toString());
      requests.push(request);
      if (request.id === undefined) return;

      let response;
      if (request.method === 'initialize') {
        response = options.initializeResponse || {
          result: options.initializeResult || {
            codexHome: '/tmp/codex-home',
            platformFamily: 'unix',
            platformOs: 'test',
            userAgent: 'codex_cli_rs/0.151.0 (test)',
          },
        };
      } else {
        response = await handler(request, socket, requests);
      }

      if (response === NO_RESPONSE) return;
      socket.send(JSON.stringify({ id: request.id, ...(response || { result: {} }) }));
    });
  });

  await once(server, 'listening');
  const address = server.address();

  return {
    requests,
    handshakes: server.handshakes,
    url: `ws://127.0.0.1:${address.port}`,
    async close() {
      for (const client of server.clients) client.terminate();
      server.close();
      await once(server, 'close');
    },
  };
}

module.exports = { NO_RESPONSE, startMockAppServer };
