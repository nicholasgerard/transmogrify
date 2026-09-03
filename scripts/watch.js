#!/usr/bin/env node
'use strict';

// The watcher: one long-lived process per parent context that observes every
// outstanding child continuously, records the durable events `wait` would
// record, and wakes the parent through its recorded channel when a child
// completes, needs attention, or ends. Started detached by `spawn` when it is
// not already running; exits on its own when the parent has no outstanding
// children or its context disappears. It never trusts a child's claims: every
// event comes from the same observation path as `wait`. See
// docs/NOTIFICATIONS.md.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');
const {
  countEvents, kindForEvent, listDispatches, listEvents, loadParentContext, pathsFor,
} = require('./lib/dispatch');
const { observeParentChildren, resolveDispatchLane } = require('./lib/observe');
const { processBirth, processMatches } = require('./lib/state');
const { deliverWake, wakeMessage } = require('./lib/wake');
const { sleep } = require('./lib/async');
const { EXIT, exitCodeForError, failureBody, usageError } = require('./lib/public-error');
const { publicResult } = require('./lib/output-schema');

const ACTIVE_POLL_MS = 2_000;
const QUIET_POLL_MS = 5_000;
const OBSERVATION_ROUND_MS = 30_000;
const DEFAULT_IDLE_EXIT_MS = 6 * 60 * 60 * 1000;
const WAKE_KINDS = new Set(['complete', 'attention', 'terminal']);
const MAX_LOG_BYTES = 1024 * 1024;

const HELP = `usage: watch.js --parent-context-file <absolute> [options]

options:
  --repo-root <absolute>        observe only children of this repository
  --url <loopback-ws-url>       Codex app-server endpoint (or TRANSMOGRIFY_URL)
  --claude-bin <absolute>       exact Claude CLI executable
  --idle-exit-ms <ms>           exit after this long with no outstanding child (default ${DEFAULT_IDLE_EXIT_MS})
  --detach                      start a detached watcher for this parent and return
  --status                      report whether a watcher is running for this parent

The watcher observes every outstanding child of the parent, records the same
durable events wait records, and wakes the parent through its recorded wake
channel when a child completes, needs attention, or ends. It never spawns,
steers, stops, harvests, or acknowledges anything.

exit codes (shared by every Transmogrify command):
  0  the watcher ran to its idle exit, was already running, or was started
  2  usage error
  3  the watcher could not run (lock, parent context, or observation failure)
  1  unexpected internal error`;

function watcherPaths(parentRef, env) {
  const root = path.join(pathsFor(env).root, 'watchers');
  return { root, record: path.join(root, `${parentRef}.json`), log: path.join(root, `${parentRef}.log`) };
}

function readRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The running watcher for a parent, if its recorded pid is alive with the
// recorded process birth. A stale record (dead pid, recycled pid) is ignored.
function runningWatcher(parentRef, env, dependencies = {}) {
  const paths = watcherPaths(parentRef, env);
  const record = readRecord(paths.record);
  if (!record || !processMatches(record, dependencies)) return null;
  return record;
}

function writeRecord(paths, record) {
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const temporary = `${paths.record}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, paths.record);
}

function appendLog(paths, line) {
  try {
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    if (fs.existsSync(paths.log) && fs.statSync(paths.log).size > MAX_LOG_BYTES) {
      fs.renameSync(paths.log, `${paths.log}.1`);
    }
    fs.appendFileSync(paths.log, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    // A log that cannot be written never stops observation.
  }
}

// Start a detached watcher for the parent unless one is already running.
// Returns what a caller may print: whether a watcher runs and whether this
// call started it. The child owns its own session and stdio; the parent
// process never waits for it.
function ensureWatcher(parentContextFile, options = {}, env = process.env, dependencies = {}) {
  const loaded = loadParentContext(parentContextFile, env);
  const running = runningWatcher(loaded.parent.parentRef, env, dependencies);
  if (running) return { running: true, started: false, pid: running.pid };
  const args = [__filename, '--parent-context-file', loaded.file];
  if (options.repoRoot) args.push('--repo-root', options.repoRoot);
  if (options.url) args.push('--url', options.url);
  if (options.claudeBin) args.push('--claude-bin', options.claudeBin);
  const launch = dependencies.spawnDetached || ((executable, spawnArgs) => {
    const child = spawn(executable, spawnArgs, { detached: true, stdio: 'ignore', env });
    child.unref();
    return child.pid;
  });
  const pid = launch(process.execPath, args);
  return { running: true, started: true, pid };
}

const SETTLED_LANE_STATES = new Set(['archivedVerified', 'cleanupEligible', 'worktreeRemoved', 'failed', 'stopped']);

// Children that still need the parent: any dispatch with an unacknowledged
// event, or whose lane is neither retired nor ended. A retired, failed, or
// stopped child whose events the parent has acknowledged no longer counts.
function outstandingChildren(context, env) {
  const dispatches = listDispatches(context, env);
  const pending = listEvents(context, {}, env);
  return dispatches.filter((dispatch) => {
    if (pending.some((event) => event.dispatchId === dispatch.dispatchId)) return true;
    let lane = null;
    try { lane = resolveDispatchLane(dispatch, env).lane; } catch { return true; }
    return !lane || !SETTLED_LANE_STATES.has(lane.state);
  });
}

// One observation pass followed by at most one wake per new event of a kind
// the parent must act on. Returns what changed for the record and the log.
async function watchOnce(context, values, env, state, dependencies = {}) {
  const observe = dependencies.observe || observeParentChildren;
  const deliver = dependencies.deliver || deliverWake;
  const round = await observe(context, values, env, Date.now() + OBSERVATION_ROUND_MS);
  const events = listEvents(context, {}, env);
  const fresh = events.filter((event) => WAKE_KINDS.has(event.kind) && !state.wakedEventIds.includes(event.eventId));
  const results = [];
  for (const event of fresh) {
    state.wakedEventIds.push(event.eventId);
    if (context.parent.wake?.channel && context.parent.wake.channel !== 'none') {
      try {
        const receipt = await deliver(context.parent.wake === undefined ? null : {
          channel: context.parent.wake.channel,
          bridgeId: context.parent.wake.id,
          threadId: context.parent.wake.id,
          cwd: context.parent.wake.cwd,
        }, wakeMessage(event, { parentContextFile: context.file }), {
          claudeBin: values['claude-bin'], url: values.url, clientUserMessageId: event.eventId,
        }, env);
        results.push({ eventId: event.eventId, kind: event.kind, delivered: true, method: receipt.method || receipt.channel });
      } catch (error) {
        results.push({ eventId: event.eventId, kind: event.kind, delivered: false, code: error.code || 'WAKE_UNDELIVERED' });
      }
    } else {
      results.push({ eventId: event.eventId, kind: event.kind, delivered: false, code: 'WAKE_UNAVAILABLE' });
    }
  }
  const working = round.observed.some((entry) => entry.phase === 'working');
  return { observed: round.observed.length, errors: round.errors, wakes: results, working };
}

async function runWatcher(options, env = process.env, dependencies = {}) {
  let context = loadParentContext(options.parentContextFile, env);
  const paths = watcherPaths(context.parent.parentRef, env);
  const existing = runningWatcher(context.parent.parentRef, env, dependencies);
  if (existing && existing.pid !== process.pid) {
    return { version: 1, ok: true, operation: 'watch', outcome: 'alreadyRunning', pid: existing.pid };
  }
  const previous = readRecord(paths.record);
  const state = {
    pid: process.pid,
    processBirth: (dependencies.processBirth || processBirth)(process.pid),
    parentRef: context.parent.parentRef,
    startedAt: new Date().toISOString(),
    wakedEventIds: Array.isArray(previous?.wakedEventIds) ? previous.wakedEventIds.slice(-500) : [],
    wakes: 0,
    rounds: 0,
  };
  writeRecord(paths, state);
  appendLog(paths, `start pid=${process.pid} wake=${context.parent.wake?.channel ?? 'none'}`);
  const values = { url: options.url, 'claude-bin': options.claudeBin, 'repo-root': options.repoRoot };
  const idleExitMs = options.idleExitMs ?? DEFAULT_IDLE_EXIT_MS;
  const maxRounds = dependencies.maxRounds ?? Infinity;
  let idleSince = null;
  let outcome = 'idleExit';
  while (state.rounds < maxRounds) {
    try {
      context = loadParentContext(options.parentContextFile, env);
    } catch (error) {
      appendLog(paths, `stop parent-context ${error.code || 'unreadable'}`);
      outcome = 'parentContextGone';
      break;
    }
    let pass;
    try {
      pass = await watchOnce(context, values, env, state, dependencies);
    } catch (error) {
      appendLog(paths, `observation failed ${error.code || error.message}`);
      pass = { observed: 0, errors: [{ code: error.code || 'OBSERVATION_FAILED' }], wakes: [], working: false };
    }
    state.rounds += 1;
    state.wakes += pass.wakes.filter((wake) => wake.delivered).length;
    for (const wake of pass.wakes) {
      appendLog(paths, `wake ${wake.kind} event=${wake.eventId} ${wake.delivered ? `delivered via ${wake.method}` : wake.code}`);
    }
    for (const failure of pass.errors) appendLog(paths, `observer error ${failure.code} dispatch=${failure.dispatchId || '-'}`);
    writeRecord(paths, { ...state, lastRoundAt: new Date().toISOString(), unacknowledged: countEvents(context, {}, env) });
    const outstanding = outstandingChildren(context, env).length;
    if (outstanding === 0) {
      idleSince = idleSince ?? Date.now();
      if (Date.now() - idleSince >= idleExitMs) break;
    } else {
      idleSince = null;
    }
    await (dependencies.sleep || sleep)(pass.working ? ACTIVE_POLL_MS : QUIET_POLL_MS);
  }
  if (state.rounds >= maxRounds) outcome = 'roundsExhausted';
  appendLog(paths, `stop ${outcome} rounds=${state.rounds} wakes=${state.wakes}`);
  try { if (readRecord(paths.record)?.pid === process.pid) fs.unlinkSync(paths.record); } catch { /* already gone */ }
  return { version: 1, ok: true, operation: 'watch', outcome, rounds: state.rounds, wakes: state.wakes };
}

function parseWatchArgs(argv, env = process.env) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: HELP };
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      'parent-context-file': { type: 'string' },
      'repo-root': { type: 'string' },
      url: { type: 'string' },
      'claude-bin': { type: 'string' },
      'idle-exit-ms': { type: 'string' },
      detach: { type: 'boolean' },
      status: { type: 'boolean' },
    },
  });
  const values = parsed.values;
  if (!values['parent-context-file'] || !path.isAbsolute(values['parent-context-file'])) {
    throw usageError('--parent-context-file must be absolute');
  }
  if (values['repo-root'] !== undefined && !path.isAbsolute(values['repo-root'])) throw usageError('--repo-root must be absolute');
  if (values['claude-bin'] !== undefined && !path.isAbsolute(values['claude-bin'])) throw usageError('--claude-bin must be absolute');
  let idleExitMs;
  if (values['idle-exit-ms'] !== undefined) {
    if (!/^[1-9][0-9]*$/.test(values['idle-exit-ms'])) throw usageError('--idle-exit-ms must be a positive integer');
    idleExitMs = Number(values['idle-exit-ms']);
  }
  return {
    parentContextFile: values['parent-context-file'],
    repoRoot: values['repo-root'],
    url: values.url || env.TRANSMOGRIFY_URL,
    claudeBin: values['claude-bin'] || env.CLAUDE_BIN,
    idleExitMs,
    detach: values.detach === true,
    status: values.status === true,
  };
}

async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const options = parseWatchArgs(argv, env);
  if (options.help) return options;
  if (options.status) {
    const loaded = loadParentContext(options.parentContextFile, env);
    const running = runningWatcher(loaded.parent.parentRef, env, dependencies);
    return { version: 1, ok: true, operation: 'watch', outcome: running ? 'running' : 'stopped', pid: running?.pid ?? null };
  }
  if (options.detach) {
    const ensured = ensureWatcher(options.parentContextFile, options, env, dependencies);
    return { version: 1, ok: true, operation: 'watch', outcome: ensured.started ? 'started' : 'alreadyRunning', pid: ensured.pid };
  }
  return runWatcher(options, env, dependencies);
}

if (require.main === module) {
  main().then((result) => {
    if (result?.help) {
      console.log(result.help);
      return;
    }
    console.log(JSON.stringify(publicResult(result), null, 2));
    if (!result.ok) process.exitCode = EXIT.failed;
  }).catch((error) => {
    const body = failureBody(error);
    console.error(JSON.stringify(body, null, 2));
    process.exitCode = exitCodeForError(body.code);
  });
}

module.exports = {
  HELP,
  ensureWatcher,
  main,
  outstandingChildren,
  parseWatchArgs,
  runWatcher,
  runningWatcher,
  watchOnce,
  watcherPaths,
};
