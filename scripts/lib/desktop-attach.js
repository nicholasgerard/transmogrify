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
// This module never kills a process. It delegates runtime startup to the
// runtime launcher and only ever quits Desktop through its own application
// quit after explicit owner authorization.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { validateUrl } = require('./app-server');
const { inspectListeners } = require('./listeners');
const { sleep: delay } = require('./async');
const { atomicWriteJson, stateRoot } = require('./state');
const {
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  relayUrl,
  runningRelay,
} = require('./relay');

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
const LAUNCH_AGENT_LABEL = 'sh.transmogrify.attach';
const LAUNCH_AGENT_FILE = `${LAUNCH_AGENT_LABEL}.plist`;
const LAUNCH_AGENT_MARKER = 'Managed by Transmogrify desktop-attach.js';
const PERSISTENCE_RECEIPT_VERSION = 1;
const PERSISTENCE_PHASES = new Set(['prepared', 'plistWritten', 'settingEnvironment', 'applied']);

// Desktop builds on which an attached launch was observed to render and stream
// Transmogrify lanes live. Documentation for the operator, not a gate: the
// receipt is measured on every check.
const TESTED_DESKTOP_BUILDS = Object.freeze([
  Object.freeze({ version: '26.825.51511', build: '7377', observedOn: '2026-09-01' }),
  Object.freeze({ version: '26.901.20858', build: '7658', observedOn: '2026-09-02' }),
  Object.freeze({ version: '26.901.22334', build: '7746', observedOn: '2026-09-04' }),
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
    const finished = (error, stdout = '', stderr = '') => {
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
    };
    try {
      execFile(executable, args, {
        encoding: 'utf8',
        maxBuffer: MAX_CAPTURE_BYTES,
        timeout: options.timeoutMs || 5000,
        killSignal: 'SIGKILL',
        env: { ...(options.env || process.env), PATH: SYSTEM_TOOL_PATH },
      }, finished);
    } catch (error) {
      finished(error);
    }
  });
}


// The runtime this check is about: explicit option, TRANSMOGRIFY_URL, a live
// managed-daemon relay record, then the legacy standalone endpoint. Returning
// the relay record with the URL lets an attachment receipt prove both the
// Desktop TCP connection and the daemon socket behind that relay.
function resolveRuntimeTarget(options = {}, env = process.env, dependencies = {}) {
  const readRelay = dependencies.runningRelay || runningRelay;
  let relay = null;
  if (!options.url && !env.TRANSMOGRIFY_URL) {
    relay = readRelay(env, dependencies.relayDependencies || dependencies);
  }
  const rawUrl = options.url || env.TRANSMOGRIFY_URL || relay?.url ||
    `ws://127.0.0.1:${env.TRANSMOGRIFY_PORT || '8843'}`;
  const url = validateUrl(rawUrl);
  if (!relay) {
    try {
      const candidate = readRelay(env, dependencies.relayDependencies || dependencies);
      if (candidate && validateUrl(candidate.url) === url) relay = candidate;
    } catch {
      // An explicit runtime remains usable even when unrelated relay state is
      // unreadable. A relay is claimed only from a valid live record.
    }
  }
  return {
    url,
    source: options.url ? 'option' : env.TRANSMOGRIFY_URL ? 'environment' : relay ? 'liveRelay' : 'legacyDefault',
    relay: relay && validateUrl(relay.url) === url ? relay : null,
  };
}

function resolveRuntimeUrl(options = {}, env = process.env, dependencies = {}) {
  return resolveRuntimeTarget(options, env, dependencies).url;
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
async function resolveDesktopApp(run, env, dependencies = {}) {
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
  // LaunchServices lookup can be denied inside a sandbox even though the app
  // bundle is readable. Fall back to the two standard per-machine and per-user
  // locations, but accept a bundle only after its plist names an allowed id.
  const homes = env.HOME && path.isAbsolute(env.HOME) ? [env.HOME] : [];
  const candidates = [
    '/Applications/ChatGPT.app',
    '/Applications/Codex.app',
    ...homes.flatMap((home) => [
      path.join(home, 'Applications', 'ChatGPT.app'),
      path.join(home, 'Applications', 'Codex.app'),
    ]),
  ];
  const exists = dependencies.existsSync || fs.existsSync;
  for (const appPath of candidates) {
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    if (!exists(plist)) continue;
    const identifier = await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist], {
      timeoutMs: 5000, env,
    });
    const bundleId = identifier.code === 0 ? identifier.stdout.trim() : null;
    if (!bundleCandidates(env).includes(bundleId)) continue;
    const version = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist], {
      timeoutMs: 5000, env,
    });
    const build = await run('plutil', ['-extract', 'CFBundleVersion', 'raw', plist], {
      timeoutMs: 5000, env,
    });
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

// The private-runtime self-host check is an identity intersection, shared with
// host-context detection so the two callers cannot disagree about ancestry.
function hostedByDesktop(ancestorPids, desktopPids) {
  const desktop = new Set(desktopPids);
  return ancestorPids.some((pid) => desktop.has(pid));
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

// Persistence is a two-part receipt: the login launch environment names the
// selected live relay and the per-user LaunchAgent exists to reapply it. Any
// missing or unreadable evidence is false, never an inferred success.
async function attachmentPersisted(target, run, env, dependencies) {
  if (!target.relay) return false;
  try {
    const inspect = dependencies.launchctlGetenv || (dependencies.launchctl
      ? async (name) => dependencies.launchctl(['getenv', name], env)
      : async (name) => run('/bin/launchctl', ['getenv', name], { timeoutMs: 5000, env }));
    const observed = await inspect(ATTACH_ENV, env);
    const value = typeof observed === 'string'
      ? observed.trim()
      : observed?.code === 0 ? String(observed.stdout || '').trim() : '';
    const expected = target.relay.url;
    const exists = dependencies.plistExists || dependencies.plistWriter?.exists || fs.existsSync;
    return value === expected && exists(persistencePath(env, dependencies));
  } catch {
    return false;
  }
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
  const target = resolveRuntimeTarget(options, env, dependencies);
  const runtimeUrl = target.url;
  const port = runtimePort(runtimeUrl);
  const persisted = platform === 'darwin' && env[DISABLE_ENV] !== 'off'
    ? await attachmentPersisted(target, run, env, dependencies)
    : false;
  const base = {
    version: 1,
    operation: 'check',
    runtimeUrl,
    runtimeSource: target.source,
    persisted,
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
  let desktopHostsSession = false;
  try {
    app = await resolveDesktopApp(run, env, dependencies);
    if (!app) {
      return unattached({ installed: false }, {
        state: 'notInstalled',
        evidence: 'no-application-for-bundle-identifiers',
        bundleIds: bundleCandidates(env),
      }, 'install-codex-desktop-or-use-allow-protocol-only');
    }
    pids = await desktopProcessIds(run, app.appPath, env);
    clients = pids.length ? await establishedClients(run, port, env) : [];
    desktopHostsSession = pids.length > 0 && hostedByDesktop(
      await ancestorProcessIds(run, env, selfPid), pids,
    );
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
    hostedByDesktop: desktopHostsSession,
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
        ...(target.relay ? {
          relay: {
            url: target.relay.url,
            socketPath: target.relay.socketPath,
          },
        } : {}),
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

// Ask the runtime module to establish its preferred managed-daemon/relay path.
// Desktop attachment owns no runtime process lifecycle itself.
async function runtimeUp(options, env, dependencies) {
  const ensureRuntime = dependencies.runtimeUp || (async (runtimeOptions) => {
    const { ensurePreferredRuntime } = require('../runtime-launch');
    return ensurePreferredRuntime(runtimeOptions, {
      env,
      ...(dependencies.runtimeDependencies || {}),
    });
  });
  const result = await ensureRuntime({
    url: options.url,
    probe: path.join(__dirname, '..', 'runtime-probe.js'),
    relayPort: env.TRANSMOGRIFY_RELAY_PORT || DEFAULT_RELAY_PORT,
  }, env);
  if (!result || typeof result.url !== 'string') {
    throw new DesktopAttachError('runtime-up did not return a selected runtime URL', 'RUNTIME_LAUNCH_FAILED');
  }
  return { ...result, url: validateUrl(result.url) };
}

async function runtimeListeners(run, runtimeUrl, env, dependencies) {
  const inspect = dependencies.inspectListeners || inspectListeners;
  return inspect(runtimePort(runtimeUrl), { execFileResult: run, env });
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
  if (options.launchOnly === true && !resolveRuntimeTarget(options, env, dependencies).relay) {
    throw new DesktopAttachError(
      'the selected relay must already have a live record for a launch-only attachment',
      'RELAY_UNAVAILABLE',
    );
  }
  let selectedOptions = options;
  let initial = await check(selectedOptions, env, dependencies);
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
  if (options.launchOnly === true && state === 'unattached') {
    throw new DesktopAttachError(
      'launch-only attachment requires Codex Desktop to be stopped',
      'DESKTOP_RELAUNCH_REQUIRED',
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
    action = 'relaunched';
  } else {
    action = 'launched';
  }

  // A Desktop launch against an absent relay does not recover after the relay
  // appears. Establish the selected runtime first, and adopt runtime-up's relay
  // URL before any quit or launch.
  if (!(await runtimeListeners(run, initial.runtimeUrl, env, dependencies)).length) {
    if (options.launchOnly === true) {
      throw new DesktopAttachError(
        'the selected relay must already be listening for a launch-only attachment',
        'RELAY_UNAVAILABLE',
      );
    }
    const runtime = await runtimeUp({ url: options.url || env.TRANSMOGRIFY_URL || initial.runtimeUrl }, env, dependencies);
    selectedOptions = { ...options, url: runtime.url };
    initial = await check(selectedOptions, env, dependencies);
    if (initial.attachment.state === 'attached') return finished('reused', initial, warnings);
    if (!(await runtimeListeners(run, initial.runtimeUrl, env, dependencies)).length) {
      throw new DesktopAttachError(
        `runtime-up did not establish a loopback listener on ${initial.runtimeUrl}`,
        'RUNTIME_UNAVAILABLE',
      );
    }
  }
  if (action === 'relaunched') await quitDesktop(run, initial.desktop, env, dependencies);
  await launchDesktopAttached(run, initial.desktop, initial.runtimeUrl, env);
  const deadline = clock() + timeoutMs;
  let latest = initial;
  for (;;) {
    await sleep(POLL_MS);
    latest = await check(selectedOptions, env, dependencies);
    if (latest.attachment.state === 'attached') return finished(action, latest, warnings);
    if (clock() >= deadline) break;
  }
  throw new DesktopAttachError(
    `Codex Desktop did not attach to ${initial.runtimeUrl} within ${timeoutMs} ms (last state: ${latest.attachment.state})`,
    'ATTACH_TIMEOUT',
    { lastState: latest.attachment.state },
  );
}

function persistencePath(env = process.env, dependencies = {}) {
  const home = dependencies.home || env.HOME || os.homedir();
  if (!path.isAbsolute(home) || path.normalize(home) !== home) {
    usage('HOME must be a normalized absolute path for Desktop attachment persistence');
  }
  return path.join(home, 'Library', 'LaunchAgents', LAUNCH_AGENT_FILE);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// A LaunchAgent that names a versioned Node install path breaks silently when
// Node is upgraded and that path disappears. Prefer a stable alias (Homebrew's
// bin/node link, /usr/local/bin/node) when it resolves to the same file as the
// running executable; otherwise keep the exact executable.
const STABLE_NODE_ALIASES = Object.freeze(['/opt/homebrew/bin/node', '/usr/local/bin/node']);

function stableNodePath(execPath, dependencies = {}) {
  const realpath = dependencies.realpath || ((target) => fs.realpathSync(target));
  let actual;
  try { actual = realpath(execPath); } catch { return execPath; }
  for (const alias of dependencies.nodeAliases || STABLE_NODE_ALIASES) {
    try { if (realpath(alias) === actual) return alias; } catch {}
  }
  return execPath;
}

function launchAgentContents(runtimeUrl, dependencies = {}) {
  const nodePath = dependencies.nodePath || stableNodePath(process.execPath, dependencies);
  const scriptPath = dependencies.scriptPath || path.join(__dirname, '..', 'desktop-attach.js');
  for (const [name, value] of [['Node executable', nodePath], ['desktop-attach script', scriptPath]]) {
    if (!path.isAbsolute(value) || path.normalize(value) !== value) {
      usage(`${name} must be a normalized absolute path`);
    }
  }
  const argumentsXml = [nodePath, scriptPath, 'apply-persisted', '--url', runtimeUrl]
    .map((argument) => `    <string>${xmlEscape(argument)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${LAUNCH_AGENT_MARKER} -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>ProcessType</key>
  <string>Background</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

function assertManagedLaunchAgent(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new DesktopAttachError(
      `refusing an unowned or non-regular LaunchAgent at ${file}`,
      'FOREIGN_LAUNCH_AGENT',
    );
  }
  const contents = fs.readFileSync(file, 'utf8');
  if (!contents.includes(`<!-- ${LAUNCH_AGENT_MARKER} -->`) ||
      !contents.includes(`<string>${LAUNCH_AGENT_LABEL}</string>`)) {
    throw new DesktopAttachError(
      `refusing to replace a LaunchAgent not owned by Transmogrify at ${file}`,
      'FOREIGN_LAUNCH_AGENT',
    );
  }
  return true;
}

function writeLaunchAgent(file, contents) {
  assertManagedLaunchAgent(file);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
      fs.realpathSync(directory) !== directory ||
      (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) ||
      (directoryStat.mode & 0o022) !== 0) {
    usage(`refusing an unsafe LaunchAgents directory at ${directory}`);
  }
  const temporary = path.join(directory, `.${LAUNCH_AGENT_FILE}.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT |
    fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
}

function removeLaunchAgent(file) {
  if (!assertManagedLaunchAgent(file)) return false;
  fs.unlinkSync(file);
  return true;
}

async function launchctl(args, env, dependencies) {
  const invoke = dependencies.launchctl || (async (launchctlArgs) =>
    requireTool(dependencies.execFileResult || execFileResult, '/bin/launchctl', launchctlArgs, env));
  const result = await invoke(args, env);
  if (result && result.code !== undefined && result.code !== 0) {
    throw new DesktopAttachError(`launchctl ${args[0]} failed`, 'TOOL_FAILED');
  }
  return result;
}

async function launchEnvironmentValue(env, dependencies) {
  const inspect = dependencies.launchctlGetenv || (dependencies.launchctl
    ? async (name) => dependencies.launchctl(['getenv', name], env)
    : async (name) => (dependencies.execFileResult || execFileResult)(
      '/bin/launchctl', ['getenv', name], { timeoutMs: 5000, env },
    ));
  const observed = await inspect(ATTACH_ENV, env);
  if (typeof observed === 'string') return observed.trim();
  if (observed === undefined || observed?.code === 1) return '';
  if (observed?.code === 0) return String(observed.stdout || '').trim();
  throw new DesktopAttachError('launchctl getenv failed', 'TOOL_FAILED');
}

function persistenceReceiptPath(env = process.env, dependencies = {}) {
  const root = dependencies.persistenceStateRoot || stateRoot(env);
  return path.join(root, 'desktop-attach', 'persistence.json');
}

function validatePersistenceReceipt(receipt, file) {
  const keys = receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    ? Object.keys(receipt).sort() : [];
  const expected = [
    'appliedValue', 'phase', 'plistPath', 'previousValue', 'rollbackValue', 'version',
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
      receipt.version !== PERSISTENCE_RECEIPT_VERSION ||
      !PERSISTENCE_PHASES.has(receipt.phase) ||
      (receipt.previousValue !== null && typeof receipt.previousValue !== 'string') ||
      (receipt.rollbackValue !== null && typeof receipt.rollbackValue !== 'string') ||
      typeof receipt.appliedValue !== 'string' || !receipt.appliedValue ||
      receipt.plistPath !== file) {
    throw new DesktopAttachError('the Desktop persistence receipt is invalid', 'PERSISTENCE_NOT_OWNED');
  }
  return receipt;
}

function readPersistenceReceipt(env, dependencies, file) {
  const receiptFile = persistenceReceiptPath(env, dependencies);
  let stat;
  try { stat = fs.lstatSync(receiptFile); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0) {
    throw new DesktopAttachError('the Desktop persistence receipt is unsafe', 'PERSISTENCE_NOT_OWNED');
  }
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); } catch {
    throw new DesktopAttachError('the Desktop persistence receipt is invalid', 'PERSISTENCE_NOT_OWNED');
  }
  return validatePersistenceReceipt(receipt, file);
}

async function writePersistenceReceipt(receipt, env, dependencies) {
  const write = dependencies.receiptWriter || atomicWriteJson;
  await write(persistenceReceiptPath(env, dependencies), receipt);
  return receipt;
}

async function removePersistenceReceipt(env, dependencies) {
  const remove = dependencies.receiptRemover || ((file) => fs.unlinkSync(file));
  try { await remove(persistenceReceiptPath(env, dependencies)); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function restoreEnvironmentValue(receipt, currentValue, restoredValue, env, dependencies) {
  const previousValue = restoredValue || '';
  if (currentValue === previousValue) return;
  if (currentValue !== receipt.appliedValue) {
    throw new DesktopAttachError(
      `the login-session setting changed to ${currentValue || '(unset)'}`,
      'FOREIGN_LOGIN_SETTING',
      { currentValue: currentValue || null, appliedValue: receipt.appliedValue },
    );
  }
  if (restoredValue === null) await launchctl(['unsetenv', ATTACH_ENV], env, dependencies);
  else await launchctl(['setenv', ATTACH_ENV, restoredValue], env, dependencies);
}

// Finish the rollback described by an incomplete durable receipt. Environment
// restoration is allowed only while the current value is still transaction-owned.
async function recoverInterruptedPersistence(receipt, currentValue, env, dependencies) {
  if (!receipt || receipt.phase === 'applied') return currentValue;
  await restoreEnvironmentValue(receipt, currentValue, receipt.rollbackValue, env, dependencies);
  const remove = dependencies.plistRemover || dependencies.plistWriter?.remove || removeLaunchAgent;
  await remove(receipt.plistPath);
  await removePersistenceReceipt(env, dependencies);
  return receipt.rollbackValue || '';
}

function persistencePlan(runtimeUrl, env, dependencies) {
  const file = persistencePath(env, dependencies);
  return {
    runtimeUrl,
    launchctl: ['launchctl', 'setenv', ATTACH_ENV, runtimeUrl],
    launchAgent: {
      path: file,
      contents: launchAgentContents(runtimeUrl, dependencies),
    },
  };
}

function requireAuthorizedPersistence(options) {
  if (options.dryRun !== true && options.authorize !== true) {
    usage('persist and unpersist require --authorize for real changes; inspect them first with --dry-run');
  }
}

function plannedPersistentUrl(options, env, dependencies) {
  const target = resolveRuntimeTarget(options, env, dependencies);
  if (target.source !== 'legacyDefault') return target.url;
  const port = env.TRANSMOGRIFY_RELAY_PORT || DEFAULT_RELAY_PORT;
  return validateUrl(relayUrl(DEFAULT_RELAY_HOST, port));
}

// Install the login-session setting and LaunchAgent as one receipt-backed
// transaction. No foreign setting or plist is replaced by inference.
async function persist(options = {}, env = process.env, dependencies = {}) {
  if ((dependencies.platform || process.platform) !== 'darwin') {
    throw new DesktopAttachError('Codex Desktop attachment persistence is available on macOS only', 'UNSUPPORTED_PLATFORM');
  }
  requireAuthorizedPersistence(options);
  if (options.dryRun === true) {
    const plan = persistencePlan(plannedPersistentUrl(options, env, dependencies), env, dependencies);
    return { version: 1, ok: true, operation: 'persist', dryRun: true, ...plan };
  }
  const plannedUrl = plannedPersistentUrl(options, env, dependencies);
  const plan = persistencePlan(plannedUrl, env, dependencies);
  assertManagedLaunchAgent(plan.launchAgent.path);
  let currentValue = await launchEnvironmentValue(env, dependencies);
  let existingReceipt = readPersistenceReceipt(env, dependencies, plan.launchAgent.path);
  currentValue = await recoverInterruptedPersistence(existingReceipt, currentValue, env, dependencies);
  if (existingReceipt?.phase !== 'applied') existingReceipt = null;
  if (currentValue && currentValue !== plannedUrl && existingReceipt?.appliedValue !== currentValue) {
    throw new DesktopAttachError(
      `persist would replace the login-session setting ${currentValue} with ${plannedUrl}`,
      'FOREIGN_LOGIN_SETTING',
      { currentValue, plannedValue: plannedUrl },
    );
  }
  const runtime = await runtimeUp({ url: plannedUrl }, env, dependencies);
  if (runtime.url !== plannedUrl) {
    throw new DesktopAttachError('runtime-up selected a different persistence endpoint', 'RUNTIME_MISMATCH');
  }
  const previousValue = existingReceipt?.phase === 'applied'
    ? existingReceipt.previousValue : (currentValue || null);
  let receipt = {
    version: PERSISTENCE_RECEIPT_VERSION,
    previousValue,
    rollbackValue: currentValue || null,
    appliedValue: runtime.url,
    plistPath: plan.launchAgent.path,
    phase: 'prepared',
  };
  let transactionStarted = false;
  try {
    await writePersistenceReceipt(receipt, env, dependencies);
    transactionStarted = true;
    const write = typeof dependencies.plistWriter === 'function'
      ? dependencies.plistWriter
      : dependencies.plistWriter?.write || writeLaunchAgent;
    await write(plan.launchAgent.path, plan.launchAgent.contents);
    receipt = await writePersistenceReceipt({ ...receipt, phase: 'plistWritten' }, env, dependencies);
    receipt = await writePersistenceReceipt({ ...receipt, phase: 'settingEnvironment' }, env, dependencies);
    await launchctl(['setenv', ATTACH_ENV, runtime.url], env, dependencies);
    receipt = await writePersistenceReceipt({ ...receipt, phase: 'applied' }, env, dependencies);
  } catch (error) {
    if (transactionStarted) {
      try {
        const observed = await launchEnvironmentValue(env, dependencies);
        await restoreEnvironmentValue(receipt, observed, receipt.rollbackValue, env, dependencies);
        const remove = dependencies.plistRemover || dependencies.plistWriter?.remove || removeLaunchAgent;
        await remove(plan.launchAgent.path);
        await removePersistenceReceipt(env, dependencies);
      } catch (rollbackError) {
        throw new DesktopAttachError(
          `persistence failed and rollback could not complete: ${rollbackError.message}`,
          'PERSISTENCE_ROLLBACK_FAILED',
        );
      }
    }
    throw error;
  }
  return {
    version: 1,
    ok: true,
    operation: 'persist',
    dryRun: false,
    runtimeUrl: runtime.url,
    launchctl: plan.launchctl,
    launchAgent: { path: plan.launchAgent.path, written: true },
    persistence: { phase: receipt.phase },
  };
}

// Reverse only the exact applied receipt, restoring a pre-existing value when
// one was present before Transmogrify's transaction.
async function unpersist(options = {}, env = process.env, dependencies = {}) {
  if ((dependencies.platform || process.platform) !== 'darwin') {
    throw new DesktopAttachError('Codex Desktop attachment persistence is available on macOS only', 'UNSUPPORTED_PLATFORM');
  }
  requireAuthorizedPersistence(options);
  const file = persistencePath(env, dependencies);
  if (options.dryRun === true) {
    return {
      version: 1,
      ok: true,
      operation: 'unpersist',
      dryRun: true,
      launchctl: ['launchctl', 'unsetenv', ATTACH_ENV],
      launchAgent: { path: file, remove: true },
    };
  }
  if (!assertManagedLaunchAgent(file)) {
    throw new DesktopAttachError('the managed LaunchAgent is absent', 'PERSISTENCE_NOT_OWNED');
  }
  const remove = dependencies.plistRemover || dependencies.plistWriter?.remove || removeLaunchAgent;
  const receipt = readPersistenceReceipt(env, dependencies, file);
  if (!receipt || receipt.phase !== 'applied') {
    throw new DesktopAttachError('no completed Transmogrify persistence receipt exists', 'PERSISTENCE_NOT_OWNED');
  }
  const currentValue = await launchEnvironmentValue(env, dependencies);
  if (currentValue !== receipt.appliedValue) {
    throw new DesktopAttachError(
      `the login-session setting is ${currentValue || '(unset)'}, not the value in the receipt`,
      'FOREIGN_LOGIN_SETTING',
      { currentValue: currentValue || null, appliedValue: receipt.appliedValue },
    );
  }
  const removed = await remove(file);
  if (removed === false) {
    throw new DesktopAttachError('the managed LaunchAgent was not removed', 'PERSISTENCE_NOT_OWNED');
  }
  await restoreEnvironmentValue(receipt, currentValue, receipt.previousValue, env, dependencies);
  await removePersistenceReceipt(env, dependencies);
  return {
    version: 1,
    ok: true,
    operation: 'unpersist',
    dryRun: false,
    launchctl: receipt.previousValue === null
      ? ['launchctl', 'unsetenv', ATTACH_ENV]
      : ['launchctl', 'setenv', ATTACH_ENV, receipt.previousValue],
    launchAgent: { path: file, removed: true },
  };
}

// Private LaunchAgent entrypoint. Its order is the contract: the runtime and
// relay are verified before the still-owned login environment is reapplied.
async function applyPersisted(options = {}, env = process.env, dependencies = {}) {
  const selected = resolveRuntimeUrl(options, env, dependencies);
  const file = persistencePath(env, dependencies);
  if (!assertManagedLaunchAgent(file)) {
    throw new DesktopAttachError('the managed LaunchAgent is absent', 'PERSISTENCE_NOT_OWNED');
  }
  const receipt = readPersistenceReceipt(env, dependencies, file);
  if (!receipt || receipt.phase !== 'applied' || receipt.appliedValue !== selected) {
    throw new DesktopAttachError('the requested persisted setting has no matching receipt', 'PERSISTENCE_NOT_OWNED');
  }
  const runtime = await runtimeUp({ url: selected }, env, dependencies);
  if (runtime.url !== receipt.appliedValue) {
    throw new DesktopAttachError('runtime-up selected a different persisted endpoint', 'RUNTIME_MISMATCH');
  }
  const currentValue = await launchEnvironmentValue(env, dependencies);
  if (currentValue && currentValue !== receipt.appliedValue) {
    throw new DesktopAttachError(
      `the login-session setting changed to ${currentValue}`,
      'FOREIGN_LOGIN_SETTING',
      { currentValue, appliedValue: receipt.appliedValue },
    );
  }
  if (!currentValue) await launchctl(['setenv', ATTACH_ENV, runtime.url], env, dependencies);
  return {
    version: 1,
    ok: true,
    operation: 'apply-persisted',
    runtimeUrl: runtime.url,
    runtimeReadyBeforeEnvironment: true,
    environmentChanged: !currentValue,
  };
}

module.exports = {
  ATTACH_ENV,
  BUNDLE_ENV,
  DEFAULT_ATTACH_TIMEOUT_MS,
  DISABLE_ENV,
  DesktopAttachError,
  RELAUNCH_ENV,
  TESTED_DESKTOP_BUILDS,
  applyPersisted,
  check,
  clientConnections,
  ensure,
  hostedByDesktop,
  launchAgentContents,
  parseEstablishedConnections,
  persist,
  persistencePath,
  persistenceReceiptPath,
  resolveRuntimeTarget,
  resolveRuntimeUrl,
  stableNodePath,
  unpersist,
};
