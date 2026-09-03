'use strict';

// Measured Claude Code CLI surface: the pinned executable, the sanitized child
// environment, argument construction, agent-listing ownership checks, worker and
// socket execution receipts, and JSONL transcript proof of delivery. Every
// command runs against the exact verified build and every observation is tied to
// one owned session. It never touches a session other than the exact owned one
// and never changes the user's Claude configuration or global updater.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { processBirth } = require('./state');
const { ownedLaneNameError } = require('./validation');
const { readOwnedJson } = require('./record-guards');

// The CLI builds this adapter has been measured against, by version and SHA-256.
// A build outside this map cannot host a managed lane.
const VERIFIED_CLI_BUILDS = new Map([
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

// Surface failure carrying a stable code. Adapters map these straight onto their
// own delivery projections, so a code must stay honest about whether a provider
// mutation may already have happened.
class ClaudeSurfaceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ClaudeSurfaceError';
    this.code = code;
    this.details = details;
  }
}

// The only environment a managed Claude child sees: an allowlisted subset of the
// caller's variables, with NUL-bearing values dropped.
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

// Normalize a bridge id to its cse_ form. An id outside the accepted shape is
// PROTOCOL_ERROR, so no unvalidated value reaches a URL or a CLI argument.
// The CLI's acknowledgement URL names the bridge in either prefix form
// (`session_` or `cse_`, live 2.1.258 prints the former) and may carry query
// parameters (`?from=cli&m=0`); it names the exact bridge when the path is
// `/code/<id>` on claude.ai and the canonical id matches.
function followupUrlNamesBridge(url, exactBridgeId) {
  if (typeof url !== 'string') return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.origin !== 'https://claude.ai') return false;
  const match = /^\/code\/([^/]+)$/.exec(parsed.pathname);
  if (!match || !BRIDGE_PATTERN.test(match[1])) return false;
  return canonicalCseId(match[1]) === exactBridgeId;
}

function canonicalCseId(bridgeId) {
  if (typeof bridgeId !== 'string' || !BRIDGE_PATTERN.test(bridgeId)) {
    throw new ClaudeSurfaceError('PROTOCOL_ERROR', 'invalid Claude bridge id');
  }
  return `cse_${bridgeId.replace(/^(?:session_|cse_)/, '')}`;
}

function assertSafeLaneValue(value, label = 'Claude lane name') {
  const problem = ownedLaneNameError(value, label);
  if (problem) {
    throw new ClaudeSurfaceError(
      'USAGE_ERROR',
      problem,
    );
  }
  return value;
}

// A model selector must be a bounded alias or first-party model name, so it can
// never be read as a CLI flag.
function assertSafeModelSelector(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new ClaudeSurfaceError(
      'USAGE_ERROR',
      'Claude model must be a bounded alias or full first-party model name',
    );
  }
  return value;
}

// Append the resolved model, effort, and fast-mode controls. An effort level
// outside the measured set, or a non-boolean fast mode, is USAGE_ERROR rather
// than an argument passed through unchecked.
function appendExecutionArgs(args, options = {}) {
  if (options.model !== undefined && options.model !== null) {
    args.push('--model', assertSafeModelSelector(options.model));
  }
  if (options.effort !== undefined && options.effort !== null) {
    if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'].includes(options.effort)) {
      throw new ClaudeSurfaceError(
        'USAGE_ERROR',
        'Claude effort is not supported as a model level or execution setting',
      );
    }
    args.push('--effort', options.effort);
  }
  if (options.fastMode !== undefined && typeof options.fastMode !== 'boolean') {
    throw new ClaudeSurfaceError('USAGE_ERROR', 'Claude fast mode must be boolean');
  }
  if (options.settingsFile !== undefined) {
    // One settings file carries every setting the lane pins (fast mode and
    // its hooks); the CLI accepts a single --settings.
    if (typeof options.settingsFile !== 'string' || !path.isAbsolute(options.settingsFile)) {
      throw new ClaudeSurfaceError('USAGE_ERROR', 'Claude settings file must be an absolute path');
    }
    args.push('--settings', options.settingsFile);
  } else if (options.fastMode !== undefined) {
    args.push('--settings', JSON.stringify({ fastMode: options.fastMode }));
  }
  return args;
}

// The exact spawn argv: background, named, remote-controlled, prompt last. A
// prompt that is empty, oversized, NUL-bearing, or starts with a dash is refused
// so it can never be parsed as a flag.
function claudeSpawnArgs(name, prompt, options = {}) {
  assertSafeLaneValue(name);
  if (typeof prompt !== 'string' || !prompt || prompt.startsWith('-') ||
      prompt.includes('\0') || Buffer.byteLength(prompt) > MAX_SPAWN_BYTES) {
    throw new ClaudeSurfaceError(
      'USAGE_ERROR',
      `Claude spawn prompt must be non-empty, cannot begin with -, and cannot exceed ${MAX_SPAWN_BYTES} bytes`,
    );
  }
  const args = appendExecutionArgs(
    ['--bg', '--name', name, '--remote-control', name],
    options,
  );
  args.push(prompt);
  return args;
}

// The exact resume argv for one session id, with the lane's pinned execution
// controls reapplied.
function claudeResumeArgs(sessionId, options = {}) {
  if (typeof sessionId !== 'string' || !UUID_PATTERN.test(sessionId)) {
    throw new ClaudeSurfaceError('USAGE_ERROR', 'Claude resume session id must be a UUID');
  }
  return appendExecutionArgs(['--resume', sessionId.toLowerCase(), '--bg'], options);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

// A file this surface reads or executes must be a non-symlinked regular file
// owned by this user with no group or world write bits.
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

// The directory form of the same owner-controlled check.
function assertSafeDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o022) !== 0) {
    throw new ClaudeSurfaceError('UNSAFE_LOCAL_STATE', `${label} is not owner-controlled`);
  }
  return stat;
}

// Read a bounded owner-controlled JSON file through an O_NOFOLLOW descriptor and
// stat that descriptor, so a symlink swapped in between check and read cannot
// redirect it.
function readSafeJson(file, label) {
  const read = readOwnedJson(file, { maxBytes: MAX_CAPTURE_BYTES, modeMask: 0o022 });
  if (read.status === 'ok') return read.value;
  if (read.status === 'unsafe') {
    throw new ClaudeSurfaceError('UNSAFE_LOCAL_STATE', `${label} is not a safe bounded regular file`);
  }
  throw new ClaudeSurfaceError('INVALID_LOCAL_STATE', `${label} is not valid JSON`, { cause: read.cause });
}

function parseVersion(raw) {
  const match = String(raw).trim().match(/^(\d+\.\d+\.\d+)(?:\s|$)/);
  if (!match) throw new ClaudeSurfaceError('UNSUPPORTED_ENVIRONMENT', 'Claude CLI returned an invalid version');
  return match[1];
}

// Shape gate for one agent row, including the rule that a listed job id is the
// session's first eight hex characters. A missing pid normalizes to null.
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

// The single eight-hex job id in the launch output. Zero or several is
// SPAWN_UNCERTAIN, because an ambiguous launch must never be adopted.
function parseJobId(raw) {
  const matches = [...String(raw).matchAll(/\b[0-9a-f]{8}\b/gi)].map((match) => match[0].toLowerCase());
  const unique = [...new Set(matches)];
  if (unique.length !== 1) {
    throw new ClaudeSurfaceError('SPAWN_UNCERTAIN', 'Claude spawn output did not contain one exact job id');
  }
  return unique[0];
}

// Require first-party claude.ai OAuth with a projects directory, organization,
// and account. Any other provider or auth method is outside this adapter.
function parseAuthStatus(raw) {
  let status;
  try { status = JSON.parse(raw); } catch {
    throw new ClaudeSurfaceError('UNSUPPORTED_ENVIRONMENT', 'Claude auth status returned invalid JSON', {
      reason: 'auth-status-unreadable',
    });
  }
  if (!status || typeof status !== 'object' || status.loggedIn !== true) {
    throw new ClaudeSurfaceError(
      'UNSUPPORTED_ENVIRONMENT',
      'Claude CLI is not logged in; run claude auth login',
      { reason: 'not-logged-in' },
    );
  }
  if (status.loggedIn !== true || status.authMethod !== 'claude.ai' ||
      status.apiProvider !== 'firstParty' || typeof status.projectsDirectory !== 'string' ||
      !path.isAbsolute(status.projectsDirectory) || typeof status.orgId !== 'string' ||
      !status.orgId || typeof status.email !== 'string' || !status.email) {
    throw new ClaudeSurfaceError(
      'UNSUPPORTED_ENVIRONMENT',
      'Claude Remote Control requires first-party claude.ai OAuth authentication',
      { reason: 'account-not-first-party' },
    );
  }
  return status;
}

// The lane's eight-character job id must match exactly one row across the whole
// account, and that row must be the owned session. A collision is
// OWNERSHIP_MISMATCH, so a short-id command can never reach a stranger.
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

// The one agent row for the owned session, proven against the session id, the
// job id, the account-wide short-id uniqueness rule, and the lane's expected
// name and realpath seat. Anything else is OWNERSHIP_MISMATCH.
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

// Bounded child execution with a hard timeout and SIGKILL, attaching at most the
// safe stderr prefix to the rejected error.
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

// Resolve the Claude CLI to an absolute realpath and require it to be an
// owner-controlled executable regular file.
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
    throw new ClaudeSurfaceError('UNSUPPORTED_ENVIRONMENT', 'Claude CLI must resolve to an absolute path', {
      reason: 'cli-not-found',
    });
  }
  const resolved = fs.realpathSync(candidate);
  const stat = assertSafeRegularFile(resolved, 'Claude CLI');
  if ((stat.mode & 0o111) === 0) {
    throw new ClaudeSurfaceError('UNSUPPORTED_ENVIRONMENT', 'Claude CLI is not executable', {
      reason: 'cli-not-executable',
    });
  }
  return resolved;
}

// Build the Claude CLI surface. Every process, filesystem, and hashing
// dependency is injectable, so the ownership and fail-closed paths are testable
// without a live CLI.
function createClaudeSurface(dependencies = {}) {
  const deps = {
    arch: dependencies.arch || process.arch,
    execFile: dependencies.execFile || execFilePromise,
    execFileSync: dependencies.execFileSync || execFileSync,
    openCommand: dependencies.openCommand || '/usr/bin/open',
    platform: dependencies.platform || process.platform,
    processBirth: dependencies.processBirth || processBirth,
    sha256File: dependencies.sha256File || sha256File,
    socketReceipt: dependencies.socketReceipt || null,
    spawn: dependencies.spawn || spawn,
  };

  // The CLI must still be the exact realpath and digest measured at preflight. Any
  // change is RUNTIME_MISMATCH and no command is run.
  function assertRuntimeCliIdentity(runtime) {
    if (!runtime || typeof runtime.cliPath !== 'string' || !path.isAbsolute(runtime.cliPath) ||
        typeof runtime.cliSha256 !== 'string') {
      throw new ClaudeSurfaceError('RUNTIME_MISMATCH', 'Claude runtime CLI identity is incomplete');
    }
    let resolved;
    try { resolved = fs.realpathSync(runtime.cliPath); } catch {
      throw new ClaudeSurfaceError('RUNTIME_MISMATCH', 'Claude runtime CLI is no longer available');
    }
    if (resolved !== runtime.cliPath) {
      throw new ClaudeSurfaceError('RUNTIME_MISMATCH', 'Claude runtime CLI path changed after preflight');
    }
    const stat = assertSafeRegularFile(resolved, 'Claude CLI');
    if ((stat.mode & 0o111) === 0 || deps.sha256File(resolved) !== runtime.cliSha256) {
      throw new ClaudeSurfaceError('RUNTIME_MISMATCH', 'Claude runtime CLI changed after preflight');
    }
  }

  // Measure the compatibility tuple: Darwin arm64, a verified CLI build,
  // first-party claude.ai auth, and symlink-free owner-controlled config and
  // projects directories. The CLI digest is re-read afterwards so a swap during
  // preflight is caught, and a custom CLAUDE_CONFIG_DIR is refused outright.
  function preflight(options = {}, env = process.env) {
    if (deps.platform !== 'darwin' || deps.arch !== 'arm64') {
      throw new ClaudeSurfaceError(
        'UNSUPPORTED_ENVIRONMENT',
        'the measured Claude adapter supports only Darwin arm64',
        { reason: 'unsupported-platform' },
      );
    }
    if (env.CLAUDE_CONFIG_DIR) {
      throw new ClaudeSurfaceError('UNSUPPORTED_ENVIRONMENT', 'custom CLAUDE_CONFIG_DIR is outside the measured adapter', {
        reason: 'custom-config-dir',
      });
    }
    const cleanEnv = sanitizedClaudeEnv(env);
    const timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new ClaudeSurfaceError('USAGE_ERROR', 'invalid Claude preflight timeout');
    }
    const deadline = Date.now() + timeoutMs;
    const remainingMs = () => Math.max(1, deadline - Date.now());
    const cliPath = resolveCliPath(options, env, deps);
    const cliSha256 = deps.sha256File(cliPath);
    const version = parseVersion(deps.execFileSync(cliPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv,
      maxBuffer: MAX_CAPTURE_BYTES,
      timeout: remainingMs(),
    }));
    if (!isVerifiedCliBuild(version, cliSha256)) {
      throw new ClaudeSurfaceError(
        'UNSUPPORTED_ENVIRONMENT',
        `unverified Claude CLI build ${version} (${cliSha256.slice(0, 12)})`,
        { reason: 'cli-unpinned' },
      );
    }
    const auth = parseAuthStatus(deps.execFileSync(cliPath, ['auth', 'status', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv,
      maxBuffer: MAX_CAPTURE_BYTES,
      timeout: remainingMs(),
    }));
    if (deps.sha256File(cliPath) !== cliSha256) {
      throw new ClaudeSurfaceError('RUNTIME_MISMATCH', 'Claude CLI changed during preflight');
    }
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

  // The account-wide agent listing, under a bounded timeout and a re-verified CLI.
  async function agents(runtime, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new ClaudeSurfaceError('USAGE_ERROR', 'invalid Claude agent-list timeout');
    }
    assertRuntimeCliIdentity(runtime);
    const result = await deps.execFile(runtime.cliPath, ['agents', '--json', '--all'], {
      env: runtime.cleanEnv,
      timeout: timeoutMs,
    });
    return parseAgents(result.stdout);
  }

  // One CLI invocation with the lane's seat as cwd and the sanitized environment.
  async function run(runtime, args, options = {}) {
    assertRuntimeCliIdentity(runtime);
    return deps.execFile(runtime.cliPath, args, {
      cwd: options.cwd,
      env: runtime.cleanEnv,
      timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    });
  }

  // Queue a follow-up on the exact bridge session over the public cloud channel.
  // Only an exactly shaped acknowledgment with a clean exit, empty stderr, and the
  // matching session id and URL counts as queued. A process that never started is
  // NOT_DELIVERED; every other outcome is DELIVERY_UNCERTAIN, because the provider
  // may already hold the message.
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
    assertRuntimeCliIdentity(runtime);
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
        const exactKeys = acknowledgment && typeof acknowledgment === 'object' &&
          !Array.isArray(acknowledgment) &&
          JSON.stringify(Object.keys(acknowledgment).sort()) ===
            JSON.stringify(['ok', 'session_id', 'url']);
        const exactSuccess = exactKeys && acknowledgment.ok === true &&
          acknowledgment.session_id === exactBridgeId &&
          followupUrlNamesBridge(acknowledgment.url, exactBridgeId);
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

  // Launch the CLI with stdout and stderr captured to exclusive 0600 receipt
  // files. A non-zero exit, a timeout, or an unsafe or oversized receipt is
  // SPAWN_UNCERTAIN, and the receipts stay on disk for reconciliation.
  async function launch(runtime, args, options) {
    const stdoutPath = options.stdoutPath;
    const stderrPath = options.stderrPath;
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new ClaudeSurfaceError('USAGE_ERROR', 'invalid Claude launch timeout');
    }
    assertRuntimeCliIdentity(runtime);
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

  // The worker's own session metadata, keyed by pid. It requires the measured
  // bridge field shape, an agreeing pid, valid session, job, and bridge ids, the
  // exact per-pid socket path, and the runtime's CLI version.
  function readWorkerMetadata(runtime, pid) {
    const file = path.join(runtime.configDir, 'sessions', `${pid}.json`);
    const raw = readSafeJson(file, 'Claude worker metadata');
    if (raw.bridgeId !== undefined) {
      throw new ClaudeSurfaceError('PROTOCOL_ERROR', 'Claude worker metadata bridge shape is unverified');
    }
    if (typeof raw.bridgeSessionId !== 'string') {
      // The worker started but never registered Remote Control, which in every
      // measured case meant the CLI login was broken at launch.
      throw new ClaudeSurfaceError(
        'REMOTE_CONTROL_UNAVAILABLE',
        'Claude worker has no Remote Control bridge; the session did not register (check claude auth status and the session log)',
      );
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

  // Time left in the worker verification deadline; exhaustion is TIMEOUT.
  function remainingReceiptMs(deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new ClaudeSurfaceError('TIMEOUT', 'Claude worker verification exceeded its deadline');
    }
    return Math.max(1, remaining);
  }

  // Bind exactly one open text-segment file of the worker process to the pinned
  // CLI digest. Zero or several matches is UNSUPPORTED_WORKER, so a command is
  // never sent to a process running a different build.
  function verifyWorkerExecutable(runtime, pid, deadline) {
    const output = deps.execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: runtime.cleanEnv,
      maxBuffer: MAX_CAPTURE_BYTES,
      timeout: remainingReceiptMs(deadline),
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

  // The worker's messaging socket must be an owner-private Unix socket inside an
  // owner-private directory. Its device, inode, uid, and mode become part of the
  // execution epoch identity.
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

  // The execution receipt for a lane's running worker, requiring the worker's own
  // metadata to match the lane's session, job, bridge, name, and seat.
  function executionReceipt(runtime, lane, agent, options = {}) {
    if (!agent.pid) throw new ClaudeSurfaceError('INVALID_STATE', 'Claude session has no running worker');
    const metadata = readWorkerMetadata(runtime, agent.pid);
    const identity = lane.providerIdentity;
    if (metadata.sessionId !== identity.sessionId ||
        metadata.jobId.toLowerCase() !== identity.jobId.toLowerCase() ||
        metadata.bridgeId !== identity.bridgeId || metadata.name !== lane.displayName ||
        fs.realpathSync(metadata.cwd) !== fs.realpathSync(lane.seat.path)) {
      throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'Claude worker metadata does not match the owned lane');
    }
    return finishExecutionReceipt(runtime, agent, metadata, options);
  }

  // The same receipt during spawn or recovery, matched against the intended
  // session identity rather than an already-bound lane.
  function discoverExecution(runtime, expected, agent, options = {}) {
    if (!agent.pid) throw new ClaudeSurfaceError('INVALID_STATE', 'Claude session has no running worker');
    const metadata = readWorkerMetadata(runtime, agent.pid);
    if (metadata.sessionId !== expected.sessionId ||
        metadata.jobId.toLowerCase() !== expected.jobId.toLowerCase() ||
        metadata.name !== expected.name ||
        fs.realpathSync(metadata.cwd) !== fs.realpathSync(expected.cwd)) {
      throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'Claude worker creation metadata does not match spawn intent');
    }
    return finishExecutionReceipt(runtime, agent, metadata, options);
  }

  // Complete an execution receipt: process birth, the pinned worker executable,
  // and the socket identity. Process birth is read again afterwards, so a worker
  // replaced mid-verification is OWNERSHIP_MISMATCH.
  function finishExecutionReceipt(runtime, agent, metadata, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new ClaudeSurfaceError('USAGE_ERROR', 'invalid Claude worker verification timeout');
    }
    const deadline = Date.now() + timeoutMs;
    const birth = deps.processBirth(agent.pid, { timeoutMs: remainingReceiptMs(deadline) });
    if (!birth) throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'cannot establish Claude worker process identity');
    const worker = verifyWorkerExecutable(runtime, agent.pid, deadline);
    const socket = deps.socketReceipt
      ? deps.socketReceipt(metadata.messagingSocketPath)
      : socketReceipt(metadata.messagingSocketPath);
    if (deps.processBirth(agent.pid, { timeoutMs: remainingReceiptMs(deadline) }) !== birth) {
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

  // The one transcript file for a session under the projects directory, following
  // no symlinks and within a bounded traversal. Zero or several matches is
  // DELIVERY_UNCERTAIN.
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

  // The transcript's identity and current size: the baseline every delivery
  // observation reads forward from.
  function transcriptSnapshot(runtime, sessionId) {
    if (!UUID_PATTERN.test(sessionId || '')) throw new ClaudeSurfaceError('OWNERSHIP_MISMATCH', 'invalid owned session id');
    const file = findTranscript(runtime.projectsDirectory, sessionId);
    const stat = assertSafeRegularFile(file, 'owned Claude transcript');
    return { file, device: stat.dev, inode: stat.ino, offset: stat.size, sessionId };
  }

  // The single user text of a transcript record, or null. A multi-part or non-user
  // record is deliberately not treated as one message.
  function transcriptContent(record) {
    if (record?.type !== 'user' || record?.message?.role !== 'user') return null;
    const content = record.message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const texts = content.filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text);
    return texts.length === 1 ? texts[0] : null;
  }

  // The message that precedes a delivery marker, with the CLI's peer-message
  // prefix removed when present. Returns every candidate the caller may hash.
  const PEER_MESSAGE_PREFIX = /^Another Claude session sent a message:\s*/u;
  function framedMessageCandidates(content, suffix) {
    if (typeof content !== 'string') return [];
    const first = content.indexOf(suffix);
    if (first < 0 || first !== content.lastIndexOf(suffix)) return [];
    const segment = content.slice(0, first);
    const stripped = segment.replace(PEER_MESSAGE_PREFIX, '');
    return stripped === segment ? [segment] : [segment, stripped];
  }

  // Open the transcript with O_NOFOLLOW and require the descriptor's device and
  // inode to equal the snapshot's, so a rotated or replaced file is
  // DELIVERY_UNCERTAIN rather than read as the same transcript.
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

  // Prove the spawn prompt landed in the session's own transcript: exactly one
  // record ending with this lane's spawn marker whose prefix hashes to the
  // journaled prompt digest. Anything else is SPAWN_UNCERTAIN.
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
      if (matches === 0) {
        // The session may not have written its first message yet; the caller
        // retries inside a bounded window before treating this as uncertain.
        throw new ClaudeSurfaceError('TRANSCRIPT_RECEIPT_PENDING', 'Claude spawn prompt is not receipted in the transcript yet');
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

  // Prove a steer landed: exactly one queued or consumed record ending with this
  // delivery token whose prefix hashes to the journaled message. Duplicates, or no
  // match at all, is DELIVERY_UNCERTAIN.
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
        const candidates = framedMessageCandidates(content, suffix);
        if (!candidates.some((message) => sha256(message) === expected.messageSha256)) continue;
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

  // Open the Remote Control deep link for the exact bridge session so the lane
  // becomes visible natively. Presentation only; it sends no input.
  async function dispatchDeepLink(runtime, bridgeId, options = {}) {
    canonicalCseId(bridgeId);
    await deps.execFile(deps.openCommand, [`claude://code/${bridgeId}`], {
      env: runtime.cleanEnv,
      timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    });
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
  };
}

module.exports = {
  BRIDGE_PATTERN,
  MAX_STEER_BYTES,
  PINNED_CLI_SHA256,
  PINNED_CLI_VERSION,
  VERIFIED_CLI_BUILDS,
  assertSafeLaneValue,
  assertSafeModelSelector,
  assertUniqueShortJobId,
  canonicalCseId,
  claudeResumeArgs,
  claudeSpawnArgs,
  createClaudeSurface,
  exactOwnedAgent,
  parseAgents,
  parseAuthStatus,
  parseJobId,
  parseVersion,
  sanitizedClaudeEnv,
  sha256,
};
