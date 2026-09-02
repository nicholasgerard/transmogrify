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
const { validateUrl } = require('./lib/app-server');

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

// Split a validated loopback URL into the client URL, the listen host and port,
// and the numeric port. Credentials, a path, a query, a fragment, or a missing
// port are USAGE_ERROR.
function normalizeListenUrl(rawUrl) {
  const canonical = validateUrl(rawUrl);
  const parsed = new URL(canonical);
  if (parsed.protocol !== 'ws:' || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.port) {
    throw new RuntimeLaunchError(
      'listen URL must use a literal loopback address and port with no credentials, path, query, or fragment',
      'USAGE_ERROR',
    );
  }
  return {
    clientUrl: canonical,
    listenUrl: `ws://${parsed.host}`,
    port: Number(parsed.port),
  };
}

// Parse lsof listener records for one port. A wildcard or non-loopback bind is
// UNSAFE_LISTENER and refuses reuse, so a runtime reachable off-host is never
// adopted as this installation's control plane.
function parseLsofListeners(raw, port) {
  const listeners = [];
  let current = null;
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      if (current) listeners.push(current);
      current = { pid: Number(value), command: null, names: [] };
    } else if (field === 'c' && current) {
      current.command = value;
    } else if (field === 'n' && current) {
      current.names.push(value.replace(/\s+\(LISTEN\)$/, ''));
    }
  }
  if (current) listeners.push(current);
  for (const listener of listeners) {
    if (!Number.isInteger(listener.pid) || listener.pid < 1 || listener.names.length === 0) {
      throw new RuntimeLaunchError('lsof returned an unverified listener shape');
    }
    for (const name of listener.names) {
      if (name !== `127.0.0.1:${port}` && name !== `[::1]:${port}`) {
        throw new RuntimeLaunchError(
          `port :${port} has a wildcard or non-loopback listener; refusing to reuse it`,
          'UNSAFE_LISTENER',
        );
      }
    }
  }
  return listeners;
}

// Bounded child execution that treats exit 1 as data, because lsof uses it for
// an empty result. Every other failure is a launch error.
function execFileResult(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      encoding: 'utf8',
      maxBuffer: MAX_CAPTURE_BYTES,
      timeout: options.timeoutMs || 3000,
      killSignal: 'SIGKILL',
      env: options.env,
    }, (error, stdout, stderr) => {
      if (error && error.code !== 1) {
        reject(new RuntimeLaunchError(`${path.basename(executable)} failed while inspecting the runtime`));
        return;
      }
      resolve({ code: error?.code || 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// lsof is resolved only from the system directories so a same-user PATH entry
// cannot substitute a listener report.
const SYSTEM_TOOL_PATH = '/usr/sbin:/usr/bin:/bin:/sbin';

// The loopback listeners on a port, or an empty list. Empty output with exit 1
// means nothing is listening there.
async function inspectListeners(port, dependencies = {}) {
  const run = dependencies.execFileResult || execFileResult;
  const result = await run('lsof', [
    '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn',
  ], { timeoutMs: 3000, env: { ...(dependencies.env || process.env), PATH: SYSTEM_TOOL_PATH } });
  if (result.code === 1 && !result.stdout.trim()) return [];
  return parseLsofListeners(result.stdout, port);
}

// Run the read-only probe against the endpoint. True only when it completed a
// verified Codex app-server handshake.
async function probeRuntime(probePath, clientUrl, dependencies = {}) {
  const run = dependencies.execFileResult || execFileResult;
  const result = await run(process.execPath, [
    probePath, '--url', clientUrl, '--timeout', String(PROBE_TIMEOUT_MS),
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    if (error instanceof RuntimeLaunchError) throw error;
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

async function main(argv = process.argv.slice(2)) {
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
    process.exitCode = error.code === 'USAGE_ERROR' ? 2 : 1;
  });
}

module.exports = {
  RuntimeLaunchError,
  ensureRuntime,
  inspectListeners,
  normalizeListenUrl,
  parseLsofListeners,
  openRuntimeLog,
  processMatches,
  sanitizedRuntimeEnv,
  spawnRuntime,
  terminateOwnedProcess,
};
