#!/usr/bin/env node
'use strict';

// A loopback TCP relay for the managed app-server daemon's unix socket.
// Its one durable record binds pid plus process birth, so start and stop never
// claim or signal an unrelated listener. The relay forwards bytes only; the
// app-server WebSocket handshake and protocol remain end to end.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sleep } = require('./async');
const {
  atomicWriteJson, processBirth, processMatches, stateRoot,
} = require('./state');
const { inspectListeners } = require('./listeners');
const { AppServerClient, validateUrl } = require('./app-server');

const DEFAULT_RELAY_HOST = '127.0.0.1';
const DEFAULT_RELAY_PORT = 8844;
const MAX_LOG_BYTES = 1024 * 1024;
const RECORD_VERSION = 1;

class RelayError extends Error {
  constructor(message, code = 'RUNTIME_LAUNCH_FAILED') {
    super(message);
    this.code = code;
  }
}

function validateHost(host) {
  if (!['127.0.0.1', '::1'].includes(host)) {
    throw new RelayError('refusing non-loopback relay bind', 'USAGE_ERROR');
  }
  return host;
}

function validatePort(value) {
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new RelayError('relay port must be a canonical integer from 1 to 65535', 'USAGE_ERROR');
  }
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new RelayError('relay port must be a canonical integer from 1 to 65535', 'USAGE_ERROR');
  }
  return port;
}

function validateSocketPath(socketPath) {
  const endpoint = validateUrl(`ws+unix:${socketPath}`);
  return endpoint.slice('ws+unix:'.length);
}

function relayUrl(host, port) {
  return `ws://${host === '::1' ? '[::1]' : host}:${port}/`;
}

function relayPaths(env = process.env) {
  const root = path.join(stateRoot(env), 'runtime-relay');
  return {
    root,
    record: path.join(root, 'relay.json'),
    log: path.join(root, 'relay.log'),
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new RelayError('relay record is missing or corrupt');
  }
}

function validRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const keys = Object.keys(record).sort();
  const expected = [
    'host', 'pid', 'port', 'processBirth', 'socketPath', 'startedAt', 'url', 'version',
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  try {
    return record.version === RECORD_VERSION && Number.isInteger(record.pid) && record.pid > 0 &&
      typeof record.processBirth === 'string' && Boolean(record.processBirth) &&
      validateHost(record.host) === record.host && validatePort(record.port) === record.port &&
      validateSocketPath(record.socketPath) === record.socketPath &&
      relayUrl(record.host, record.port) === record.url &&
      !Number.isNaN(Date.parse(record.startedAt));
  } catch {
    return false;
  }
}

function readRelayRecord(env = process.env) {
  const record = readJson(relayPaths(env).record);
  if (!record) return null;
  if (!validRecord(record)) throw new RelayError('relay record has an invalid shape');
  return record;
}

function runningRelay(env = process.env, dependencies = {}) {
  const record = readRelayRecord(env);
  const matches = dependencies.processMatches || processMatches;
  return record && matches(record, dependencies) ? record : null;
}

function activeRelayUrl(env = process.env, dependencies = {}) {
  return runningRelay(env, dependencies)?.url || null;
}

function writeRelayRecord(record, env = process.env) {
  if (!validRecord(record)) throw new RelayError('refusing to write an invalid relay record');
  atomicWriteJson(relayPaths(env).record, record);
  return record;
}

function appendLog(message, env = process.env) {
  const paths = relayPaths(env);
  try {
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    if (fs.existsSync(paths.log) && fs.statSync(paths.log).size > MAX_LOG_BYTES) {
      fs.renameSync(paths.log, `${paths.log}.1`);
    }
    fs.appendFileSync(paths.log, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {
    // Relay availability does not depend on diagnostics being writable.
  }
}

function sanitizedRelayEnv(env = process.env) {
  const clean = {};
  for (const key of [
    'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'PATH', 'TMP', 'TMPDIR',
    'TEMP', 'USER', 'XDG_STATE_HOME', 'TRANSMOGRIFY_STATE_DIR',
  ]) {
    if (typeof env[key] === 'string' && !env[key].includes('\0')) clean[key] = env[key];
  }
  return clean;
}

async function runtimeIdentity(url, dependencies = {}) {
  const createClient = dependencies.clientFactory || ((options) => new AppServerClient(options));
  const client = createClient({ url, timeoutMs: 3000 });
  try {
    const initialized = await client.connect();
    if (!client.verifiedRuntime) return null;
    return initialized;
  } catch {
    return null;
  } finally {
    client.close();
  }
}

async function sameRuntimeThroughRelay(socketPath, url, dependencies = {}) {
  const direct = await runtimeIdentity(`ws+unix:${socketPath}`, dependencies);
  const relayed = direct ? await runtimeIdentity(url, dependencies) : null;
  if (!direct || !relayed) return false;
  return ['codexHome', 'platformFamily', 'platformOs', 'userAgent']
    .every((key) => direct[key] === relayed[key]);
}

async function ensureRelay(options, env = process.env, dependencies = {}) {
  const host = validateHost(options.host || DEFAULT_RELAY_HOST);
  const port = validatePort(options.port ?? env.TRANSMOGRIFY_RELAY_PORT ?? DEFAULT_RELAY_PORT);
  const socketPath = validateSocketPath(options.socketPath);
  const current = runningRelay(env, dependencies);
  if (current) {
    if (current.host !== host || current.port !== port || current.socketPath !== socketPath) {
      throw new RelayError('a recorded relay is running with different settings');
    }
    return { state: 'reused', ...current };
  }

  const inspect = dependencies.inspectListeners || ((candidatePort) => inspectListeners(candidatePort, dependencies));
  const listeners = await inspect(port);
  if (listeners.length > 0) {
    const pids = [...new Set(listeners.map((listener) => listener.pid))];
    const probePair = dependencies.sameRuntimeThroughRelay || sameRuntimeThroughRelay;
    const url = relayUrl(host, port);
    const birth = pids.length === 1 &&
      await probePair(socketPath, url, dependencies) &&
      (dependencies.processBirth || processBirth)(pids[0]);
    if (!birth) throw new RelayError(`relay port :${port} is occupied by an unowned listener`);
    const observed = {
      version: RECORD_VERSION,
      pid: pids[0],
      processBirth: birth,
      host,
      port,
      url,
      socketPath,
      startedAt: new Date().toISOString(),
    };
    writeRelayRecord(observed, env);
    appendLog(`recorded existing verified relay on ${url}`, env);
    return { state: 'reused', ...observed };
  }

  const launch = dependencies.spawnDetached || ((executable, args) => {
    const child = spawn(executable, args, {
      detached: true,
      env: sanitizedRelayEnv(env),
      stdio: 'ignore',
    });
    child.unref();
    return child.pid;
  });
  const args = [
    __filename, '--serve', '--host', host, '--port', String(port), '--socket', socketPath,
  ];
  const pid = launch(process.execPath, args);
  if (!Number.isInteger(pid) || pid < 1) throw new RelayError('relay spawn returned an invalid pid');

  const wait = dependencies.sleep || sleep;
  const attempts = options.attempts ?? 40;
  const pollMs = options.pollMs ?? 100;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const record = runningRelay(env, dependencies);
    if (record && record.pid === pid && record.host === host && record.port === port &&
        record.socketPath === socketPath) {
      return { state: 'started', ...record };
    }
    await wait(pollMs);
  }
  throw new RelayError('relay did not publish a live pid-and-birth record');
}

async function stopRelay(env = process.env, dependencies = {}) {
  const record = runningRelay(env, dependencies);
  const paths = relayPaths(env);
  if (!record) return { stopped: false, pid: null };
  const signal = dependencies.kill || process.kill.bind(process);
  signal(record.pid, 'SIGTERM');
  const wait = dependencies.sleep || sleep;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!runningRelay(env, dependencies)) {
      try { fs.unlinkSync(paths.record); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return { stopped: true, pid: record.pid };
    }
    await wait(100);
  }
  throw new RelayError('recorded relay did not stop after SIGTERM');
}

async function serveRelay(options, env = process.env, dependencies = {}) {
  const host = validateHost(options.host);
  const port = validatePort(options.port);
  const socketPath = validateSocketPath(options.socketPath);
  const birth = (dependencies.processBirth || processBirth)(process.pid);
  if (!birth) throw new RelayError('cannot establish the relay process birth');
  const record = {
    version: RECORD_VERSION,
    pid: process.pid,
    processBirth: birth,
    host,
    port,
    url: relayUrl(host, port),
    socketPath,
    startedAt: new Date().toISOString(),
  };
  const createServer = dependencies.createServer || net.createServer;
  const connect = dependencies.connect || net.createConnection;
  const server = createServer((client) => {
    const upstream = connect({ path: socketPath });
    client.pipe(upstream);
    upstream.pipe(client);
    const closePair = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', closePair);
    upstream.on('error', (error) => {
      appendLog(`upstream connection failed: ${error.code || 'unknown'}`, env);
      closePair();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  writeRelayRecord(record, env);
  appendLog(`relay listening on ${record.url}`, env);

  const shutdown = () => server.close();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await new Promise((resolve, reject) => {
    server.once('close', resolve);
    server.once('error', reject);
  });
  const latest = readRelayRecord(env);
  if (latest?.pid === record.pid && latest.processBirth === record.processBirth) {
    try { fs.unlinkSync(relayPaths(env).record); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  appendLog('relay stopped', env);
}

function parseCli(argv) {
  const values = {};
  let mode = null;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (['--serve', '--ensure', '--stop', '--status'].includes(option)) {
      if (mode) throw new RelayError('choose exactly one relay operation', 'USAGE_ERROR');
      mode = option.slice(2);
      continue;
    }
    if (!['--host', '--port', '--socket'].includes(option) || index + 1 >= argv.length) {
      throw new RelayError('usage: relay.js --ensure|--serve --socket <absolute> [--host 127.0.0.1] [--port 8844]', 'USAGE_ERROR');
    }
    values[option.slice(2)] = argv[index + 1];
    index += 1;
  }
  if (!mode) throw new RelayError('a relay operation is required', 'USAGE_ERROR');
  if (['ensure', 'serve'].includes(mode) && !values.socket) {
    throw new RelayError('--socket is required', 'USAGE_ERROR');
  }
  return { mode, ...values };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseCli(argv);
  let result;
  if (options.mode === 'serve') await serveRelay({ host: options.host, port: options.port, socketPath: options.socket }, env);
  else if (options.mode === 'ensure') result = await ensureRelay({ host: options.host, port: options.port, socketPath: options.socket }, env);
  else if (options.mode === 'stop') result = await stopRelay(env);
  else result = { running: Boolean(runningRelay(env)), relay: runningRelay(env) };
  if (result) console.log(JSON.stringify(result));
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = error.code === 'USAGE_ERROR' ? 2 : 3;
  });
}

module.exports = {
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  RelayError,
  activeRelayUrl,
  appendLog,
  ensureRelay,
  readRelayRecord,
  relayPaths,
  relayUrl,
  runningRelay,
  sameRuntimeThroughRelay,
  sanitizedRelayEnv,
  serveRelay,
  stopRelay,
  validateHost,
  validatePort,
  validateSocketPath,
  writeRelayRecord,
};
