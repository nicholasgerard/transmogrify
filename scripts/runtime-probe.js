#!/usr/bin/env node
'use strict';

// Read-only identity and compatibility probe for a loopback Codex app-server.
// It completes the initialize handshake, prints the returned user-agent, and
// exits 3 when the handshake or the supported-version check (0.151.0 or newer) fails, 2 on a
// usage error, matching the exit table every Transmogrify command shares. It sends no other request and never mutates provider state.

const { AppServerClient, validateTimeout, validateUrl } = require('./lib/app-server');
const { VERSION } = require('./lib/version');

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error('usage: runtime-probe.js [--url <loopback-ws-or-ws+unix-endpoint>] [--timeout-ms ms]');
  process.exit(2);
}

function help() {
  console.log('usage: runtime-probe.js [--url <loopback-ws-or-ws+unix-endpoint>] [--timeout-ms ms]');
  process.exit(0);
}

const args = process.argv.slice(2);
let rawUrl = process.env.TRANSMOGRIFY_URL ||
  `ws://127.0.0.1:${process.env.TRANSMOGRIFY_PORT || '8843'}`;
let timeoutRaw = '3000';
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--help' || arg === '-h') {
    if (args.length !== 1) usage(`${arg} cannot be combined with other options`);
    help();
  }
  if (arg !== '--url' && arg !== '--timeout-ms') usage(`unknown option ${arg}`);
  if (index + 1 >= args.length || args[index + 1].startsWith('--')) usage(`${arg} requires a value`);
  if (arg === '--url') rawUrl = args[index + 1];
  else timeoutRaw = args[index + 1];
  index += 1;
}
let url;
let timeoutMs;
try {
  if (!/^[1-9][0-9]*$/.test(timeoutRaw)) throw new Error('--timeout-ms must be a canonical positive integer');
  timeoutMs = validateTimeout(Number(timeoutRaw));
  url = validateUrl(rawUrl);
} catch (error) {
  usage(error.message);
}

(async () => {
  const client = new AppServerClient({
    url,
    timeoutMs,
    clientInfo: {
      name: 'transmogrify-runtime-probe',
      title: 'transmogrify runtime probe',
      version: VERSION,
    },
  });
  try {
    const initialized = await client.connect();
    if (!client.verifiedRuntime) {
      throw new Error(`unsupported Codex app-server ${initialized.userAgent}; supported line is 0.151.0 or newer`);
    }
    console.log(`Codex app-server protocol verified: ${initialized.userAgent}`);
  } catch (error) {
    // The caught error is discarded and the message is fixed, so an untrusted
    // listener cannot echo remote text into operator output.
    void error;
    console.error('runtime probe failed: app-server handshake or compatibility verification failed');
    process.exitCode = 3;
  } finally {
    client.close();
  }
})();
