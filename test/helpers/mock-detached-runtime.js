#!/usr/bin/env node
'use strict';

const { WebSocketServer } = require('ws');

const index = process.argv.indexOf('--listen');
if (index === -1 || !process.argv[index + 1]) process.exit(2);
const endpoint = new URL(process.argv[index + 1]);
const server = new WebSocketServer({
  host: endpoint.hostname.replace(/^\[(.*)\]$/, '$1'),
  port: Number(endpoint.port),
});

server.on('connection', (socket) => {
  socket.on('message', (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.id === undefined) return;
    socket.send(JSON.stringify({
      id: request.id,
      result: request.method === 'initialize' ? {
        codexHome: '/tmp/mock-codex-home',
        platformFamily: 'unix',
        platformOs: 'test',
        userAgent: 'codex_cli_rs/0.151.0 (runtime launcher test)',
      } : {},
    }));
  });
});

function close() {
  for (const client of server.clients) client.terminate();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', close);
process.on('SIGINT', close);
