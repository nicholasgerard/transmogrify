'use strict';

// Loopback listener inspection shared by the runtime launcher and the Desktop
// attachment tool: URL normalization, a bounded lsof query resolved only from
// the system directories, and a parser that refuses any non-loopback bind.

const path = require('node:path');
const { execFile } = require('node:child_process');
const { validateUrl } = require('./app-server');

const MAX_CAPTURE_BYTES = 64 * 1024;

// Listener inspection failure. USAGE_ERROR is a bad URL; UNSAFE_LISTENER is a
// wildcard or non-loopback bind; everything else is a tool failure.
class ListenerError extends Error {
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
    throw new ListenerError(
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
      throw new ListenerError('lsof returned an unverified listener shape');
    }
    for (const name of listener.names) {
      if (name !== `127.0.0.1:${port}` && name !== `[::1]:${port}`) {
        throw new ListenerError(
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
        reject(new ListenerError(`${path.basename(executable)} failed while inspecting the runtime`));
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

module.exports = {
  ListenerError,
  SYSTEM_TOOL_PATH,
  execFileResult,
  inspectListeners,
  normalizeListenUrl,
  parseLsofListeners,
};
