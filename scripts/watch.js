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
const { countEvents, listEvents, loadParentContext, watcherPaths } = require('./lib/dispatch');
const { observeParentChildren, outstandingDispatches, resolveDispatchLane } = require('./lib/observe');
const { createObserverCache } = require('./lib/observer-cache');
const { AppServerClient, validateUrl } = require('./lib/app-server');
const { VERSION } = require('./lib/version');
const { processBirth, processMatches } = require('./lib/state');
const { deliverWake, wakeMessage } = require('./lib/wake');
const { sleep } = require('./lib/async');
const { EXIT, exitCodeForError, failureBody, usageError } = require('./lib/public-error');
const { publicResult } = require('./lib/output-schema');

// Polling is cheap only when it is rare: a child that is working is read
// every few seconds; an idle child changes only when the parent sends it
// something, and the parent's own commands nudge the watcher, so idle
// children are read rarely; a parent with nothing outstanding is checked
// rarely and the watcher exits after a short idle. spawn restarts it.
const ACTIVE_POLL_MS = 3_000;
const QUIET_POLL_MS = 30_000;
const SETTLED_POLL_MS = 60_000;
const NUDGE_CHECK_MS = 1_000;
const OBSERVATION_ROUND_MS = 30_000;
const DEFAULT_IDLE_EXIT_MS = 15 * 60 * 1000;
const WAKE_KINDS = new Set(['complete', 'attention', 'terminal']);
// A wake that could not be sent (the channel refused it) is retried on later
// rounds this many times; a wake that may have landed is never resent.
const MAX_WAKE_ATTEMPTS = 3;
const MAX_LOG_BYTES = 1024 * 1024;
// The app-server pushes these to every connected client; any of them naming
// an outstanding Codex child makes the watcher read that child at once
// instead of at its next poll.
const CODEX_TRIGGER_NOTIFICATIONS = new Set([
  'thread/status/changed', 'turn/started', 'turn/completed', 'item/completed', 'thread/archived',
]);
const SUBSCRIPTION_RECONNECT_MS = 30_000;

const HELP = `usage: watch.js --parent-context-file <absolute> [options]

options:
  --repo-root <absolute>        observe only children of this repository
  --url <loopback-ws-url>       Codex app-server endpoint (or TRANSMOGRIFY_URL)
  --claude-bin <absolute>       exact Claude CLI executable
  --idle-exit-ms <ms>           exit after this long with no outstanding child (default ${DEFAULT_IDLE_EXIT_MS}, 15 minutes)
  --detach                      start a detached watcher for this parent and return
  --status                      report whether a watcher is running for this parent
  --stop                        stop the watcher recorded for this parent (owner action)

The watcher observes every outstanding child of the parent, records the same
durable events wait records, and wakes the parent once per round through its
recorded wake channel when children complete, need attention, or end. It never
spawns, steers, stops, or harvests; the only events it acknowledges are those
that merely confirm the parent's own completed retire, stop, or interrupt.

exit codes (shared by every Transmogrify command):
  0  the watcher ran to its idle exit, was already running, or was started
  2  usage error
  3  the watcher could not run (lock, parent context, or observation failure)
  1  unexpected internal error`;

// Ask a running watcher to observe now instead of at its next poll. Called by
// the parent's own commands after they change a child, so an idle child that
// was just steered is read promptly without polling it while it sat idle.
function nudgeWatcher(parentRef, env = process.env) {
  const paths = watcherPaths(parentRef, env);
  try {
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.nudge, `${Date.now()}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function nudgeStamp(paths) {
  try { return fs.statSync(paths.nudge).mtimeMs; } catch { return null; }
}

// Sleep for the poll interval, returning early when the nudge file changes
// or an in-process trigger (a provider notification) fires.
async function sleepUntilNudged(ms, paths, dependencies, triggers = null) {
  if (triggers && triggers.pending()) return true;
  if (dependencies.sleep) {
    // An injected sleep stands for the whole interval (tests skip time).
    await dependencies.sleep(ms);
    return nudgeStamp(paths) !== null || Boolean(triggers && triggers.pending());
  }
  const before = nudgeStamp(paths);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(Math.min(NUDGE_CHECK_MS, Math.max(0, end - Date.now())));
    if (nudgeStamp(paths) !== before) return true;
    if (triggers && triggers.pending()) return true;
  }
  return false;
}

// A subscription to the app-server's notifications for one endpoint. It
// only marks a trigger when a notification names a thread the watcher
// currently owns as an outstanding child; the verified read still happens
// through the normal observation path. A dropped connection is retried on a
// timer and never fails the watcher: polling continues meanwhile.
function createCodexSubscription(url, dependencies = {}) {
  const createClient = dependencies.subscriptionClient || ((config) => new AppServerClient(config));
  const state = { client: null, threadIds: new Set(), triggered: false, connectedAt: null, failures: 0, timer: null, stopped: false };
  const threadIdOf = (params) => params?.threadId || params?.thread?.id || params?.turn?.threadId || null;
  async function connect() {
    if (state.stopped || state.client) return;
    const client = createClient({
      url, timeoutMs: 20000, clientInfo: { name: 'transmogrify-watch', title: 'transmogrify watch', version: VERSION },
    });
    try {
      await client.connect();
      if (!client.verifiedRuntime) { client.close(); throw Object.assign(new Error('unverified runtime'), { code: 'UNVERIFIED_RUNTIME' }); }
    } catch {
      state.failures += 1;
      schedule();
      return;
    }
    state.client = client;
    state.connectedAt = Date.now();
    client.on('notification', ({ method, params }) => {
      if (!CODEX_TRIGGER_NOTIFICATIONS.has(method)) return;
      const threadId = threadIdOf(params);
      if (threadId && state.threadIds.has(threadId)) state.triggered = true;
    });
    client.once('connection/closed', () => {
      state.client = null;
      schedule();
    });
  }
  function schedule() {
    if (state.stopped || state.timer) return;
    state.timer = setTimeout(() => { state.timer = null; connect(); }, dependencies.reconnectMs ?? SUBSCRIPTION_RECONNECT_MS);
    state.timer.unref?.();
  }
  return {
    url,
    start: connect,
    watch(threadIds) { state.threadIds = new Set(threadIds); },
    pending() { return state.triggered; },
    consume() { const was = state.triggered; state.triggered = false; return was; },
    connected() { return Boolean(state.client); },
    stop() {
      state.stopped = true;
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
      const client = state.client;
      state.client = null;
      if (client) { try { client.close(); } catch { /* already closed */ } }
    },
  };
}

// Provider ids of the outstanding Codex children on one endpoint, for the
// subscription's allow-list.
function codexThreadIds(outstanding, env) {
  const ids = [];
  for (const dispatch of outstanding) {
    if (dispatch.child.targetProvider !== 'codex') continue;
    try {
      const lane = resolveDispatchLane(dispatch, env).lane;
      if (lane?.providerId) ids.push(lane.providerId);
    } catch { /* not an owned lane right now */ }
  }
  return ids;
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

// Stop the watcher recorded for a parent. The pid is signalled only when its
// recorded process birth still matches, so a recycled pid is never touched.
async function stopWatcher(parentContextFile, env = process.env, dependencies = {}) {
  const loaded = loadParentContext(parentContextFile, env);
  const running = runningWatcher(loaded.parent.parentRef, env, dependencies);
  const paths = watcherPaths(loaded.parent.parentRef, env);
  if (!running) {
    try { fs.unlinkSync(paths.record); } catch { /* nothing recorded */ }
    return { running: false, stopped: false, pid: null };
  }
  const signal = dependencies.kill || process.kill.bind(process);
  try { signal(running.pid, 'SIGTERM'); } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  const wait = dependencies.sleep || sleep;
  for (let attempt = 0; attempt < 20 && runningWatcher(loaded.parent.parentRef, env, dependencies); attempt += 1) {
    await wait(100);
  }
  try { fs.unlinkSync(paths.record); } catch { /* removed by the watcher itself */ }
  return { running: false, stopped: true, pid: running.pid };
}

// Children that still need the parent (observe.outstandingDispatches).
function outstandingChildren(context, env) {
  return outstandingDispatches(context, env);
}

// One observation pass over the outstanding children, then at most one wake
// carrying every new event of a kind the parent must act on. Events for the
// same child are all named; the parent acknowledges them together with
// `ack --through`. Returns what changed for the record and the log.
async function watchOnce(context, values, env, state, dependencies = {}) {
  const observe = dependencies.observe || observeParentChildren;
  const deliver = dependencies.deliver || deliverWake;
  state.wakeAttempts = state.wakeAttempts || {};
  const outstanding = outstandingDispatches(context, env)
    .filter((dispatch) => !values['repo-root'] || dispatch.child.repoRoot === values['repo-root']);
  if (dependencies.subscription) {
    dependencies.subscription.watch(codexThreadIds(outstanding, env));
    dependencies.subscription.consume();
  }
  const round = await observe(context, { ...values, dispatches: outstanding }, env, Date.now() + OBSERVATION_ROUND_MS);
  const events = listEvents(context, {}, env);
  const fresh = events.filter((event) => WAKE_KINDS.has(event.kind) && !event.wakeSuppressed && !state.wakedEventIds.includes(event.eventId));
  const results = [];
  const markWaked = (event) => { state.wakedEventIds.push(event.eventId); delete state.wakeAttempts[event.eventId]; };
  if (fresh.length > 0) {
    if (context.parent.wake?.channel && context.parent.wake.channel !== 'none') {
      try {
        const receipt = await deliver({
          channel: context.parent.wake.channel,
          bridgeId: context.parent.wake.id,
          threadId: context.parent.wake.id,
          cwd: context.parent.wake.cwd,
        }, wakeMessage(fresh, { parentContextFile: context.file }), {
          claudeBin: values['claude-bin'], url: values.url, clientUserMessageId: fresh[fresh.length - 1].eventId,
        }, env);
        for (const event of fresh) {
          markWaked(event);
          results.push({
            eventId: event.eventId, kind: event.kind, delivered: true, batch: fresh.length,
            method: receipt.method || receipt.channel, certainty: receipt.certainty || 'acknowledged',
          });
        }
      } catch (error) {
        const code = error.code || 'WAKE_UNDELIVERED';
        for (const event of fresh) {
          // A wake that may have landed is never resent; one the channel
          // refused is retried on later rounds a bounded number of times.
          const attempts = (state.wakeAttempts[event.eventId] || 0) + 1;
          if (code !== 'WAKE_UNDELIVERED' || attempts >= MAX_WAKE_ATTEMPTS) markWaked(event);
          else state.wakeAttempts[event.eventId] = attempts;
          results.push({ eventId: event.eventId, kind: event.kind, delivered: false, code, attempts, batch: fresh.length });
        }
      }
    } else {
      for (const event of fresh) {
        markWaked(event);
        results.push({ eventId: event.eventId, kind: event.kind, delivered: false, code: 'WAKE_UNAVAILABLE' });
      }
    }
  }
  const working = round.observed.some((entry) => entry.phase === 'working');
  const acknowledged = round.observed.filter((entry) => entry.acknowledged).length;
  return {
    observed: round.observed.length, errors: round.errors, wakes: results, working,
    outstanding: outstanding.length, acknowledged,
    codexOutstanding: outstanding.filter((dispatch) => dispatch.child.targetProvider === 'codex').length,
  };
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
    wakeAttempts: previous?.wakeAttempts && typeof previous.wakeAttempts === 'object' ? previous.wakeAttempts : {},
    wakes: 0,
    rounds: 0,
  };
  writeRecord(paths, state);
  appendLog(paths, `start pid=${process.pid} wake=${context.parent.wake?.channel ?? 'none'}`);
  const cache = dependencies.cache || createObserverCache({ createClient: dependencies.createClient, claudeSurface: dependencies.claudeSurface });
  const values = {
    url: options.url, 'claude-bin': options.claudeBin, 'repo-root': options.repoRoot,
    surface: cache.surface, clientFactory: cache.clientFactory,
  };
  const subscriptionUrl = validateUrl(options.url || env.TRANSMOGRIFY_URL || `ws://127.0.0.1:${env.TRANSMOGRIFY_PORT || '8843'}`);
  const subscription = dependencies.subscription === null ? null
    : dependencies.subscription || createCodexSubscription(subscriptionUrl, dependencies);
  const roundDependencies = { ...dependencies, subscription };
  const idleExitMs = options.idleExitMs ?? DEFAULT_IDLE_EXIT_MS;
  const maxRounds = dependencies.maxRounds ?? Infinity;
  let idleSince = null;
  let outcome = 'idleExit';
  let stopping = false;
  const onSignal = () => { stopping = true; };
  if (!dependencies.noSignals) {
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  }
  while (state.rounds < maxRounds && !stopping) {
    try {
      context = loadParentContext(options.parentContextFile, env);
    } catch (error) {
      appendLog(paths, `stop parent-context ${error.code || 'unreadable'}`);
      outcome = 'parentContextGone';
      break;
    }
    let pass;
    cache.beginRound();
    try {
      pass = await watchOnce(context, values, env, state, roundDependencies);
    } catch (error) {
      appendLog(paths, `observation failed ${error.code || error.message}`);
      pass = { observed: 0, errors: [{ code: error.code || 'OBSERVATION_FAILED' }], wakes: [], working: false, outstanding: 1, acknowledged: 0, codexOutstanding: 0 };
    }
    state.rounds += 1;
    state.wakes += pass.wakes.filter((wake) => wake.delivered).length;
    for (const wake of pass.wakes) {
      appendLog(paths, `wake ${wake.kind} event=${wake.eventId} ${wake.delivered ? `sent via ${wake.method} (${wake.certainty}, batch ${wake.batch})` : `${wake.code}${wake.attempts ? ` attempt ${wake.attempts}` : ''}`}`);
    }
    if (pass.acknowledged) appendLog(paths, `acknowledged ${pass.acknowledged} own-command event(s)`);
    for (const failure of pass.errors) appendLog(paths, `observer error ${failure.code} dispatch=${failure.dispatchId || '-'}`);
    writeRecord(paths, { ...state, lastRoundAt: new Date().toISOString(), unacknowledged: countEvents(context, {}, env) });
    cache.endRound();
    if (pass.outstanding === 0) {
      idleSince = idleSince ?? Date.now();
      if (Date.now() - idleSince >= idleExitMs) break;
    } else {
      idleSince = null;
      if (subscription && !subscription.connected() && pass.codexOutstanding > 0) subscription.start();
    }
    const interval = pass.working ? ACTIVE_POLL_MS : pass.outstanding > 0 ? QUIET_POLL_MS : SETTLED_POLL_MS;
    if (await sleepUntilNudged(interval, paths, dependencies, subscription)) {
      appendLog(paths, `nudged ${subscription?.pending() ? 'by a runtime notification' : 'by a command or child hook'}`);
    }
  }
  if (subscription) subscription.stop();
  cache.forget();
  if (stopping) outcome = 'signalled';
  else if (state.rounds >= maxRounds) outcome = 'roundsExhausted';
  if (!dependencies.noSignals) {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
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
      stop: { type: 'boolean' },
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
    stop: values.stop === true,
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
  if (options.stop) {
    const stopped = await stopWatcher(options.parentContextFile, env, dependencies);
    return { version: 1, ok: true, operation: 'watch', outcome: stopped.stopped ? 'stopped' : 'notRunning', pid: stopped.pid };
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
  ACTIVE_POLL_MS,
  CODEX_TRIGGER_NOTIFICATIONS,
  HELP,
  createCodexSubscription,
  QUIET_POLL_MS,
  SETTLED_POLL_MS,
  ensureWatcher,
  main,
  nudgeWatcher,
  outstandingChildren,
  parseWatchArgs,
  runWatcher,
  runningWatcher,
  stopWatcher,
  watchOnce,
  watcherPaths,
};
