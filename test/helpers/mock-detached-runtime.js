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

// Mirrors the measured app-server behavior: the leading originator token of the
// reported user-agent is not the server's own identity. It is fixed by the first
// client that completes `initialize`, unless the process was started with
// CODEX_INTERNAL_ORIGINATOR_OVERRIDE, and it stays fixed for the process
// lifetime. Verified 2026-09-03 against codex_cli_rs 0.151.0 on macOS 15.6.0
// arm64. A launcher that does not pin the override is therefore identified by
// its own probe and cannot verify the runtime it just started.
const originatorOverride = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
let originator = null;

server.on('connection', (socket) => {
  socket.on('message', (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.id === undefined) return;
    if (request.method === 'initialize' && !originator) {
      originator = originatorOverride || request.params?.clientInfo?.name || 'unknown';
    }
    socket.send(JSON.stringify({
      id: request.id,
      result: request.method === 'initialize' ? {
        codexHome: '/tmp/mock-codex-home',
        platformFamily: 'unix',
        platformOs: 'test',
        userAgent: `${originator}/0.151.0 (runtime launcher test)`,
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
