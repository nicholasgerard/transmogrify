#!/usr/bin/env node
'use strict';

/** Read-only JSON-RPC diagnostics for a loopback Codex app-server. */
const fs = require('node:fs');
const { TextDecoder } = require('node:util');
const { AppServerClient, validateTimeout, validateUrl } = require('./lib/app-server');
const { requireOwnedProviderLane } = require('./lib/state');
const { boundedCursor } = require('./lib/validation');

const MAX_PARAMS_BYTES = 64 * 1024;
const THREAD_STATUS_TYPES = new Set(['active', 'idle', 'systemError', 'notLoaded']);
const THREAD_ACTIVE_FLAGS = new Set(['waitingOnApproval', 'waitingOnUserInput']);
const SESSION_SOURCES = new Set(['cli', 'vscode', 'exec', 'appServer', 'unknown']);

const READ_ONLY_METHODS = new Set([
  'account/rateLimits/read',
  'model/list',
  'thread/items/list',
  'thread/list',
  'thread/loaded/list',
  'thread/read',
  'thread/turns/list',
]);
const OWNED_CONTENT_METHODS = new Set([
  'thread/items/list', 'thread/read', 'thread/turns/list',
]);
const HELP = `usage: rpc.js <method> [json-params|-] [options]

read-only methods:
  account/rateLimits/read, model/list, thread/items/list, thread/list,
  thread/loaded/list, thread/read, thread/turns/list

options:
  --url <loopback-ws-url>     app-server endpoint (or TRANSMOGRIFY_URL)
  --timeout <milliseconds>    bounded request timeout
  --repo-root <absolute-path> required for content-bearing thread reads

Use - to read at most ${MAX_PARAMS_BYTES} bytes of UTF-8 JSON parameters from stdin.`;

function fail(code, message, exitCode, details = {}) {
  console.error(JSON.stringify({ version: 1, ok: false, code, message, ...details }));
  process.exit(exitCode);
}

function readBoundedStdin() {
  const chunks = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(16 * 1024, MAX_PARAMS_BYTES + 1 - total));
    const count = fs.readSync(0, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_PARAMS_BYTES) throw new Error('stdin parameters exceed the byte limit');
    chunks.push(chunk.subarray(0, count));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).trim();
  } catch {
    throw new Error('stdin parameters are not valid UTF-8');
  }
}

function safeThreadStatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
  if (!THREAD_STATUS_TYPES.has(status.type)) return null;
  if (status.type !== 'active') return { type: status.type };
  if (!Array.isArray(status.activeFlags)) return null;
  const activeFlags = status.activeFlags.filter((flag) => THREAD_ACTIVE_FLAGS.has(flag));
  return activeFlags.length === status.activeFlags.length ? { type: 'active', activeFlags } : null;
}

function safeThreadSummary(thread) {
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) return null;
  const status = safeThreadStatus(thread.status);
  return {
    ...(status ? { status } : {}),
    ...(typeof thread.createdAt === 'number' ? { createdAt: thread.createdAt } : {}),
    ...(typeof thread.updatedAt === 'number' ? { updatedAt: thread.updatedAt } : {}),
    ...(SESSION_SOURCES.has(thread.source) ? { source: thread.source } : {}),
  };
}

function publicResult(method, result) {
  if (!['thread/list', 'thread/loaded/list'].includes(method)) return result;
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.data)) {
    const error = new Error('thread census response did not include data[]');
    error.code = 'PROTOCOL_ERROR';
    throw error;
  }
  let nextCursor;
  let backwardsCursor;
  try {
    nextCursor = boundedCursor(result.nextCursor, 'thread census nextCursor');
    backwardsCursor = boundedCursor(result.backwardsCursor, 'thread census backwardsCursor');
  } catch {
    const error = new Error('thread census returned an invalid cursor');
    error.code = 'PROTOCOL_ERROR';
    throw error;
  }
  return {
    data: result.data.map(safeThreadSummary).filter(Boolean),
    nextPage: nextCursor !== null,
    backwardsPage: backwardsCursor !== null,
  };
}

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log(HELP);
  process.exit(0);
}
function take(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
    fail('USAGE_ERROR', `${name} requires a value`, 3);
  }
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

const rawUrl = take('--url') || process.env.TRANSMOGRIFY_URL ||
  `ws://127.0.0.1:${process.env.TRANSMOGRIFY_PORT || '8843'}`;
const repoRoot = take('--repo-root') || process.env.REPO_ROOT;
const timeoutRaw = take('--timeout') || '20000';
let timeoutMs;
let url;
try {
  if (!/^[1-9][0-9]*$/.test(timeoutRaw)) throw new Error('timeout must be a canonical positive integer');
  timeoutMs = validateTimeout(Number(timeoutRaw));
  url = validateUrl(rawUrl);
} catch (error) {
  fail('USAGE_ERROR', 'invalid RPC URL or timeout', 3);
}

const [method, paramsRaw] = args;
if (!method || args.length > 2) {
  fail('USAGE_ERROR', 'invalid RPC invocation; run rpc.js --help', 3);
}
if (!READ_ONLY_METHODS.has(method)) {
  fail('POLICY_REFUSAL', 'method refused by read-only policy', 2);
}
let paramsInput = paramsRaw;
let params;
try {
  if (paramsRaw === '-') paramsInput = readBoundedStdin();
  params = paramsInput ? JSON.parse(paramsInput) : {};
} catch {
  fail('USAGE_ERROR', 'parameters must be bounded valid UTF-8 JSON', 3);
}

let ownedLane;
if (OWNED_CONTENT_METHODS.has(method)) {
  if (!repoRoot) {
    fail('USAGE_ERROR', '--repo-root or REPO_ROOT is required for thread content reads', 3);
  }
  try {
    ownedLane = requireOwnedProviderLane(repoRoot, 'codex-app-server', params?.threadId);
    if (ownedLane.runtime?.endpoint !== url) throw new Error('RUNTIME_MISMATCH: owned lane belongs to another runtime');
  } catch (error) {
    const code = /^NOT_OWNED:/.test(error.message) ? 'NOT_OWNED' :
      /^RUNTIME_MISMATCH:/.test(error.message) ? 'RUNTIME_MISMATCH' :
        'OWNERSHIP_CHECK_FAILED';
    fail(code, code === 'NOT_OWNED'
      ? 'thread is not owned by this operator installation'
      : 'owned thread identity could not be verified', 2);
  }
}

(async () => {
  const client = new AppServerClient({
    url,
    timeoutMs,
    clientInfo: { name: 'transmogrify-rpc', title: 'transmogrify rpc', version: '0.1.0' },
  });
  client.on('notification', ({ method: notificationMethod }) => {
    void notificationMethod;
    console.error('# notification received (method and payload redacted)');
  });
  try {
    const initialized = await client.connect();
    if (!client.verifiedRuntime) {
      const error = new Error('unverified app-server runtime');
      error.code = 'UNVERIFIED_RUNTIME';
      throw error;
    }
    if (ownedLane) {
      for (const key of ['endpoint', 'codexHome', 'platformFamily', 'platformOs']) {
        if (ownedLane.runtime?.[key] !== client.runtimeIdentity?.[key]) {
          throw new Error(`RUNTIME_MISMATCH: lane runtime identity changed (${key})`);
        }
      }
    }
    const result = await client.call(method, params);
    console.log(JSON.stringify(publicResult(method, result), null, 2));
  } catch (error) {
    if (error.rpc) {
      const rpcCode = Number.isSafeInteger(error.rpc.code) ? error.rpc.code : undefined;
      console.error(JSON.stringify({
        version: 1,
        ok: false,
        code: 'RPC_ERROR',
        message: 'app-server returned an RPC error',
        ...(rpcCode !== undefined ? { rpcCode } : {}),
      }));
      process.exitCode = 1;
    } else {
      const allowed = new Set([
        'PROTOCOL_ERROR', 'RUNTIME_MISMATCH', 'TRANSPORT_ERROR',
        'TRANSPORT_UNKNOWN', 'UNVERIFIED_RUNTIME',
      ]);
      const code = allowed.has(error.code) ? error.code : 'RPC_FAILURE';
      console.error(JSON.stringify({
        version: 1,
        ok: false,
        code,
        message: code === 'UNVERIFIED_RUNTIME'
          ? 'app-server runtime is outside the verified version line; use doctor.js for discovery'
          : 'read-only RPC request failed',
      }));
      process.exitCode = 3;
    }
  } finally {
    client.close();
  }
})();
