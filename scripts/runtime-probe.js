#!/usr/bin/env node
'use strict';

/** Read-only identity and compatibility probe for a loopback Codex app-server. */
const { AppServerClient, validateTimeout, validateUrl } = require('./lib/app-server');

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error('usage: runtime-probe.js [--url ws://127.0.0.1:8843] [--timeout ms]');
  process.exit(2);
}

function help() {
  console.log('usage: runtime-probe.js [--url ws://127.0.0.1:8843] [--timeout ms]');
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
  if (arg !== '--url' && arg !== '--timeout') usage(`unknown option ${arg}`);
  if (index + 1 >= args.length || args[index + 1].startsWith('--')) usage(`${arg} requires a value`);
  if (arg === '--url') rawUrl = args[index + 1];
  else timeoutRaw = args[index + 1];
  index += 1;
}
let url;
let timeoutMs;
try {
  if (!/^[1-9][0-9]*$/.test(timeoutRaw)) throw new Error('--timeout must be a canonical positive integer');
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
      version: '0.1.0',
    },
  });
  try {
    const initialized = await client.connect();
    if (!client.verifiedRuntime) {
      throw new Error(`unsupported Codex app-server ${initialized.userAgent}; verified line is 0.151.x`);
    }
    console.log(`Codex app-server verified: ${initialized.userAgent}`);
  } catch (error) {
    void error;
    console.error('runtime probe failed: app-server handshake or compatibility verification failed');
    process.exitCode = 1;
  } finally {
    client.close();
  }
})();
