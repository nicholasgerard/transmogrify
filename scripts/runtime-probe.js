#!/usr/bin/env node
'use strict';

// Read-only identity and compatibility probe for a loopback Codex app-server.
// It completes the initialize handshake, prints the returned user-agent, and
// exits 3 when the handshake or the verified 0.151.x line check fails, 2 on a
// usage error, matching the exit table every Transmogrify command shares. It sends no other request and never mutates provider state.
// A failure names this installation's own reason code
// (TRANSPORT_ERROR, TRANSPORT_UNKNOWN, RUNTIME_MISMATCH,
// UNSUPPORTED_VERSION_LINE) so the operator can tell an absent listener from an
// unrecognizable one from a supported runtime on an unsupported version line.
// No remote message text is ever echoed.

const { AppServerClient, validateTimeout, validateUrl } = require('./lib/app-server');
const { VERSION } = require('./lib/version');

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error('usage: runtime-probe.js [--url ws://127.0.0.1:8843] [--timeout-ms ms]');
  process.exit(2);
}

function help() {
  console.log('usage: runtime-probe.js [--url ws://127.0.0.1:8843] [--timeout-ms ms]');
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
      // `initialized.userAgent` is the canonicalized value: it already matched a
      // bounded, control-free pattern, so printing it echoes no untrusted text.
      console.error(`runtime probe failed: UNSUPPORTED_VERSION_LINE (${initialized.userAgent}); verified line is 0.151.x`);
      process.exitCode = 3;
      return;
    }
    console.log(`Codex app-server protocol verified: ${initialized.userAgent}`);
  } catch (error) {
    // Only this installation's own error code reaches the operator; remote
    // message text is never echoed. The code distinguishes a listener that is
    // absent or unreachable from one that answered with something that is not a
    // recognizable Codex app-server, which are different repairs.
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z_]{1,39}$/.test(error.code)
      ? error.code
      : 'PROBE_FAILED';
    console.error(`runtime probe failed: ${code}`);
    if (code === 'RUNTIME_MISMATCH') {
      console.error('the listener did not return a recognizable Codex app-server initialize response');
    }
    process.exitCode = 3;
  } finally {
    client.close();
  }
})();
