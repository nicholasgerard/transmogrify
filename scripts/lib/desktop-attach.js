'use strict';

// Codex Desktop attachment.
//
// Mechanism (observed on the tested macOS builds below; not an OpenAI-documented
// contract): when the Codex Desktop app starts with CODEX_APP_SERVER_WS_URL in
// its environment it becomes a client of that WebSocket app-server instead of
// spawning its private bundled child, so every lane created on the shared
// runtime renders and streams live in the app. The receipt is the app
// process's ESTABLISHED loopback connection to the runtime port, read through
// lsof. A Desktop build that ignores the variable never produces that receipt,
// so every consumer fails closed to the protocol-only path.
//
// This module never kills a process, never touches the runtime, and only ever
// quits the Desktop app through its own application quit after explicit owner
// authorization.

const path = require('node:path');
const { execFile } = require('node:child_process');
const { validateUrl } = require('./app-server');
const { inspectListeners } = require('./listeners');

const ATTACH_ENV = 'CODEX_APP_SERVER_WS_URL';
const DISABLE_ENV = 'TRANSMOGRIFY_DESKTOP_ATTACH';
const RELAUNCH_ENV = 'TRANSMOGRIFY_DESKTOP_RELAUNCH';
const BUNDLE_ENV = 'TRANSMOGRIFY_DESKTOP_BUNDLE_ID';
const DEFAULT_BUNDLE_IDS = Object.freeze(['com.openai.codex', 'com.openai.chat']);
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{1,126}[A-Za-z0-9])$/;
const SYSTEM_TOOL_PATH = '/usr/sbin:/usr/bin:/bin:/sbin';
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const DEFAULT_ATTACH_TIMEOUT_MS = 20_000;
const MAX_ATTACH_TIMEOUT_MS = 120_000;
const QUIT_TIMEOUT_MS = 30_000;
const POLL_MS = 500;
const MAX_ELSEWHERE_PORTS = 8;

// Desktop builds on which an attached launch was observed to render and stream
// Transmogrify lanes live. Documentation for the operator, not a gate: the
// receipt is measured on every check.
const TESTED_DESKTOP_BUILDS = Object.freeze([
  Object.freeze({ version: '26.825.51511', build: '7377', observedOn: '2026-09-01' }),
  Object.freeze({ version: '26.901.20858', build: '7658', observedOn: '2026-09-02' }),
]);

// Attachment failure carrying a stable code. Every code names the Desktop state
// that was observed, so a refusal tells the operator what to fix.
class DesktopAttachError extends Error {
  constructor(message, code = 'DESKTOP_ATTACH_FAILED', details = null) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

function usage(message) {
  throw new DesktopAttachError(message, 'USAGE_ERROR');
}

// Bounded child execution that never rejects. A missing or unusable tool comes
// back as code null with a failure reason, so an inspection gap is reported
// rather than mistaken for a negative observation. PATH is forced to the system
// directories so a same-user entry cannot substitute the tool.
function execFileResult(executable, args, options = {}) {
  return new Promise((resolve) => {
    execFile(executable, args, {
      encoding: 'utf8',
      maxBuffer: MAX_CAPTURE_BYTES,
      timeout: options.timeoutMs || 5000,
      killSignal: 'SIGKILL',
      env: { ...(options.env || process.env), PATH: SYSTEM_TOOL_PATH },
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        resolve({
          code: null,
          failure: error.code === 'ENOENT' ? 'missing' : error.killed ? 'timeout' : 'failed',
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
        return;
      }
      resolve({ code: error ? error.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// The runtime this check is about: explicit option, then TRANSMOGRIFY_URL, then
// the default loopback port, always through the loopback URL validator.
function resolveRuntimeUrl(options, env) {
  return validateUrl(options.url || env.TRANSMOGRIFY_URL ||
    `ws://127.0.0.1:${env.TRANSMOGRIFY_PORT || '8843'}`);
}

function runtimePort(runtimeUrl) {
  const port = Number(new URL(runtimeUrl).port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    usage('the runtime URL must carry an explicit loopback port');
  }
  return port;
}

// The attach wait is bounded on both ends, so ensure can neither spin nor return
// before the app has had time to connect.
function boundedTimeout(value) {
  const timeoutMs = value === undefined ? DEFAULT_ATTACH_TIMEOUT_MS : value;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_ATTACH_TIMEOUT_MS) {
    usage(`timeout must be an integer between 1000 and ${MAX_ATTACH_TIMEOUT_MS} milliseconds`);
  }
  return timeoutMs;
}

// The bundle identifiers to look for, overridable by environment. An override
// that is not a bundle identifier is a usage error, never a shell fragment.
function bundleCandidates(env) {
  if (env[BUNDLE_ENV] !== undefined) {
    if (!BUNDLE_ID_PATTERN.test(env[BUNDLE_ENV])) usage(`${BUNDLE_ENV} must be a bundle identifier`);
    return [env[BUNDLE_ENV]];
  }
  return DEFAULT_BUNDLE_IDS;
}

// Split an lsof address into host, port, and whether the host is loopback.
function parseAddress(raw) {
  const match = /^(\[[0-9a-fA-F:]+\]|[0-9.]+):(\d{1,5})$/.exec(raw || '');
  if (!match) return null;
  const host = match[1];
  const loopback = host === '127.0.0.1' || host === '[::1]';
  return { host, port: Number(match[2]), loopback };
}

// Parses `lsof -Fpcn` output for ESTABLISHED TCP rows. Returns one entry per
// connection with the owning pid and command.
function parseEstablishedConnections(raw) {
  const connections = [];
  let pid = null;
  let command = null;
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      pid = Number(value);
      command = null;
      if (!Number.isInteger(pid) || pid < 1) {
        throw new DesktopAttachError('lsof returned an unverified process shape', 'TOOL_FAILED');
      }
    } else if (field === 'c') {
      command = value;
    } else if (field === 'n' && pid !== null) {
      const [localRaw, remoteRaw] = value.replace(/\s+\(ESTABLISHED\)$/, '').split('->');
      const local = parseAddress(localRaw);
      const remote = parseAddress(remoteRaw);
      if (!local || !remote) continue;
      connections.push({ pid, command, local, remote });
    }
  }
  return connections;
}

// Client-side connections into the runtime port: the remote end is the runtime
// and the local end is an ephemeral port.
function clientConnections(connections, port) {
  return connections.filter((connection) =>
    connection.remote.loopback && connection.remote.port === port &&
    connection.local.loopback && connection.local.port !== port);
}

// Run a system tool and turn an unavailable one into TOOL_UNAVAILABLE, so a
// missing tool is never read as proof that Desktop is unattached.
async function requireTool(run, executable, args, env, timeoutMs = 5000) {
  const result = await run(executable, args, { timeoutMs, env });
  if (result.code === null) {
    throw new DesktopAttachError(`${executable} is ${result.failure === 'missing' ? 'not available' : 'not usable'} on this host`, 'TOOL_UNAVAILABLE', { tool: executable });
  }
  return result;
}

// The first installed Desktop application among the accepted bundle identifiers,
// with its path, version, and build. Null when none is installed.
async function resolveDesktopApp(run, env) {
  for (const bundleId of bundleCandidates(env)) {
    const located = await requireTool(run, 'osascript', [
      '-e', `POSIX path of (path to application id "${bundleId}")`,
    ], env);
    if (located.code !== 0) continue;
    const appPath = located.stdout.trim().replace(/\/+$/, '');
    if (!path.isAbsolute(appPath) || !appPath.endsWith('.app')) continue;
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    const version = await run('defaults', ['read', plist, 'CFBundleShortVersionString'], { timeoutMs: 5000, env });
    const build = await run('defaults', ['read', plist, 'CFBundleVersion'], { timeoutMs: 5000, env });
    return {
      bundleId,
      appPath,
      version: version.code === 0 ? version.stdout.trim() : null,
      build: build.code === 0 ? build.stdout.trim() : null,
    };
  }
  return null;
}

// Process ids whose executable lives inside this application bundle. Matching on
// the resolved bundle path keeps an unrelated process of the same name out.
async function desktopProcessIds(run, appPath, env) {
  const listed = await requireTool(run, 'ps', ['-axo', 'pid=,comm='], env);
  const prefix = `${appPath}/Contents/MacOS/`;
  const pids = [];
  for (const line of listed.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    if (match[2].startsWith(prefix)) pids.push(Number(match[1]));
  }
  return pids;
}

// Ancestor process ids of this process, bounded. A Transmogrify command that
// runs inside Codex Desktop's private runtime descends from the app process;
// relaunching the app from there would end the very session issuing the
// command.
async function ancestorProcessIds(run, env, startPid) {
  const ancestors = [];
  let current = startPid;
  for (let hop = 0; hop < 32 && current > 1; hop += 1) {
    const listed = await run('ps', ['-o', 'ppid=', '-p', String(current)], { timeoutMs: 5000, env });
    if (listed.code !== 0) break;
    const parent = Number(listed.stdout.trim());
    if (!Number.isInteger(parent) || parent < 1 || ancestors.includes(parent)) break;
    ancestors.push(parent);
    current = parent;
  }
  return ancestors;
}

// Established client connections into the runtime port, or an empty list when
// nothing is connected.
async function establishedClients(run, port, env) {
  const result = await requireTool(run, 'lsof', [
    '-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fpcn',
  ], env);
  if (result.code === 1 && !result.stdout.trim()) return [];
  return clientConnections(parseEstablishedConnections(result.stdout), port);
}

// Other loopback Codex app-server listeners the Desktop process is attached
// to: another operator's shared runtime that should be reused rather than
// competed with.
async function attachedElsewhere(run, pids, port, env) {
  const connections = await run('lsof', [
    '-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:ESTABLISHED', '-Fpcn',
  ], { timeoutMs: 5000, env });
  if (connections.code === null || !connections.stdout.trim()) return [];
  const candidatePorts = new Set();
  for (const connection of parseEstablishedConnections(connections.stdout)) {
    if (!connection.remote.loopback || connection.remote.port === port) continue;
    if (!connection.local.loopback || connection.local.port === connection.remote.port) continue;
    candidatePorts.add(connection.remote.port);
  }
  if (candidatePorts.size === 0) return [];
  const listeners = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeoutMs: 5000, env });
  if (listeners.code === null) return [];
  const listenerCommands = new Map();
  let pid = null;
  let command = null;
  for (const line of listeners.stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line[0] === 'p') { pid = Number(line.slice(1)); command = null; continue; }
    if (line[0] === 'c') { command = line.slice(1); continue; }
    if (line[0] === 'n') {
      const address = parseAddress(line.slice(1).replace(/\s+\(LISTEN\)$/, '').replace(/^\*:/, '0.0.0.0:'));
      if (address && address.loopback) listenerCommands.set(address.port, { pid, command });
    }
  }
  const found = [];
  for (const candidate of [...candidatePorts].slice(0, MAX_ELSEWHERE_PORTS)) {
    const listener = listenerCommands.get(candidate);
    if (listener && listener.command === 'codex') {
      found.push({ url: `ws://127.0.0.1:${candidate}`, listenerPid: listener.pid });
    }
  }
  return found;
}

// Whether this Desktop version and build are among the tested pair. Reported for
// the operator; the attachment receipt itself is always measured.
function buildTested(app) {
  return TESTED_DESKTOP_BUILDS.some((tested) =>
    tested.version === app.version && tested.build === app.build);
}

// Read-only attachment receipt. It reports exactly one state: attached with the
// observed connection, or disabled, unsupportedPlatform, notInstalled,
// notRunning, attachedElsewhere, unattached, or toolUnavailable when inspection
// itself failed. It launches nothing, quits nothing, and touches no runtime.
async function check(options = {}, env = process.env, dependencies = {}) {
  const run = dependencies.execFileResult || execFileResult;
  const platform = dependencies.platform || process.platform;
  const now = dependencies.now || (() => new Date().toISOString());
  const selfPid = dependencies.pid || process.pid;
  const runtimeUrl = resolveRuntimeUrl(options, env);
  const port = runtimePort(runtimeUrl);
  const base = {
    version: 1,
    operation: 'check',
    runtimeUrl,
    platform,
    mechanism: {
      attachEnv: ATTACH_ENV,
      evidence: 'lsof-established-loopback-connection',
      testedDesktopBuilds: TESTED_DESKTOP_BUILDS,
    },
  };
  const unattached = (desktop, attachment, nextAction) => ({
    ...base, ok: false, desktop, attachment, nextAction,
  });
  if (env[DISABLE_ENV] === 'off') {
    return unattached(null, { state: 'disabled', evidence: `${DISABLE_ENV}=off` }, 'use-allow-protocol-only');
  }
  if (platform !== 'darwin') {
    return unattached(null, {
      state: 'unsupportedPlatform',
      evidence: 'codex-desktop-attachment-is-macos-only',
    }, 'use-allow-protocol-only');
  }
  let app;
  let pids;
  let clients;
  let hostedByDesktop = false;
  try {
    app = await resolveDesktopApp(run, env);
    if (!app) {
      return unattached({ installed: false }, {
        state: 'notInstalled',
        evidence: 'no-application-for-bundle-identifiers',
        bundleIds: bundleCandidates(env),
      }, 'install-codex-desktop-or-use-allow-protocol-only');
    }
    pids = await desktopProcessIds(run, app.appPath, env);
    clients = pids.length ? await establishedClients(run, port, env) : [];
    hostedByDesktop = pids.length > 0 &&
      (await ancestorProcessIds(run, env, selfPid)).some((ancestor) => pids.includes(ancestor));
  } catch (error) {
    if (error instanceof DesktopAttachError && error.code !== 'USAGE_ERROR') {
      return unattached(null, {
        state: 'toolUnavailable',
        evidence: error.message,
        ...(error.details ? { tool: error.details.tool } : {}),
      }, 'restore-system-tools-or-use-allow-protocol-only');
    }
    throw error;
  }
  const desktop = {
    installed: true,
    ...app,
    buildTested: buildTested(app),
    running: pids.length > 0,
    pids,
    hostedByDesktop,
  };
  if (!pids.length) {
    return unattached(desktop, { state: 'notRunning', evidence: 'no-desktop-process' }, 'run-desktop-attach-ensure');
  }
  const match = clients.find((connection) => pids.includes(connection.pid));
  if (match) {
    return {
      ...base,
      ok: true,
      desktop,
      attachment: {
        state: 'attached',
        evidence: 'lsof-established-loopback-connection',
        clientPid: match.pid,
        connection: `${match.local.host}:${match.local.port}->${match.remote.host}:${match.remote.port}`,
        observedAt: now(),
      },
      nextAction: 'none',
    };
  }
  let elsewhere = [];
  try {
    elsewhere = await attachedElsewhere(run, pids, port, env);
  } catch {
    elsewhere = [];
  }
  if (elsewhere.length) {
    return unattached(desktop, {
      state: 'attachedElsewhere',
      evidence: 'desktop-connected-to-another-loopback-codex-listener',
      elsewhere,
    }, `reuse-attached-runtime:${elsewhere[0].url}`);
  }
  return unattached(desktop, {
    state: 'unattached',
    evidence: 'no-established-connection-to-runtime',
  }, 'run-desktop-attach-ensure');
}

// Quit Desktop through the application's own quit and wait for its processes to
// exit. A refusal is DESKTOP_QUIT_FAILED and a survivor is DESKTOP_QUIT_TIMEOUT;
// no process is ever signalled.
async function quitDesktop(run, desktop, env, dependencies) {
  const sleep = dependencies.sleep || delay;
  const clock = dependencies.clock || Date.now;
  const requested = await requireTool(run, 'osascript', [
    '-e', `tell application id "${desktop.bundleId}" to quit`,
  ], env, QUIT_TIMEOUT_MS);
  if (requested.code !== 0) {
    throw new DesktopAttachError('Codex Desktop refused the quit request', 'DESKTOP_QUIT_FAILED');
  }
  const deadline = clock() + QUIT_TIMEOUT_MS;
  for (;;) {
    const pids = await desktopProcessIds(run, desktop.appPath, env);
    if (!pids.length) return;
    if (clock() >= deadline) {
      throw new DesktopAttachError(
        `Codex Desktop is still running ${QUIT_TIMEOUT_MS} ms after the quit request; finish or discard its open work, then retry`,
        'DESKTOP_QUIT_TIMEOUT',
        { pids },
      );
    }
    await sleep(POLL_MS);
  }
}

// Launch Desktop with the attach variable set to the runtime URL. A launch that
// reports the app was already running is DESKTOP_STILL_RUNNING, because that
// launch could not have carried the environment.
async function launchDesktopAttached(run, desktop, runtimeUrl, env) {
  const launched = await requireTool(run, 'open', [
    '-b', desktop.bundleId, '--env', `${ATTACH_ENV}=${runtimeUrl.replace(/\/$/, '')}`,
  ], env, 15_000);
  if (launched.code !== 0) {
    throw new DesktopAttachError(`open failed to launch ${desktop.bundleId}`, 'DESKTOP_LAUNCH_FAILED');
  }
  if (/already running/i.test(launched.stderr)) {
    throw new DesktopAttachError(
      'Codex Desktop was already running, so the launch could not carry the runtime environment',
      'DESKTOP_STILL_RUNNING',
    );
  }
}

// Bring Desktop to an attached state and prove it with a fresh check. An
// already-attached app is reused and a stopped app is launched attached.
// Relaunching a running unattached app quits it, so it requires explicit or
// standing owner authorization, is refused from a session hosted by the app
// itself, and is refused when Desktop is already attached elsewhere or no
// loopback runtime is listening.
async function ensure(options = {}, env = process.env, dependencies = {}) {
  const run = dependencies.execFileResult || execFileResult;
  const sleep = dependencies.sleep || delay;
  const clock = dependencies.clock || Date.now;
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const authorization = options.relaunch === true
    ? 'flag'
    : env[RELAUNCH_ENV] === 'auto' ? 'standing-env' : 'none';
  const initial = await check(options, env, dependencies);
  const finished = (action, receipt, warnings = []) => ({
    version: 1,
    ok: receipt.attachment.state === 'attached',
    operation: 'ensure',
    action,
    relaunchAuthorization: authorization,
    ...(warnings.length ? { warnings } : {}),
    receipt,
  });
  const state = initial.attachment.state;
  if (state === 'attached') return finished('reused', initial);
  if (state === 'disabled') {
    throw new DesktopAttachError(`${DISABLE_ENV}=off disables Codex Desktop attachment`, 'ATTACH_DISABLED');
  }
  if (state === 'unsupportedPlatform') {
    throw new DesktopAttachError('Codex Desktop attachment is available on macOS only', 'UNSUPPORTED_PLATFORM');
  }
  if (state === 'notInstalled') {
    throw new DesktopAttachError('no Codex Desktop application is installed for the accepted bundle identifiers', 'DESKTOP_NOT_INSTALLED');
  }
  if (state === 'toolUnavailable') {
    throw new DesktopAttachError(initial.attachment.evidence, 'TOOL_UNAVAILABLE');
  }
  if (state === 'attachedElsewhere') {
    throw new DesktopAttachError(
      `Codex Desktop is already attached to ${initial.attachment.elsewhere[0].url}; reuse that runtime instead of relaunching the app`,
      'ATTACHED_ELSEWHERE',
      { suggestedRuntimeUrl: initial.attachment.elsewhere[0].url },
    );
  }
  const port = runtimePort(initial.runtimeUrl);
  const listeners = await inspectListeners(port, { execFileResult: run, env });
  if (!listeners.length) {
    throw new DesktopAttachError(
      `no loopback listener on ${initial.runtimeUrl}; reuse or start a runtime before attaching Desktop`,
      'RUNTIME_UNAVAILABLE',
    );
  }
  const warnings = [];
  let action;
  if (state === 'unattached') {
    if (initial.desktop.hostedByDesktop) {
      throw new DesktopAttachError(
        'this command runs inside Codex Desktop\'s private runtime, so relaunching the app would end this session; use native Codex collaboration for Codex children here, spawn Claude lanes, or attach Desktop from a session outside the app',
        'DESKTOP_HOST_SESSION',
        { desktop: { pids: initial.desktop.pids, version: initial.desktop.version, build: initial.desktop.build } },
      );
    }
    if (authorization === 'none') {
      throw new DesktopAttachError(
        'Codex Desktop is running without the shared runtime; relaunching it quits the app, so pass --relaunch-desktop after the owner agrees or set TRANSMOGRIFY_DESKTOP_RELAUNCH=auto',
        'DESKTOP_RELAUNCH_REQUIRED',
        { desktop: { pids: initial.desktop.pids, version: initial.desktop.version, build: initial.desktop.build } },
      );
    }
    warnings.push('the private Desktop runtime could not be inspected for in-flight work before the quit');
    await quitDesktop(run, initial.desktop, env, dependencies);
    action = 'relaunched';
  } else {
    action = 'launched';
  }
  await launchDesktopAttached(run, initial.desktop, initial.runtimeUrl, env);
  const deadline = clock() + timeoutMs;
  let latest = initial;
  for (;;) {
    await sleep(POLL_MS);
    latest = await check(options, env, dependencies);
    if (latest.attachment.state === 'attached') return finished(action, latest, warnings);
    if (clock() >= deadline) break;
  }
  throw new DesktopAttachError(
    `Codex Desktop did not attach to ${initial.runtimeUrl} within ${timeoutMs} ms (last state: ${latest.attachment.state})`,
    'ATTACH_TIMEOUT',
    { lastState: latest.attachment.state },
  );
}

module.exports = {
  ATTACH_ENV,
  BUNDLE_ENV,
  DEFAULT_ATTACH_TIMEOUT_MS,
  DISABLE_ENV,
  DesktopAttachError,
  RELAUNCH_ENV,
  TESTED_DESKTOP_BUILDS,
  check,
  clientConnections,
  ensure,
  parseEstablishedConnections,
};
