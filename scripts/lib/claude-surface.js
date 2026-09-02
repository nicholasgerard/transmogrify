'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { processBirth } = require('./state');
const { laneNameError } = require('./validation');

const VERIFIED_CLI_BUILDS = new Map([
  ['2.1.257', '64590d7d9d9c189d33fb3dfa58c5408eaf2a10fe556bd84155d95efaab46b60e'],
  ['2.1.258', 'b63136194160791c27cfa7b0403060d85eb0752991625fde8c09f9acacb17c78'],
]);
const PINNED_CLI_VERSION = '2.1.258';
const PINNED_CLI_SHA256 = VERIFIED_CLI_BUILDS.get(PINNED_CLI_VERSION);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_PATTERN = /^[0-9a-f]{8}$/i;
const BRIDGE_PATTERN = /^(?:session_|cse_)(?:staging_)?[0-9A-Za-z]{1,64}$/;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_STEER_BYTES = 64 * 1024;
const MAX_SPAWN_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_APPEND_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_SCAN_BYTES = 8 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const CLAUDE_ENV_KEYS = new Set([
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'USER',
]);

class ClaudeSurfaceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ClaudeSurfaceError';
    this.code = code;
    this.details = details;
  }
}

function sanitizedClaudeEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (!CLAUDE_ENV_KEYS.has(key) || typeof value !== 'string' || value.includes('\0')) continue;
    clean[key] = value;
  }
  // Managed lanes run the exact measured executable for their whole execution
  // epoch. This affects only Transmogrify's child processes and never changes
  // the user's Claude settings or global updater.
  clean.DISABLE_UPDATES = '1';
  return clean;
}

function isVerifiedCliBuild(version, cliSha256) {
  return VERIFIED_CLI_BUILDS.get(version) === cliSha256;
}

function canonicalCseId(bridgeId) {
  if (typeof bridgeId !== 'string' || !BRIDGE_PATTERN.test(bridgeId)) {
    throw new ClaudeSurfaceError('PROTOCOL_ERROR', 'invalid Claude bridge id');
  }
  return `cse_${bridgeId.replace(/^(?:session_|cse_)/, '')}`;
}

function assertSafeLaneValue(value, label = 'Claude lane name') {
  const problem = laneNameError(value, label);
  if (problem) {
    throw new ClaudeSurfaceError(
      'USAGE_ERROR',
      problem,
    );
  }
  return value;
}

function assertSafeModelSelector(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new ClaudeSurfaceError(
      'USAGE_ERROR',
      'Claude model must be a bounded alias or full first-party model name',
    );
  }
  return value;
}

function claudeSpawnArgs(name, prompt, options = {}) {
  assertSafeLaneValue(name);
  if (typeof prompt !== 'string' || !prompt || prompt.startsWith('-') ||
      prompt.includes('\0') || Buffer.byteLength(prompt) > MAX_SPAWN_BYTES) {
    throw new ClaudeSurfaceError(
      'USAGE_ERROR',
      `Claude spawn prompt must be non-empty, cannot begin with -, and cannot exceed ${MAX_SPAWN_BYTES} bytes`,
    );
  }
  const args = ['--bg', '--name', name, '--remote-control', name];
  if (options.model !== undefined) {
    args.push('--model', assertSafeModelSelector(options.model));
  }
  args.push(prompt);
  return args;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function assertSafeRegularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ClaudeSurfaceError('UNSAFE_LOCAL_STATE', `${label} is not a regular file`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new ClaudeSurfaceError('UNSAFE_LOCAL_STATE', `${label} belongs to another user`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new ClaudeSurfaceError('UNSAFE_LOCAL_STATE', `${label} is group/world writable`);
  }
  return stat;
}

function assertSafeDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o022) !== 0) {
    throw new ClaudeSurfaceError('UNSAFE_LOCAL_STATE', `${label} is not owner-controlled`);
  }
  return stat;
}

function readSafeJson(file, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_CAPTURE_BYTES ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        (stat.mode & 0o022) !== 0) {
      throw new ClaudeSurfaceError('UNSAFE_LOCAL_STATE', `${label} is not a safe bounded regular file`);
    }
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } catch (error) {
    if (error instanceof ClaudeSurfaceError) throw error;
    throw new ClaudeSurfaceError('INVALID_LOCAL_STATE', `${label} is not valid JSON`, {
      cause: error.message,
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseVersion(raw) {
  const match = String(raw).trim().match(/^(\d+\.\d+\.\d+)(?:\s|$)/);
  if (!match) throw new ClaudeSurfaceError('UNSUPPORTED_ENVIRONMENT', 'Claude CLI returned an invalid version');
  return match[1];
}

function validateAgentRow(agent, label = 'exact owned Claude agent row') {
  if (!agent || typeof agent !== 'object' ||
      typeof agent.sessionId !== 'string' || !UUID_PATTERN.test(agent.sessionId) ||
      typeof agent.name !== 'string' || typeof agent.cwd !== 'string' ||
      (agent.pid !== undefined && agent.pid !== null && (!Number.isInteger(agent.pid) || agent.pid < 1)) ||
      (agent.id !== undefined && (typeof agent.id !== 'string' || !JOB_PATTERN.test(agent.id))) ||
      (typeof agent.startedAt !== 'string' && !Number.isFinite(agent.startedAt))) {
    throw new ClaudeSurfaceError('PROTOCOL_ERROR', `${label} is invalid`);
  }
  if (agent.id !== undefined &&
      agent.sessionId.slice(0, 8).toLowerCase() !== agent.id.toLowerCase()) {
    throw new ClaudeSurfaceError('PROTOCOL_ERROR', `${label} job does not match session`);
  }
  return { ...agent, pid: agent.pid ?? null };
}

function parseAgents(raw) {
  let agents;
  try { agents = JSON.parse(raw); } catch {
    throw new ClaudeSurfaceError('PROTOCOL_ERROR', 'claude agents returned invalid JSON');
  }
  if (!Array.isArray(agents)) throw new ClaudeSurfaceError('PROTOCOL_ERROR', 'claude agents did not return an array');
  // The listing is account-wide. Keep every object row so a malformed or
  // future-version foreign row can still block a colliding short-id mutation.
  // Only the exact owned row is required to satisfy the full current schema.
  return agents
    .filter((agent) => agent && typeof agent === 'object' && !Array.isArray(agent))
    .map((agent) => ({ ...agent, pid: agent.pid ?? null }));
}

function parseJobId(raw) {
  const matches = [...String(raw).matchAll(/\b[0-9a-f]{8}\b/gi)].map((match) => match[0].toLowerCase());
  const unique = [...new Set(matches)];
  if (unique.length !== 1) {
    throw new ClaudeSurfaceError('SPAWN_UNCERTAIN', 'Claude spawn output did not contain one exact job id');
  }
  return unique[0];
}

function parseAuthStatus(raw) {
  let status;
  try { status = JSON.parse(raw); } catch {
    throw new ClaudeSurfaceError('UNSUPPORTED_ENVIRONMENT', 'Claude auth status returned invalid JSON');
  }
  if (status.loggedIn !== true || status.authMethod !== 'claude.ai' ||
      status.apiProvider !== 'firstParty' || typeof status.projectsDirectory !== 'string' ||
      !path.isAbsolute(status.projectsDirectory) || typeof status.orgId !== 'string' ||
      !status.orgId || typeof status.email !== 'string' || !status.email) {
    throw new ClaudeSurfaceError(
      'UNSUPPORTED_ENVIRONMENT',
      'Claude Remote Control requires first-party claude.ai OAuth authentication',
    );
  }
  return status;
}

function assertUniqueShortJobId(agents, identity) {
  if (!identity?.sessionId || !UUID_PATTERN.test(identity.sessionId) ||
      !identity?.jobId || !JOB_PATTERN.test(identity.jobId)) {
    throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'Claude provider identity is incomplete');
  }
  const jobId = identity.jobId.toLowerCase();
  const collisions = agents.filter((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const listedJob = typeof candidate.id === 'string' ? candidate.id.toLowerCase() : null;
    const sessionPrefix = typeof candidate.sessionId === 'string'
      ? candidate.sessionId.slice(0, 8).toLowerCase()
      : null;
    return listedJob === jobId || sessionPrefix === jobId;
  });
  if (collisions.length !== 1 || collisions[0].sessionId !== identity.sessionId) {
    throw new ClaudeSurfaceError(
      'OWNERSHIP_MISMATCH',
      'Claude short job id is not unique to the exact owned session',
    );
  }
  return jobId;
}

function exactOwnedAgent(agents, identity, expected = {}) {
  if (!identity?.sessionId || !identity?.jobId) {
    throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'Claude provider identity is incomplete');
  }
  const matches = agents.filter((agent) => agent.sessionId === identity.sessionId);
  if (matches.length !== 1) {
    throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'exact owned Claude session is not uniquely listed');
  }
  const agent = validateAgentRow(matches[0]);
  if (agent.sessionId.slice(0, 8).toLowerCase() !== identity.jobId.toLowerCase()) {
    throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'Claude job id no longer matches the owned session');
  }
  if (agent.id !== undefined && agent.id.toLowerCase() !== identity.jobId.toLowerCase()) {
    throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'Claude agent row id no longer matches the owned job');
  }
  assertUniqueShortJobId(agents, identity);
  if (expected.name !== undefined && agent.name !== expected.name) {
    throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'Claude session name no longer matches the lane');
  }
  if (expected.cwd !== undefined && fs.realpathSync(agent.cwd) !== fs.realpathSync(expected.cwd)) {
    throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'Claude session cwd no longer matches the lane seat');
  }
  return agent;
}

function execFilePromise(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      encoding: 'utf8',
      maxBuffer: MAX_CAPTURE_BYTES,
      timeout: DEFAULT_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      ...options,
    }, (error, stdout, stderr) => {
      if (error) {
        error.safeStderr = String(stderr || '').slice(0, 4096);
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function resolveCliPath(options, env, dependencies) {
  const requested = options.claudeBin || env.CLAUDE_BIN;
  let candidate = requested;
  if (!candidate) {
    candidate = dependencies.execFileSync('/usr/bin/which', ['claude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizedClaudeEnv(env),
      maxBuffer: MAX_CAPTURE_BYTES,
      timeout: DEFAULT_COMMAND_TIMEOUT_MS,
    }).trim();
  }
  if (!candidate || !path.isAbsolute(candidate)) {
    throw new ClaudeSurfaceError('UNSUPPORTED_ENVIRONMENT', 'Claude CLI must resolve to an absolute path');
  }
  const resolved = fs.realpathSync(candidate);
  const stat = assertSafeRegularFile(resolved, 'Claude CLI');
  if ((stat.mode & 0o111) === 0) {
    throw new ClaudeSurfaceError('UNSUPPORTED_ENVIRONMENT', 'Claude CLI is not executable');
  }
  return resolved;
}

function createClaudeSurface(dependencies = {}) {
  const deps = {
    arch: dependencies.arch || process.arch,
    execFile: dependencies.execFile || execFilePromise,
    execFileSync: dependencies.execFileSync || execFileSync,
    openCommand: dependencies.openCommand || '/usr/bin/open',
    platform: dependencies.platform || process.platform,
    processBirth: dependencies.processBirth || processBirth,
    sha256File: dependencies.sha256File || sha256File,
    spawn: dependencies.spawn || spawn,
  };

  function preflight(options = {}, env = process.env) {
    if (deps.platform !== 'darwin' || deps.arch !== 'arm64') {
      throw new ClaudeSurfaceError(
        'UNSUPPORTED_ENVIRONMENT',
        'the measured Claude adapter supports only Darwin arm64',
      );
    }
    if (env.CLAUDE_CONFIG_DIR) {
      throw new ClaudeSurfaceError('UNSUPPORTED_ENVIRONMENT', 'custom CLAUDE_CONFIG_DIR is outside the measured adapter');
    }
    const cleanEnv = sanitizedClaudeEnv(env);
    const cliPath = resolveCliPath(options, env, deps);
    const cliSha256 = deps.sha256File(cliPath);
    const version = parseVersion(deps.execFileSync(cliPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv,
      maxBuffer: MAX_CAPTURE_BYTES,
      timeout: DEFAULT_COMMAND_TIMEOUT_MS,
    }));
    if (!isVerifiedCliBuild(version, cliSha256)) {
      throw new ClaudeSurfaceError(
        'UNSUPPORTED_ENVIRONMENT',
        `unverified Claude CLI build ${version} (${cliSha256.slice(0, 12)})`,
      );
    }
    const auth = parseAuthStatus(deps.execFileSync(cliPath, ['auth', 'status', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv,
      maxBuffer: MAX_CAPTURE_BYTES,
      timeout: DEFAULT_COMMAND_TIMEOUT_MS,
    }));
    const requestedProjects = path.resolve(auth.projectsDirectory);
    const projectsDirectory = fs.realpathSync(requestedProjects);
    const requestedConfig = path.dirname(requestedProjects);
    const configDir = fs.realpathSync(requestedConfig);
    if (projectsDirectory !== requestedProjects || configDir !== requestedConfig) {
      throw new ClaudeSurfaceError('UNSAFE_LOCAL_STATE', 'Claude config path traverses a symlink');
    }
    const configStat = assertSafeDirectory(configDir, 'Claude config directory');
    const projectsStat = assertSafeDirectory(projectsDirectory, 'Claude projects directory');
    return {
      protocolGeneration: 1,
      platform: deps.platform,
      arch: deps.arch,
      cliPath,
      cliVersion: version,
      cliSha256,
      configDir,
      configDevice: configStat.dev,
      configInode: configStat.ino,
      projectsDirectory,
      projectsDevice: projectsStat.dev,
      projectsInode: projectsStat.ino,
      accountFingerprint: sha256(JSON.stringify({
        orgId: auth.orgId,
        email: auth.email,
        authMethod: auth.authMethod,
      })),
      orgId: auth.orgId,
      cleanEnv,
    };
  }

  async function agents(runtime) {
    const result = await deps.execFile(runtime.cliPath, ['agents', '--json', '--all'], {
      env: runtime.cleanEnv,
    });
    return parseAgents(result.stdout);
  }

  async function run(runtime, args, options = {}) {
    return deps.execFile(runtime.cliPath, args, {
      cwd: options.cwd,
      env: runtime.cleanEnv,
      timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    });
  }

  async function sendRemoteFollowup(runtime, bridgeId, content, options = {}) {
    const exactBridgeId = canonicalCseId(bridgeId);
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (typeof content !== 'string' || !content || content.includes('\0') ||
        /[\uD800-\uDFFF]/u.test(content) ||
        Buffer.byteLength(content) > MAX_STEER_BYTES) {
      throw new ClaudeSurfaceError(
        'USAGE_ERROR',
        `Claude follow-up must be non-empty UTF-8 without NUL and at most ${MAX_STEER_BYTES} bytes`,
      );
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new ClaudeSurfaceError('USAGE_ERROR', 'invalid Claude follow-up timeout');
    }
    return new Promise((resolve, reject) => {
      const child = deps.spawn(runtime.cliPath, [
        '-p', '--cloud', exactBridgeId, '--output-format', 'json',
      ], {
        cwd: options.cwd,
        env: runtime.cleanEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let spawned = false;
      let overflow = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill?.('SIGKILL');
        finish(() => reject(new ClaudeSurfaceError(
          'DELIVERY_UNCERTAIN',
          'Claude public follow-up outcome is unknown',
        )));
      }, timeoutMs);
      const collect = (chunks, which) => (chunk) => {
        const buffer = Buffer.from(chunk);
        if (which === 'stdout') stdoutBytes += buffer.length;
        else stderrBytes += buffer.length;
        if (stdoutBytes > MAX_CAPTURE_BYTES || stderrBytes > MAX_CAPTURE_BYTES) {
          overflow = true;
          child.kill?.('SIGKILL');
          return;
        }
        chunks.push(buffer);
      };
      child.stdout.on('data', collect(stdout, 'stdout'));
      child.stderr.on('data', collect(stderr, 'stderr'));
      child.once('spawn', () => {
        spawned = true;
        child.stdin.end(content, 'utf8');
      });
      child.stdin.on('error', () => {});
      child.once('error', () => finish(() => reject(new ClaudeSurfaceError(
        spawned ? 'DELIVERY_UNCERTAIN' : 'NOT_DELIVERED',
        spawned
          ? 'Claude public follow-up outcome is unknown'
          : 'Claude public follow-up process did not start',
      ))));
      child.once('close', (code, signal) => finish(() => {
        if (overflow) {
          reject(new ClaudeSurfaceError(
            'DELIVERY_UNCERTAIN',
            'Claude public follow-up output exceeded its bound',
          ));
          return;
        }
        const rawStdout = Buffer.concat(stdout, stdoutBytes).toString('utf8');
        const rawStderr = Buffer.concat(stderr, stderrBytes).toString('utf8');
        let acknowledgment;
        try { acknowledgment = JSON.parse(rawStdout); } catch {}
        const expectedUrl = `https://claude.ai/code/${exactBridgeId}`;
        const exactKeys = acknowledgment && typeof acknowledgment === 'object' &&
          !Array.isArray(acknowledgment) &&
          JSON.stringify(Object.keys(acknowledgment).sort()) ===
            JSON.stringify(['ok', 'session_id', 'url']);
        const exactSuccess = exactKeys && acknowledgment.ok === true &&
          acknowledgment.session_id === exactBridgeId && acknowledgment.url === expectedUrl;
        if (code === 0 && !signal && rawStderr === '' && exactSuccess) {
          resolve({
            queued: true,
            channel: 'publicCloudFollowup',
            sessionIdSha256: sha256(exactBridgeId),
            stdoutSha256: sha256(rawStdout),
            stderrSha256: sha256(rawStderr),
          });
          return;
        }
        reject(new ClaudeSurfaceError(
          'DELIVERY_UNCERTAIN',
          `Claude public follow-up outcome is unknown${signal ? ` (${signal})` : ''}`,
        ));
      }));
    });
  }

  async function launch(runtime, args, options) {
    const stdoutPath = options.stdoutPath;
    const stderrPath = options.stderrPath;
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new ClaudeSurfaceError('USAGE_ERROR', 'invalid Claude launch timeout');
    }
    const stdoutFd = fs.openSync(stdoutPath, 'wx', 0o600);
    let stderrFd;
    let child;
    try {
      stderrFd = fs.openSync(stderrPath, 'wx', 0o600);
      child = deps.spawn(runtime.cliPath, args, {
        cwd: options.cwd,
        env: runtime.cleanEnv,
        stdio: ['ignore', stdoutFd, stderrFd],
      });
    } finally {
      fs.closeSync(stdoutFd);
      if (stderrFd !== undefined) fs.closeSync(stderrFd);
    }
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill?.('SIGKILL');
        reject(new ClaudeSurfaceError('SPAWN_UNCERTAIN', 'Claude spawn command timed out'));
      }, timeoutMs);
      const settle = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      child.once('error', (error) => settle(() => reject(error)));
      child.once('close', (code, signal) => {
        if (code === 0) settle(resolve);
        else settle(() => reject(new ClaudeSurfaceError('SPAWN_UNCERTAIN', 'Claude spawn command did not exit cleanly', {
          code,
          signal,
        })));
      });
    });
    const stdoutStat = assertSafeRegularFile(stdoutPath, 'Claude spawn stdout receipt');
    const stderrStat = assertSafeRegularFile(stderrPath, 'Claude spawn stderr receipt');
    if (stdoutStat.size > MAX_CAPTURE_BYTES || stderrStat.size > MAX_CAPTURE_BYTES) {
      throw new ClaudeSurfaceError('SPAWN_UNCERTAIN', 'Claude spawn receipt exceeded the safe capture limit');
    }
    return {
      stdout: fs.readFileSync(stdoutPath, 'utf8'),
      stderr: fs.readFileSync(stderrPath, 'utf8'),
    };
  }

  function readWorkerMetadata(runtime, pid) {
    const file = path.join(runtime.configDir, 'sessions', `${pid}.json`);
    const raw = readSafeJson(file, 'Claude worker metadata');
    if (typeof raw.bridgeSessionId !== 'string' || raw.bridgeId !== undefined) {
      throw new ClaudeSurfaceError('PROTOCOL_ERROR', 'Claude worker metadata bridge shape is unverified');
    }
    const metadata = { ...raw, bridgeId: raw.bridgeSessionId };
    if (metadata.pid !== undefined && metadata.pid !== pid) {
      throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'Claude worker metadata PID does not match');
    }
    for (const [key, pattern] of [
      ['sessionId', UUID_PATTERN],
      ['jobId', JOB_PATTERN],
      ['bridgeId', BRIDGE_PATTERN],
    ]) {
      if (typeof metadata[key] !== 'string' || !pattern.test(metadata[key])) {
        throw new ClaudeSurfaceError('PROTOCOL_ERROR', `Claude worker metadata ${key} is invalid`);
      }
    }
    if (typeof metadata.name !== 'string' || typeof metadata.cwd !== 'string' ||
        typeof metadata.messagingSocketPath !== 'string' ||
        !path.isAbsolute(metadata.messagingSocketPath) ||
        metadata.messagingSocketPath !== `/tmp/cc-socks/${pid}.sock` ||
        metadata.version !== runtime.cliVersion) {
      throw new ClaudeSurfaceError('PROTOCOL_ERROR', 'Claude worker metadata shape is invalid');
    }
    return metadata;
  }

  function verifyWorkerExecutable(runtime, pid) {
    const output = deps.execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: runtime.cleanEnv,
      maxBuffer: MAX_CAPTURE_BYTES,
      timeout: DEFAULT_COMMAND_TIMEOUT_MS,
    });
    const matches = [];
    for (const line of output.split('\n')) {
      if (!line.startsWith('n') || !path.isAbsolute(line.slice(1))) continue;
      let resolved;
      try {
        resolved = fs.realpathSync(line.slice(1));
        if (!fs.statSync(resolved).isFile()) continue;
        if (deps.sha256File(resolved) === runtime.cliSha256) matches.push(resolved);
      } catch {}
      if (matches.length > 1) break;
    }
    if (matches.length !== 1) {
      throw new ClaudeSurfaceError('UNSUPPORTED_WORKER', 'cannot bind one pinned executable to the Claude worker');
    }
    return { path: matches[0], sha256: runtime.cliSha256 };
  }

  function socketReceipt(socketPath) {
    if (Buffer.byteLength(socketPath) > 100) {
      throw new ClaudeSurfaceError('UNSAFE_SOCKET', 'Claude messaging socket path is too long');
    }
    const parent = path.dirname(socketPath);
    const parentStat = fs.lstatSync(parent);
    const stat = fs.lstatSync(socketPath);
    const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || parentStat.uid !== uid ||
        (parentStat.mode & 0o077) !== 0) {
      throw new ClaudeSurfaceError('UNSAFE_SOCKET', 'Claude messaging socket directory is not owner-private');
    }
    if (stat.isSymbolicLink() || !stat.isSocket() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
      throw new ClaudeSurfaceError('UNSAFE_SOCKET', 'Claude messaging socket is not an owner-private Unix socket');
    }
    return {
      path: socketPath,
      device: stat.dev,
      inode: stat.ino,
      uid: stat.uid,
      mode: stat.mode & 0o7777,
    };
  }

  function executionReceipt(runtime, lane, agent) {
    if (!agent.pid) throw new ClaudeSurfaceError('INVALID_STATE', 'Claude session has no running worker');
    const metadata = readWorkerMetadata(runtime, agent.pid);
    const identity = lane.providerIdentity;
    if (metadata.sessionId !== identity.sessionId ||
        metadata.jobId.toLowerCase() !== identity.jobId.toLowerCase() ||
        metadata.bridgeId !== identity.bridgeId || metadata.name !== lane.displayName ||
        fs.realpathSync(metadata.cwd) !== fs.realpathSync(lane.seat.path)) {
      throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'Claude worker metadata does not match the owned lane');
    }
    return finishExecutionReceipt(runtime, agent, metadata);
  }

  function discoverExecution(runtime, expected, agent) {
    if (!agent.pid) throw new ClaudeSurfaceError('INVALID_STATE', 'Claude session has no running worker');
    const metadata = readWorkerMetadata(runtime, agent.pid);
    if (metadata.sessionId !== expected.sessionId ||
        metadata.jobId.toLowerCase() !== expected.jobId.toLowerCase() ||
        metadata.name !== expected.name ||
        fs.realpathSync(metadata.cwd) !== fs.realpathSync(expected.cwd)) {
      throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'Claude worker creation metadata does not match spawn intent');
    }
    return finishExecutionReceipt(runtime, agent, metadata);
  }

  function finishExecutionReceipt(runtime, agent, metadata) {
    const birth = deps.processBirth(agent.pid);
    if (!birth) throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'cannot establish Claude worker process identity');
    const worker = verifyWorkerExecutable(runtime, agent.pid);
    const socket = socketReceipt(metadata.messagingSocketPath);
    if (deps.processBirth(agent.pid) !== birth) {
      throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'Claude worker identity changed during verification');
    }
    return {
      pid: agent.pid,
      processBirth: birth,
      socket,
      bridgeId: metadata.bridgeId,
      worker,
    };
  }

  function findTranscript(projectsDirectory, sessionId) {
    const target = `${sessionId}.jsonl`;
    const matches = [];
    const pending = [projectsDirectory];
    let visited = 0;
    while (pending.length) {
      const directory = pending.pop();
      visited += 1;
      if (visited > 10_000) {
        throw new ClaudeSurfaceError('INVALID_LOCAL_STATE', 'Claude transcript directory traversal exceeded its bound');
      }
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) pending.push(candidate);
        else if (entry.isFile() && entry.name === target) matches.push(candidate);
      }
    }
    if (matches.length !== 1) {
      throw new ClaudeSurfaceError('DELIVERY_UNCERTAIN', 'exact owned Claude transcript is not uniquely available');
    }
    return matches[0];
  }

  function transcriptSnapshot(runtime, sessionId) {
    if (!UUID_PATTERN.test(sessionId || '')) throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'invalid owned session id');
    const file = findTranscript(runtime.projectsDirectory, sessionId);
    const stat = assertSafeRegularFile(file, 'owned Claude transcript');
    return { file, device: stat.dev, inode: stat.ino, offset: stat.size, sessionId };
  }

  function transcriptContent(record) {
    if (record?.type !== 'user' || record?.message?.role !== 'user') return null;
    const content = record.message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const texts = content.filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text);
    return texts.length === 1 ? texts[0] : null;
  }

  function transcriptObservation(record, sessionId, content) {
    if (record?.type === 'queue-operation' && record.operation === 'enqueue' &&
        record.sessionId === sessionId && record.content === content &&
        typeof record.timestamp === 'string') {
      return 'queuedObserved';
    }
    if (transcriptContent(record) === content &&
        (record.sessionId === undefined || record.sessionId === sessionId)) {
      return 'consumedObserved';
    }
    return null;
  }

  function openOwnedTranscript(snapshot) {
    const flags = fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW === undefined ? 0 : fs.constants.O_NOFOLLOW);
    let descriptor;
    try { descriptor = fs.openSync(snapshot.file, flags); } catch (error) {
      throw new ClaudeSurfaceError('DELIVERY_UNCERTAIN', 'cannot safely open the owned Claude transcript', {
        cause: error.code,
      });
    }
    const stat = fs.fstatSync(descriptor);
    const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o022) !== 0 ||
        stat.dev !== snapshot.device || stat.ino !== snapshot.inode) {
      fs.closeSync(descriptor);
      throw new ClaudeSurfaceError('DELIVERY_UNCERTAIN', 'owned Claude transcript identity changed');
    }
    return { descriptor, stat };
  }

  async function waitForTranscriptDelivery(snapshot, content, timeoutMs = 30_000) {
    if (!snapshot || !UUID_PATTERN.test(snapshot.sessionId || '')) {
      throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'Claude transcript snapshot has no exact session identity');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new ClaudeSurfaceError('USAGE_ERROR', 'invalid Claude transcript observation timeout');
    }
    const started = Date.now();
    let appendedBytes = 0;
    let trailing = '';
    let offset = snapshot.offset;
    while (Date.now() - started < timeoutMs) {
      const opened = openOwnedTranscript(snapshot);
      const { descriptor, stat } = opened;
      try {
        if (stat.size < offset) {
          throw new ClaudeSurfaceError('DELIVERY_UNCERTAIN', 'owned Claude transcript was truncated');
        }
        if (stat.size > offset) {
          const length = stat.size - offset;
          appendedBytes += length;
          if (length > MAX_TRANSCRIPT_APPEND_BYTES ||
              appendedBytes > MAX_TRANSCRIPT_APPEND_BYTES) {
            throw new ClaudeSurfaceError('DELIVERY_UNCERTAIN', 'owned Claude transcript append exceeded its bound');
          }
          const buffer = Buffer.alloc(length);
          const bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
          if (bytesRead !== length) {
            throw new ClaudeSurfaceError('DELIVERY_UNCERTAIN', 'owned Claude transcript changed while reading');
          }
          offset = stat.size;
          const lines = `${trailing}${buffer.toString('utf8')}`.split('\n');
          trailing = lines.pop();
          if (Buffer.byteLength(trailing, 'utf8') > MAX_TRANSCRIPT_APPEND_BYTES) {
            throw new ClaudeSurfaceError('DELIVERY_UNCERTAIN', 'owned Claude transcript line exceeded its bound');
          }
          for (const line of lines) {
            if (!line) continue;
            let record;
            try { record = JSON.parse(line); } catch {
              throw new ClaudeSurfaceError('DELIVERY_UNCERTAIN', 'owned Claude transcript appended invalid JSONL');
            }
            const state = transcriptObservation(record, snapshot.sessionId, content);
            if (state) {
              return { state, offset };
            }
          }
        }
      } finally {
        fs.closeSync(descriptor);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new ClaudeSurfaceError('DELIVERY_UNCERTAIN', 'queued Claude input was not observed in the owned transcript');
  }

  function verifySpawnTranscript(runtime, sessionId, expected) {
    if (!UUID_PATTERN.test(sessionId || '') || !expected ||
        typeof expected.promptSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expected.promptSha256) ||
        typeof expected.promptMarkerSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expected.promptMarkerSha256) ||
        !UUID_PATTERN.test(expected.spawnNonce || '')) {
      throw new ClaudeSurfaceError('SPAWN_UNCERTAIN', 'invalid Claude spawn transcript expectation');
    }
    const marker = `[transmogrify spawn ${expected.spawnNonce}]`;
    if (sha256(marker) !== expected.promptMarkerSha256) {
      throw new ClaudeSurfaceError('SPAWN_UNCERTAIN', 'Claude spawn marker receipt does not match its nonce');
    }
    const snapshot = transcriptSnapshot(runtime, sessionId);
    const opened = openOwnedTranscript(snapshot);
    const { descriptor, stat } = opened;
    try {
      if (stat.size > MAX_TRANSCRIPT_SCAN_BYTES) {
        throw new ClaudeSurfaceError('SPAWN_UNCERTAIN', 'Claude spawn transcript exceeded its scan bound');
      }
      const buffer = Buffer.alloc(stat.size);
      const bytesRead = fs.readSync(descriptor, buffer, 0, stat.size, 0);
      if (bytesRead !== stat.size) {
        throw new ClaudeSurfaceError('SPAWN_UNCERTAIN', 'Claude spawn transcript changed while reading');
      }
      const suffix = `\n\n${marker}`;
      let matches = 0;
      for (const line of buffer.toString('utf8').split('\n')) {
        if (!line) continue;
        let record;
        try { record = JSON.parse(line); } catch {
          throw new ClaudeSurfaceError('SPAWN_UNCERTAIN', 'Claude spawn transcript contains invalid JSONL');
        }
        const content = transcriptContent(record);
        if (typeof content !== 'string' || !content.endsWith(suffix)) continue;
        const originalPrompt = content.slice(0, -suffix.length);
        if (sha256(originalPrompt) === expected.promptSha256) matches += 1;
      }
      if (matches !== 1) {
        throw new ClaudeSurfaceError('SPAWN_UNCERTAIN', 'Claude spawn prompt is not uniquely receipted');
      }
      return {
        state: 'spawnPromptObserved',
        device: stat.dev,
        inode: stat.ino,
        offset: stat.size,
        promptSha256: expected.promptSha256,
        promptMarkerSha256: expected.promptMarkerSha256,
      };
    } finally {
      fs.closeSync(descriptor);
    }
  }

  function verifyDeliveryTranscript(runtime, sessionId, expected) {
    if (!UUID_PATTERN.test(sessionId || '') || !expected ||
        typeof expected.messageSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expected.messageSha256) ||
        !UUID_PATTERN.test(expected.deliveryToken || '')) {
      throw new ClaudeSurfaceError('DELIVERY_UNCERTAIN', 'invalid Claude delivery transcript expectation');
    }
    const suffix = `\n\n[transmogrify delivery ${expected.deliveryToken}]`;
    const snapshot = transcriptSnapshot(runtime, sessionId);
    const { descriptor, stat } = openOwnedTranscript(snapshot);
    try {
      if (stat.size > MAX_TRANSCRIPT_SCAN_BYTES) {
        throw new ClaudeSurfaceError('DELIVERY_UNCERTAIN', 'Claude delivery transcript exceeded its scan bound');
      }
      const buffer = Buffer.alloc(stat.size);
      const bytesRead = fs.readSync(descriptor, buffer, 0, stat.size, 0);
      if (bytesRead !== stat.size) {
        throw new ClaudeSurfaceError('DELIVERY_UNCERTAIN', 'Claude delivery transcript changed while reading');
      }
      let queued = 0;
      let consumed = 0;
      for (const line of buffer.toString('utf8').split('\n')) {
        if (!line) continue;
        let record;
        try { record = JSON.parse(line); } catch {
          throw new ClaudeSurfaceError('DELIVERY_UNCERTAIN', 'Claude delivery transcript contains invalid JSONL');
        }
        const isQueued = record?.type === 'queue-operation' && record.operation === 'enqueue' &&
          record.sessionId === sessionId && typeof record.content === 'string';
        const content = isQueued ? record.content : transcriptContent(record);
        if (typeof content !== 'string' || !content.endsWith(suffix)) continue;
        const message = content.slice(0, -suffix.length);
        if (sha256(message) !== expected.messageSha256) continue;
        if (isQueued) queued += 1;
        else consumed += 1;
      }
      if (queued > 1 || consumed > 1 || (queued === 0 && consumed === 0)) {
        throw new ClaudeSurfaceError('DELIVERY_UNCERTAIN', 'Claude queued delivery is not uniquely receipted');
      }
      return {
        state: consumed === 1 ? 'consumedObserved' : 'queuedObserved',
        device: stat.dev,
        inode: stat.ino,
        offset: stat.size,
        messageSha256: expected.messageSha256,
        deliveryTokenSha256: sha256(expected.deliveryToken),
      };
    } finally {
      fs.closeSync(descriptor);
    }
  }

  async function dispatchDeepLink(runtime, bridgeId) {
    canonicalCseId(bridgeId);
    await deps.execFile(deps.openCommand, [`claude://code/${bridgeId}`], { env: runtime.cleanEnv });
    return { state: 'deepLinkDispatched' };
  }

  return {
    agents,
    dispatchDeepLink,
    discoverExecution,
    exactOwnedAgent,
    executionReceipt,
    launch,
    preflight,
    run,
    sendRemoteFollowup,
    transcriptSnapshot,
    verifyDeliveryTranscript,
    verifySpawnTranscript,
    waitForTranscriptDelivery,
  };
}

module.exports = {
  BRIDGE_PATTERN,
  CLAUDE_ENV_KEYS,
  ClaudeSurfaceError,
  JOB_PATTERN,
  MAX_STEER_BYTES,
  PINNED_CLI_SHA256,
  PINNED_CLI_VERSION,
  VERIFIED_CLI_BUILDS,
  UUID_PATTERN,
  assertSafeLaneValue,
  assertSafeModelSelector,
  assertUniqueShortJobId,
  canonicalCseId,
  claudeSpawnArgs,
  createClaudeSurface,
  exactOwnedAgent,
  parseAgents,
  parseAuthStatus,
  parseJobId,
  parseVersion,
  isVerifiedCliBuild,
  sanitizedClaudeEnv,
  sha256,
};
