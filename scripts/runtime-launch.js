#!/usr/bin/env node
'use strict';

// Codex app-server runtime launcher. It reuses a verified loopback-only listener
// when one exists and otherwise starts a detached child with a sanitized
// environment and a private append-only log. The only process it may signal is a
// child it launched itself, identified by pid plus measured process birth: it
// never terminates a listener it merely observed, and it never falls back to a
// PID-only SIGKILL.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { processBirth } = require('./lib/state');
const { supportedAppServerVersion, validateUrl } = require('./lib/app-server');
const { DEFAULT_RELAY_PORT, ensureRelay } = require('./lib/relay');
const { exitCodeForError } = require('./lib/public-error');
const {
  ListenerError, execFileResult, inspectListeners, normalizeListenUrl, parseLsofListeners,
} = require('./lib/listeners');
const { sleep: delay } = require('./lib/async');

// Launch polling bounds and the allowlisted environment a detached runtime
// inherits. Nothing outside that set crosses into the child.
const DEFAULT_ATTEMPTS = 40;
const DEFAULT_POLL_MS = 250;
const PROBE_TIMEOUT_MS = 1500;
const MAX_CAPTURE_BYTES = 64 * 1024;
const CHILD_HANDLE = Symbol('transmogrifyRuntimeChild');
const RUNTIME_ENV_KEYS = new Set([
  'CODEX_HOME',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TMP',
  'TMPDIR',
  'TEMP',
  'USER',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
]);

// Launcher failure. USAGE_ERROR exits 2; every other code exits 1.
class RuntimeLaunchError extends Error {
  constructor(message, code = 'RUNTIME_LAUNCH_FAILED') {
    super(message);
    this.code = code;
  }
}

function commandResult(executable, args, options = {}) {
  return new Promise((resolve) => {
    execFile(executable, args, {
      encoding: 'utf8',
      env: options.env,
      maxBuffer: MAX_CAPTURE_BYTES,
      timeout: options.timeoutMs || 5000,
    }, (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === 'number' ? error.code : (error ? 1 : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

function managedDaemonPaths(env = process.env) {
  const codexHome = env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
  if (!path.isAbsolute(codexHome) || path.normalize(codexHome) !== codexHome) {
    throw new RuntimeLaunchError('CODEX_HOME must be a normalized absolute path', 'USAGE_ERROR');
  }
  return {
    codexHome,
    bin: path.join(codexHome, 'packages', 'standalone', 'current', 'codex'),
    socketPath: path.join(codexHome, 'app-server-control', 'app-server-control.sock'),
  };
}

function managedBinary(paths, dependencies = {}) {
  const exists = dependencies.existsSync || fs.existsSync;
  if (!exists(paths.bin)) return null;
  try {
    const binary = (dependencies.realpathSync || fs.realpathSync)(paths.bin);
    (dependencies.accessSync || fs.accessSync)(binary, fs.constants.X_OK);
    return binary;
  } catch {
    return null;
  }
}

function daemonVersion(result) {
  if (!result || result.code !== 0) return null;
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { return null; }
  const version = parsed?.appServerVersion;
  if (typeof version !== 'string' ||
      !supportedAppServerVersion(`managed-daemon/${version}`)) return null;
  return version;
}

// Prefer the installer-managed daemon. A present control socket whose version
// cannot be read is never started over: it may be a live daemon hidden by the
// current sandbox. Only an absent socket permits `daemon start`.
async function ensureManagedDaemon(options, dependencies = {}) {
  const env = dependencies.env || process.env;
  const paths = options.managedPaths || managedDaemonPaths(env);
  const binary = managedBinary(paths, dependencies);
  if (!binary) return { available: false, reason: 'managed-install-missing' };
  const run = dependencies.commandResult || commandResult;
  const versionArgs = ['app-server', 'daemon', 'version'];
  let versionResult = await run(binary, versionArgs, { env, timeoutMs: 5000 });
  let version = daemonVersion(versionResult);
  let state = 'reused';
  if (!version) {
    const exists = dependencies.existsSync || fs.existsSync;
    if (exists(paths.socketPath)) {
      return { available: false, reason: 'managed-daemon-unreachable' };
    }
    const started = await run(binary, ['app-server', 'daemon', 'start'], { env, timeoutMs: 15000 });
    if (started.code !== 0) return { available: false, reason: 'managed-daemon-start-failed' };
    state = 'started';
    versionResult = await run(binary, versionArgs, { env, timeoutMs: 5000 });
    version = daemonVersion(versionResult);
    if (!version) return { available: false, reason: 'managed-daemon-version-unavailable' };
  }
  const socketUrl = validateUrl(`ws+unix:${paths.socketPath}`);
  const probe = dependencies.probeRuntime || ((url) => probeRuntime(options.probe, url, dependencies));
  if (!await probe(socketUrl)) return { available: false, reason: 'managed-daemon-probe-failed' };
  return {
    available: true,
    state,
    version,
    bin: binary,
    socketPath: paths.socketPath,
    socketUrl,
  };
}

async function ensurePreferredRuntime(options, dependencies = {}) {
  const env = dependencies.env || process.env;
  const daemon = await (dependencies.ensureManagedDaemon || ensureManagedDaemon)(options, dependencies);
  if (daemon.available) {
    const relay = await (dependencies.ensureRelay || ensureRelay)({
      socketPath: daemon.socketPath,
      port: options.relayPort ?? env.TRANSMOGRIFY_RELAY_PORT ?? DEFAULT_RELAY_PORT,
    }, env, dependencies.relayDependencies || dependencies);
    return {
      runtime: 'managed-daemon',
      state: daemon.state,
      url: relay.url,
      socket: daemon.socketPath,
      daemonVersion: daemon.version,
      relayState: relay.state,
    };
  }
  const standalone = await (dependencies.ensureStandalone || ensureRuntime)({
    url: options.url,
    probe: options.probe,
    bin: options.bin,
    log: options.log,
  }, dependencies);
  return {
    runtime: 'standalone-fallback',
    state: standalone.state,
    url: standalone.clientUrl,
    fallbackReason: daemon.reason,
  };
}

// Run the read-only probe against the endpoint. True only when it completed a
// verified Codex app-server handshake.
async function probeRuntime(probePath, clientUrl, dependencies = {}) {
  const run = dependencies.execFileResult || execFileResult;
  const result = await run(process.execPath, [
    probePath, '--url', clientUrl, '--timeout-ms', String(PROBE_TIMEOUT_MS),
  ], { timeoutMs: PROBE_TIMEOUT_MS + 1500, env: dependencies.env || process.env });
  return result.code === 0;
}

// True when a recorded pid is live and its measured birth still matches, so a
// recycled pid can never be mistaken for the launched runtime.
function processMatches(record, birth = processBirth) {
  if (!record || !Number.isInteger(record.pid) || record.pid < 1 || !record.processBirth) return false;
  try { process.kill(record.pid, 0); } catch { return false; }
  return birth(record.pid) === record.processBirth;
}


// The only environment a detached runtime inherits: allowlisted variables with
// NUL-bearing values dropped.
function sanitizedRuntimeEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (!RUNTIME_ENV_KEYS.has(key) || typeof value !== 'string' || value.includes('\0')) continue;
    clean[key] = value;
  }
  return clean;
}

// Create the log directory 0700 after proving the path is normalized, absolute,
// symlink-free, and rooted in an owner-controlled ancestor.
function prepareRuntimeLogDirectory(directory) {
  if (path.resolve(directory) !== directory) {
    throw new RuntimeLaunchError('runtime log path must be normalized and absolute', 'USAGE_ERROR');
  }
  let ancestor = directory;
  const missing = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const canonical = path.join(fs.realpathSync(ancestor), ...missing);
  if (canonical !== directory) {
    throw new RuntimeLaunchError('runtime log path must not traverse symlinks');
  }
  const ancestorStat = fs.lstatSync(ancestor);
  if (!ancestorStat.isDirectory() || ancestorStat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && ancestorStat.uid !== process.getuid()) ||
      (ancestorStat.mode & 0o022) !== 0) {
    throw new RuntimeLaunchError('runtime log directory is not owner-controlled');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

// Open the runtime log append-only at 0600 through O_NOFOLLOW and re-stat the
// descriptor, so the child's output can never be redirected through a symlink
// into another file.
function openRuntimeLog(logPath) {
  if (!path.isAbsolute(logPath)) {
    throw new RuntimeLaunchError('runtime log path must be absolute', 'USAGE_ERROR');
  }
  const directory = path.dirname(logPath);
  prepareRuntimeLogDirectory(directory);
  if (fs.realpathSync(directory) !== directory) {
    throw new RuntimeLaunchError('runtime log path must not traverse symlinks');
  }
  const directoryLinkStat = fs.lstatSync(directory);
  const directoryStat = fs.statSync(directory);
  if (directoryLinkStat.isSymbolicLink() || !directoryStat.isDirectory() ||
      (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) ||
      (directoryStat.mode & 0o022) !== 0) {
    throw new RuntimeLaunchError('runtime log directory is not owner-controlled');
  }
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) {
    throw new RuntimeLaunchError('this platform cannot safely open the runtime log');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      logPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | noFollow,
      0o600,
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        (stat.mode & 0o077) !== 0) {
      throw new RuntimeLaunchError('runtime log file is not a private owner-controlled file');
    }
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error instanceof RuntimeLaunchError || error instanceof ListenerError) throw error;
    throw new RuntimeLaunchError('runtime log file could not be opened safely');
  }
}

// Start the runtime detached with the sanitized environment and the log as its
// only output. It returns only once a stable pid and process birth are measured;
// without that identity the child is terminated and the launch fails, because
// nothing later would be permitted to signal it.
async function spawnRuntime(options, dependencies = {}) {
  const spawnProcess = dependencies.spawn || spawn;
  const birth = dependencies.processBirth || processBirth;
  const binary = fs.realpathSync(options.bin);
  fs.accessSync(binary, fs.constants.X_OK);
  const logFd = openRuntimeLog(options.log);
  let child;
  try {
    child = spawnProcess(binary, [
      '-c', 'mcp_servers.codex_app={command="",enabled=false}',
      'app-server', '--listen', options.listenUrl,
    ], {
      detached: true,
      env: sanitizedRuntimeEnv(dependencies.env || process.env),
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  let observedBirth = null;
  for (let attempt = 0; attempt < 20 && child.exitCode === null; attempt += 1) {
    observedBirth = birth(child.pid);
    if (observedBirth) break;
    await delay(10);
  }
  if (!observedBirth) {
    // The ChildProcess handle is an immediate creation receipt. Use it only in
    // this pre-return failure path; durable cleanup below requires pid + birth.
    if (child.exitCode === null) child.kill('SIGTERM');
    throw new RuntimeLaunchError('cannot establish stable identity for the launched runtime');
  }
  child.unref();
  const receipt = { pid: child.pid, processBirth: observedBirth };
  Object.defineProperty(receipt, CHILD_HANDLE, { value: child, enumerable: false });
  return receipt;
}

// Terminate only a process this launcher started, proven by pid and measured
// birth and normally by the retained child handle. It sends SIGTERM once and, if
// the process survives, refuses a PID-only SIGKILL and raises instead.
async function terminateOwnedProcess(record, dependencies = {}) {
  const birth = dependencies.processBirth || processBirth;
  const matches = dependencies.processMatches || ((candidate) => processMatches(candidate, birth));
  const signal = dependencies.kill || process.kill.bind(process);
  const wait = dependencies.delay || delay;
  const child = record?.[CHILD_HANDLE];
  if (!child && dependencies.allowPidOnly !== true) {
    return { attempted: false, terminated: false };
  }
  if (!matches(record)) return { attempted: false, terminated: false };
  if (child && (child.pid !== record.pid || child.exitCode !== null)) {
    return { attempted: false, terminated: child.exitCode !== null };
  }
  if (child) child.kill('SIGTERM');
  else signal(record.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(50);
    if ((child && child.exitCode !== null) || !matches(record)) {
      return { attempted: true, terminated: true };
    }
  }
  throw new RuntimeLaunchError(
    'exact launched process did not terminate after SIGTERM; refusing PID-only SIGKILL',
  );
}

function listenerPids(listeners) {
  return new Set(listeners.map((listener) => listener.pid));
}

// Reuse a verified loopback runtime, or launch one and wait for its verified
// handshake. When another listener wins the bind race only this launcher's own
// child is removed, and the surviving listener is re-probed before reuse is
// declared. Every failure path terminates the owned child first.
async function ensureRuntime(options, dependencies = {}) {
  const normalized = normalizeListenUrl(options.url);
  const inspect = dependencies.inspectListeners || ((port) => inspectListeners(port, dependencies));
  const probe = dependencies.probeRuntime || ((url) => probeRuntime(options.probe, url, dependencies));
  const spawnOwned = dependencies.spawnRuntime || ((spawnOptions) => spawnRuntime(spawnOptions, dependencies));
  const terminate = dependencies.terminateOwnedProcess ||
    ((record) => terminateOwnedProcess(record, dependencies));
  const matches = dependencies.processMatches || ((record) => processMatches(
    record, dependencies.processBirth || processBirth,
  ));
  const wait = dependencies.delay || delay;
  const attempts = options.attempts || DEFAULT_ATTEMPTS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  const existing = await inspect(normalized.port);
  if (existing.length > 0) {
    if (!await probe(normalized.clientUrl)) {
      throw new RuntimeLaunchError(
        `port :${normalized.port} is occupied but did not complete a verified Codex app-server handshake`,
      );
    }
    return { state: 'reused', ...normalized, pids: [...listenerPids(existing)] };
  }

  if (!options.bin) throw new RuntimeLaunchError('codex binary was not found (set TRANSMOGRIFY_BIN)');
  if (options.log !== undefined && !path.isAbsolute(options.log)) {
    throw new RuntimeLaunchError('runtime log path must be absolute', 'USAGE_ERROR');
  }
  const log = options.log || path.join(
    process.env.HOME || os.homedir(), '.codex', 'log', `app-server-${normalized.port}.log`,
  );
  const owned = await spawnOwned({
    bin: options.bin,
    listenUrl: normalized.listenUrl,
    log,
  });

  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const listeners = await inspect(normalized.port);
      if (listeners.length > 0 && await probe(normalized.clientUrl)) {
        const pids = listenerPids(listeners);
        if (pids.size === 1 && pids.has(owned.pid) && matches(owned)) {
          return { state: 'launched', ...normalized, pid: owned.pid, log };
        }

        // A verified listener won the bind race, or the listener set is
        // ambiguous. Remove only our pid+birth-bound child, then revalidate the
        // remaining listener before declaring reuse.
        await terminate(owned);
        const remaining = await inspect(normalized.port);
        if (remaining.length > 0 && !listenerPids(remaining).has(owned.pid) &&
            await probe(normalized.clientUrl)) {
          return { state: 'race-reused', ...normalized, pids: [...listenerPids(remaining)] };
        }
        throw new RuntimeLaunchError('runtime listener identity changed during launch-race reconciliation');
      }
      if (!matches(owned)) {
        throw new RuntimeLaunchError('launched runtime exited before completing a verified handshake');
      }
      await wait(pollMs);
    }
    throw new RuntimeLaunchError(
      `runtime failed to complete a verified handshake on :${normalized.port} within ${attempts * pollMs}ms`,
    );
  } catch (error) {
    await terminate(owned);
    throw error;
  }
}

// Strict option parsing: only the four known flags, each with a value.
function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--url', '--bin', '--log', '--probe'].includes(option) || index + 1 >= argv.length) {
      throw new RuntimeLaunchError(
        'usage: runtime-launch.js --url <loopback-ws-url> --probe <runtime-probe.js> [--bin <codex>] [--log <file>]',
        'USAGE_ERROR',
      );
    }
    values[option.slice(2)] = argv[index + 1];
    index += 1;
  }
  if (!values.url || !values.probe || !path.isAbsolute(values.probe)) {
    throw new RuntimeLaunchError('runtime URL and absolute probe path are required', 'USAGE_ERROR');
  }
  if (values.bin && !path.isAbsolute(values.bin)) {
    throw new RuntimeLaunchError('TRANSMOGRIFY_BIN must resolve to an absolute path', 'USAGE_ERROR');
  }
  return values;
}

function parseManagedCli(argv) {
  const values = { managed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--managed') {
      if (values.managed) throw new RuntimeLaunchError('repeated --managed', 'USAGE_ERROR');
      values.managed = true;
      continue;
    }
    if (!['--url', '--bin', '--log', '--probe', '--relay-port'].includes(option) || index + 1 >= argv.length) {
      throw new RuntimeLaunchError(
        'usage: runtime-launch.js --managed --url <fallback-loopback-url> --probe <runtime-probe.js> [--relay-port 8844] [--bin <codex>] [--log <file>]',
        'USAGE_ERROR',
      );
    }
    if (values[option.slice(2)] !== undefined) {
      throw new RuntimeLaunchError(`repeated ${option}`, 'USAGE_ERROR');
    }
    values[option.slice(2)] = argv[index + 1];
    index += 1;
  }
  if (!values.managed || !values.url || !values.probe || !path.isAbsolute(values.probe)) {
    throw new RuntimeLaunchError('managed runtime, fallback URL, and absolute probe path are required', 'USAGE_ERROR');
  }
  if (values.bin && !path.isAbsolute(values.bin)) {
    throw new RuntimeLaunchError('TRANSMOGRIFY_BIN must resolve to an absolute path', 'USAGE_ERROR');
  }
  return {
    url: validateUrl(values.url),
    probe: values.probe,
    bin: values.bin,
    log: values.log,
    relayPort: values['relay-port'],
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--managed')) {
    const result = await ensurePreferredRuntime(parseManagedCli(argv));
    console.log(JSON.stringify(result));
    return result;
  }
  const result = await ensureRuntime(parseCli(argv));
  if (result.state === 'reused') {
    console.log(`verified loopback-only Codex app-server already listening on :${result.port}`);
  } else if (result.state === 'race-reused') {
    console.log(`verified loopback-only Codex app-server won the launch race on :${result.port}`);
  } else {
    console.log(`runtime up: pid=${result.pid} ${result.listenUrl} log=written`);
    console.log('the detached runtime owns a new OS session; verify it with the read-only doctor');
  }
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = exitCodeForError(error.code);
  });
}

module.exports = {
  RuntimeLaunchError,
  commandResult,
  daemonVersion,
  ensureManagedDaemon,
  ensurePreferredRuntime,
  ensureRuntime,
  inspectListeners,
  managedDaemonPaths,
  normalizeListenUrl,
  parseLsofListeners,
  parseManagedCli,
  openRuntimeLog,
  processMatches,
  sanitizedRuntimeEnv,
  spawnRuntime,
  terminateOwnedProcess,
};
