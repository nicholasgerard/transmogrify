'use strict';

const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const { WebSocketServer } = require('ws');

const NO_RESPONSE = Symbol('NO_RESPONSE');

function defaultHandler(request) {
  if (request.method === 'thread/list' || request.method === 'thread/turns/list') {
    return { result: { data: [], nextCursor: null } };
  }
  return { result: {} };
}

async function startMockAppServer(handler = defaultHandler, options = {}) {
  const transportServer = options.socketPath ? http.createServer() : null;
  const server = transportServer
    ? new WebSocketServer({ server: transportServer })
    : new WebSocketServer({ host: '127.0.0.1', port: 0 });
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

  if (transportServer) {
    try { fs.unlinkSync(options.socketPath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    transportServer.listen(options.socketPath);
    await once(transportServer, 'listening');
  } else {
    await once(server, 'listening');
  }
  const address = transportServer ? options.socketPath : server.address();

  return {
    requests,
    handshakes: server.handshakes,
    url: transportServer ? `ws+unix:${address}` : `ws://127.0.0.1:${address.port}`,
    async close() {
      for (const client of server.clients) client.terminate();
      server.close();
      await once(server, 'close');
      if (transportServer) {
        transportServer.close();
        await once(transportServer, 'close');
        try { fs.unlinkSync(options.socketPath); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    },
  };
}

module.exports = { NO_RESPONSE, startMockAppServer };
