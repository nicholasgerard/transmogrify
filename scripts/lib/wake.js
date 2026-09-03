'use strict';

// Wake channels: how a parent's own session is re-invoked when a child needs
// it. A channel is discovered once, at parent-init, from the parent's own
// process or thread, and recorded with a verification receipt; delivery
// writes a short fixed template into that recorded session only. See
// docs/NOTIFICATIONS.md.

const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { AppServerClient, validateUrl } = require('./app-server');
const { readOwnedJson } = require('./record-guards');
const { createClaudeSurface } = require('./claude-surface');
const { VERSION } = require('./version');

const CHANNELS = Object.freeze(['claude-bridge', 'codex-thread', 'none']);
const BRIDGE_PATTERN = /^(?:session_|cse_)(?:staging_)?[0-9A-Za-z]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ANCESTRY_DEPTH = 12;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_LIST_PAGES = 20;
const SOURCE_KINDS = [
  'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown',
];

class WakeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WakeError';
    this.code = code;
    this.details = details;
  }
}

function parentPidOf(pid, run) {
  const raw = run('ps', ['-o', 'ppid=', '-p', String(pid)]).trim();
  return /^\d+$/.test(raw) ? Number(raw) : 0;
}

function defaultRun(executable, args) {
  return execFileSync(executable, args, {
    encoding: 'utf8', timeout: 3000, env: { PATH: '/usr/sbin:/usr/bin:/bin:/sbin' },
  });
}

// The Claude Code session this process runs inside, found by walking the
// process ancestry to the first pid that owns a session metadata record. The
// record must carry a Remote Control bridge id, which is the only public
// address a follow-up can be sent to. Anything else is `none` with a reason.
function discoverClaudeWake(options = {}, env = process.env) {
  const run = options.run || defaultRun;
  const configDir = options.configDir || path.join(env.HOME || os.homedir(), '.claude');
  let pid = options.startPid ?? process.ppid;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && pid > 1; depth += 1) {
    const file = path.join(configDir, 'sessions', `${pid}.json`);
    const read = readOwnedJson(file, { maxBytes: MAX_METADATA_BYTES, modeMask: 0o022 });
    if (read.status === 'ok') {
      const metadata = read.value;
      if (typeof metadata.bridgeSessionId !== 'string' || !BRIDGE_PATTERN.test(metadata.bridgeSessionId)) {
        return { channel: 'none', reason: 'session-without-remote-control' };
      }
      if (typeof metadata.sessionId !== 'string' || !UUID_PATTERN.test(metadata.sessionId)) {
        return { channel: 'none', reason: 'session-metadata-invalid' };
      }
      if (metadata.pid !== undefined && metadata.pid !== pid) {
        return { channel: 'none', reason: 'session-metadata-pid-mismatch' };
      }
      return {
        channel: 'claude-bridge',
        bridgeId: metadata.bridgeSessionId,
        sessionId: metadata.sessionId.toLowerCase(),
        receipt: {
          source: 'process-ancestry',
          depth,
          sessionPid: pid,
          observedAt: new Date().toISOString(),
        },
      };
    }
    if (read.status === 'unsafe' || read.status === 'invalid') {
      return { channel: 'none', reason: `session-metadata-${read.status}` };
    }
    pid = parentPidOf(pid, run);
  }
  return { channel: 'none', reason: 'no-claude-session-in-ancestry' };
}

// The Codex thread this process runs inside, identified on the shared runtime
// by an exact receipt: an active thread whose cwd is the repository and whose
// current items carry the caller's one-time nonce (the command line of the
// running parent-init). Without the nonce, a single active thread with that
// cwd is reported as a candidate only; the caller decides whether to trust it.
async function discoverCodexWake(options, env = process.env) {
  const url = validateUrl(options.url || env.TRANSMOGRIFY_URL ||
    `ws://127.0.0.1:${env.TRANSMOGRIFY_PORT || '8843'}`);
  const createClient = options.clientFactory || ((config) => new AppServerClient(config));
  const client = createClient({
    url,
    timeoutMs: options.timeoutMs ?? 15000,
    clientInfo: { name: 'transmogrify-wake', title: 'transmogrify wake discovery', version: VERSION },
  });
  try {
    const initialized = await client.connect();
    if (!client.verifiedRuntime) {
      return { channel: 'none', reason: 'runtime-unverified', userAgent: initialized?.userAgent };
    }
    const candidates = [];
    let cursor = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const response = await client.call('thread/list', {
        cursor, limit: 100, sourceKinds: SOURCE_KINDS,
      });
      for (const row of response?.data || []) {
        if (row?.cwd === options.repoRoot && row?.status?.type === 'active' && typeof row.id === 'string') {
          candidates.push(row);
        }
      }
      if (!response?.nextCursor) break;
      cursor = response.nextCursor;
    }
    if (candidates.length === 0) return { channel: 'none', reason: 'no-active-thread-with-repository-cwd' };
    if (options.nonce) {
      for (const row of candidates) {
        const items = await client.call('thread/items/list', { threadId: row.id, limit: 200 });
        const carriesNonce = (items?.data || []).some((entry) => {
          const item = entry?.item || entry;
          return item?.type === 'commandExecution' && typeof item.command === 'string' &&
            item.command.includes(options.nonce);
        });
        if (carriesNonce) {
          return {
            channel: 'codex-thread',
            threadId: row.id,
            cwd: row.cwd,
            receipt: { source: 'nonce-command-item', observedAt: new Date().toISOString() },
          };
        }
      }
      return { channel: 'none', reason: 'nonce-not-found-in-active-threads', candidates: candidates.length };
    }
    if (candidates.length === 1) {
      return {
        channel: 'codex-thread',
        threadId: candidates[0].id,
        cwd: candidates[0].cwd,
        receipt: { source: 'sole-active-thread-with-repository-cwd', observedAt: new Date().toISOString() },
        unverified: true,
      };
    }
    return { channel: 'none', reason: 'ambiguous-active-threads', candidates: candidates.length };
  } finally {
    client.close();
  }
}

// The fixed wake template. It names the child, the kind of event, and the
// exact next command; it never carries child output, prompts, or paths.
function wakeMessage(event, options = {}) {
  const kindText = {
    complete: 'completed its task and is idle (harvest now, steer again, or retire)',
    attention: 'needs your attention',
    terminal: `reached a terminal state (${String(event.type || '').replace(/^child\./, '')})`,
    progress: 'reported progress',
  }[event.kind] || 'changed state';
  const contextFile = options.parentContextFile ? ` --parent-context-file "${options.parentContextFile}"` : '';
  return [
    `[transmogrify] child lane ${event.child?.laneId || 'unknown'} ${kindText}.`,
    `Event ${event.type} (${event.kind}${event.terminal ? ', terminal' : ''}), dispatch ${event.dispatchId}, sequence ${event.sequence}.`,
    `Handle it, then acknowledge: node "$SKILL_ROOT/scripts/lane.js" wait${contextFile} --timeout-ms 0` +
      ` && node "$SKILL_ROOT/scripts/lane.js" ack${contextFile} --event ${event.eventId}`,
  ].join('\n');
}

// Deliver one wake into the parent's recorded channel. Claude: the public
// follow-up to the parent's own bridge. Codex: turn/steer into the parent's
// active turn, or turn/start when it is idle. Returns a receipt; throws
// WakeError with a stable code when the channel cannot be reached.
async function deliverWake(wake, text, options = {}, env = process.env) {
  if (wake?.channel === 'claude-bridge') {
    const surface = options.surface || createClaudeSurface();
    const runtime = surface.preflight({ claudeBin: options.claudeBin }, env);
    try {
      const result = await surface.sendRemoteFollowup(runtime, wake.bridgeId, text, {
        timeoutMs: options.timeoutMs ?? 30000,
      });
      return { channel: 'claude-bridge', delivered: true, sessionUrlOk: Boolean(result?.url), observedAt: new Date().toISOString() };
    } catch (error) {
      throw new WakeError(error.code === 'DELIVERY_UNCERTAIN' ? 'WAKE_UNCERTAIN' : 'WAKE_UNDELIVERED',
        `Claude wake follow-up failed: ${error.code || error.message}`, { cause: error.code });
    }
  }
  if (wake?.channel === 'codex-thread') {
    const url = validateUrl(options.url || env.TRANSMOGRIFY_URL ||
      `ws://127.0.0.1:${env.TRANSMOGRIFY_PORT || '8843'}`);
    const createClient = options.clientFactory || ((config) => new AppServerClient(config));
    const client = createClient({
      url,
      timeoutMs: options.timeoutMs ?? 30000,
      clientInfo: { name: 'transmogrify-wake', title: 'transmogrify wake', version: VERSION },
    });
    try {
      await client.connect();
      if (!client.verifiedRuntime) throw new WakeError('WAKE_UNDELIVERED', 'runtime is outside the verified line');
      const read = await client.call('thread/read', { threadId: wake.threadId, includeTurns: false });
      const thread = read?.thread || read;
      if (thread?.cwd !== wake.cwd) throw new WakeError('WAKE_UNDELIVERED', 'parent thread cwd changed', { cause: 'cwd-mismatch' });
      const turns = await client.call('thread/turns/list', { threadId: wake.threadId, limit: 1 }).catch(() => null);
      const newest = turns?.data?.[0];
      const input = [{ type: 'text', text }];
      if (newest?.status === 'inProgress') {
        await client.call('turn/steer', { threadId: wake.threadId, expectedTurnId: newest.id, input });
        return { channel: 'codex-thread', delivered: true, method: 'turn/steer', observedAt: new Date().toISOString() };
      }
      await client.call('turn/start', {
        threadId: wake.threadId, cwd: wake.cwd, input, clientUserMessageId: options.clientUserMessageId,
      });
      return { channel: 'codex-thread', delivered: true, method: 'turn/start', observedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof WakeError) throw error;
      throw new WakeError('WAKE_UNCERTAIN', `Codex wake failed: ${error.code || error.message}`, { cause: error.code });
    } finally {
      client.close();
    }
  }
  throw new WakeError('WAKE_UNAVAILABLE', 'the parent context has no wake channel');
}

module.exports = {
  CHANNELS,
  WakeError,
  deliverWake,
  discoverClaudeWake,
  discoverCodexWake,
  wakeMessage,
};
