#!/usr/bin/env node
'use strict';

// Wait for a status transition on exact registry-owned Codex lanes. `--all`
// means every active lane bound to the selected runtime, never every thread
// hosted by that runtime. A watched lane's provider cwd must equal its durable
// seat before its status is accepted, and the listener exits on the first wake.
// It only observes status: it never starts, steers, interrupts, or archives.

const { AppServerClient, validateUrl } = require('./lib/app-server');
const { activeLanes } = require('./lib/state');
const { boundedCursor, laneNameError } = require('./lib/validation');
const { verifyLaneSeat } = require('./lib/worktree');
const { VERSION } = require('./lib/version');

const SOURCE_KINDS = [
  'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown',
];
const STOPPED = new Set(['idle', 'systemError', 'notLoaded']);
const STATUS_TYPES = new Set(['active', 'idle', 'systemError', 'notLoaded']);
const ACTIVE_FLAGS = new Set(['waitingOnApproval', 'waitingOnUserInput']);
const POLL_MS = 5000;
const MAX_PAGINATION_PAGES = 100;
const MAX_PAGINATION_ROWS = 10_000;
const HELP = 'usage: lane-status-listen.js [--url <ws-url>] [--repo-root <absolute-repo>] [--max-min <positive-integer>] (--all | <name>=<owned-lane-or-thread-id> [...])';

function usage(message) {
  if (message) console.error(`ERROR ${message}`);
  console.error(HELP);
  process.exit(2);
}

// Parses flags and <name>=<selector> watch arguments. A selector is a bounded
// lane or provider id prefix, and --max-min is capped to the longest delay a
// Node timer can hold so a configured expiry always fires.
function parseArgs(argv) {
  let watchAll = false;
  let urlFlag;
  let repoRootFlag;
  let maxMinRaw = '240';
  let optionsEnded = false;
  const seen = new Set();
  const selectors = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!optionsEnded && arg === '--') { optionsEnded = true; continue; }
    if (!optionsEnded && arg.startsWith('--')) {
      if (arg === '--all') {
        if (seen.has(arg)) usage('duplicate --all');
        seen.add(arg);
        watchAll = true;
        continue;
      }
      if (['--url', '--repo-root', '--max-min'].includes(arg)) {
        if (seen.has(arg)) usage(`duplicate ${arg}`);
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) usage(`${arg} requires a value`);
        seen.add(arg);
        if (arg === '--url') urlFlag = value;
        else if (arg === '--repo-root') repoRootFlag = value;
        else maxMinRaw = value;
        index += 1;
        continue;
      }
      usage(`unknown flag ${arg}`);
    }
    const equals = arg.indexOf('=');
    if (equals <= 0 || equals === arg.length - 1) usage('bad watch argument; expected <name>=<non-empty-thread-id>');
    const name = arg.slice(0, equals);
    const nameProblem = laneNameError(name, 'watch name');
    if (nameProblem) usage(nameProblem);
    const selector = arg.slice(equals + 1);
    if (!/^[0-9A-Za-z._-]{1,128}$/.test(selector)) usage('watch selector must be a bounded provider or lane id prefix');
    if (selectors.has(name)) usage(`duplicate watch name ${name}`);
    selectors.set(name, selector);
  }
  if (watchAll && selectors.size) usage('--all and named watches are mutually exclusive');
  if (!watchAll && selectors.size === 0) usage('name at least one <name>=<thread-id>, or pass --all');
  if (!/^[1-9][0-9]*$/.test(maxMinRaw) || !Number.isSafeInteger(Number(maxMinRaw))) {
    usage(`--max-min must be a canonical positive integer, got ${maxMinRaw}`);
  }
  const maxMin = Number(maxMinRaw);
  const maxTimerMinutes = Math.floor(2_147_483_647 / 60_000);
  if (maxMin > maxTimerMinutes) usage(`--max-min exceeds the maximum safe Node timer (${maxTimerMinutes} minutes)`);
  const rawUrl = urlFlag || process.env.TRANSMOGRIFY_URL ||
    `ws://127.0.0.1:${process.env.TRANSMOGRIFY_PORT || '8843'}`;
  let url;
  try { url = validateUrl(rawUrl); } catch (error) { usage(error.message); }
  return {
    watchAll,
    url,
    maxMin,
    repoRoot: repoRootFlag || process.env.REPO_ROOT,
    selectors,
  };
}

const cliArgs = process.argv.slice(2);
if (cliArgs.length === 1 && ['--help', '-h'].includes(cliArgs[0])) {
  console.log(HELP);
  process.exit(0);
}
const options = parseArgs(cliArgs);
if (!options.repoRoot) usage('--repo-root or REPO_ROOT is required for ownership verification');

let lanes;
try { lanes = activeLanes(options.repoRoot, 'codex-app-server'); } catch (error) {
  console.error('OWNERSHIP ERROR registry verification failed');
  process.exit(3);
}
// Every named watch must resolve to exactly one owned active lane on the
// selected runtime. An ambiguous, foreign-runtime, or already watched selector
// is a refusal, never a silently narrowed watch set.
const watch = new Map();
if (options.watchAll) {
  for (const lane of lanes) {
    if (lane.providerId && lane.runtime?.endpoint === options.url) watch.set(lane.laneId, lane);
  }
} else {
  for (const [name, selector] of options.selectors) {
    const matches = lanes.filter((lane) =>
      lane.laneId.startsWith(selector) || lane.providerId?.startsWith(selector)
    );
    if (matches.length === 0) {
      console.error(`OWNERSHIP ERROR watch ${name} did not match an owned active lane`);
      process.exit(3);
    }
    if (matches.length > 1) {
      console.error(`OWNERSHIP ERROR watch ${name} is ambiguous across owned lanes`);
      process.exit(3);
    }
    const lane = matches[0];
    if (!lane.providerId || lane.runtime?.endpoint !== options.url) {
      console.error(`OWNERSHIP ERROR watch ${name} belongs to a different runtime`);
      process.exit(3);
    }
    if ([...watch.values()].some((entry) => entry.providerId === lane.providerId)) {
      console.error(`OWNERSHIP ERROR watch ${name} resolves to an already watched lane`);
      process.exit(3);
    }
    watch.set(name, lane);
  }
}
if (options.watchAll && watch.size === 0) {
  console.log('no registry-owned active Codex lanes to watch');
  process.exit(0);
}
try {
  for (const lane of watch.values()) verifyLaneSeat(options.repoRoot, lane.seat);
} catch (error) {
  console.error('OWNERSHIP ERROR lane seat verification failed');
  process.exit(3);
}

const state = new Map();
const nameByThreadId = new Map();
let client;
let closing = false;
let polling = false;
let pollTimer;

// Requires the schema-defined status type and active flags, reading an absent
// activeFlags as empty. An unrecognized type or flag throws rather than being
// dropped, because a status that cannot be read is not a status of no change.
function normalizeStatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status) ||
      !STATUS_TYPES.has(status.type)) {
    throw new Error('invalid watched Codex status');
  }
  const flags = status.activeFlags === undefined ? [] : status.activeFlags;
  if (!Array.isArray(flags) || flags.some((flag) => !ACTIVE_FLAGS.has(flag))) {
    throw new Error('invalid watched Codex active flags');
  }
  return { type: status.type, activeFlags: [...flags] };
}

// Requires the provider's returned cwd to equal the lane's durable seat before
// its status is accepted. thread/resume must also carry the top-level cwd, so a
// subscription is never established against another working directory.
function assertProviderSeat(lane, response, method, requireResponseCwd = false) {
  const thread = response?.thread;
  if (!thread || typeof thread !== 'object' || Array.isArray(thread) ||
      typeof thread.cwd !== 'string' ||
      (requireResponseCwd && typeof response.cwd !== 'string')) {
    throw new Error(`${method} returned invalid provider cwd metadata`);
  }
  if (thread.cwd !== lane.seat?.path ||
      (requireResponseCwd && response.cwd !== lane.seat?.path)) {
    throw new Error(`${method} provider cwd did not match the reserved lane seat`);
  }
  return thread;
}

function statusText(status) {
  const flags = status?.activeFlags;
  return flags?.length ? `${status.type} (${flags.join(',')})` : status?.type || 'unknown';
}

function hasActiveFlags(status) {
  return status?.type === 'active' && status.activeFlags?.length > 0;
}

// Closes the listener exactly once. The latch keeps a later notification or poll
// from re-entering, and the short delay lets the final report flush before exit.
function finish(code) {
  if (closing) return;
  closing = true;
  clearInterval(pollTimer);
  client?.close();
  setTimeout(() => process.exit(code), 100);
}

function report(name, status) {
  const event = hasActiveFlags(status) ? `WAITING: ${status.activeFlags.join(',')}` : statusText(status).toUpperCase();
  console.log(`\nLANE ${event}: ${name}`);
  const others = [...state.entries()].filter(([key]) => key !== name);
  if (others.length) {
    console.log('other watched lanes:');
    for (const [key, value] of others) console.log(`  ${key}: ${statusText(value)}`);
  }
}

// Records a changed status for a watched lane and wakes the operator on the
// first active-to-stopped transition or non-empty active flag. An unchanged
// status is ignored; an unreadable one ends the listener as protocol uncertainty.
function observeStatus(threadId, status, source) {
  const name = nameByThreadId.get(threadId);
  if (!name || !state.has(name)) return;
  let normalized;
  try { normalized = normalizeStatus(status); } catch {
    console.error('RPC ERROR invalid status for an owned Codex lane');
    finish(3);
    return;
  }
  const previous = state.get(name);
  if (statusText(previous) === statusText(normalized)) return;
  state.set(name, normalized);
  console.log(`${new Date().toISOString()} ${name} -> ${statusText(normalized)} (${source})`);
  if ((previous?.type === 'active' && STOPPED.has(normalized.type)) || hasActiveFlags(normalized)) {
    report(name, normalized);
    finish(0);
  }
}

// Pages the opening census under fixed page, row, duplicate, and cursor-cycle
// bounds, then binds each watched lane to its seat-verified opening status. A
// lane that is not active is dropped here, which is what scopes --all.
async function readSnapshot() {
  const snapshot = new Map();
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  let rows = 0;
  do {
    pages += 1;
    if (pages > MAX_PAGINATION_PAGES) throw new Error('thread/list exceeded the page bound');
    const page = await client.call('thread/list', {
      cursor,
      limit: 100,
      sourceKinds: SOURCE_KINDS,
      useStateDbOnly: true,
    });
    if (!page || !Array.isArray(page.data)) throw new Error('thread/list response omitted data[]');
    rows += page.data.length;
    if (rows > MAX_PAGINATION_ROWS) throw new Error('thread/list exceeded the row bound');
    for (const thread of page.data) {
      if (!thread?.id) continue;
      if (snapshot.has(thread.id)) throw new Error('thread/list returned a duplicate thread id');
      snapshot.set(thread.id, thread);
    }
    const next = boundedCursor(page.nextCursor, 'thread/list nextCursor');
    if (next !== null && seen.has(next)) throw new Error('thread/list cursor cycle');
    if (next !== null) seen.add(next);
    cursor = next;
  } while (cursor !== null);
  for (const [name, lane] of [...watch]) {
    if (nameByThreadId.has(lane.providerId)) throw new Error(`duplicate watched provider id ${lane.providerId}`);
    const providerThread = snapshot.get(lane.providerId);
    const openingStatus = providerThread
      ? normalizeStatus(assertProviderSeat(lane, { thread: providerThread }, 'thread/list').status)
      : normalizeStatus({ type: 'notLoaded', activeFlags: [] });
    if (options.watchAll && openingStatus.type !== 'active') {
      watch.delete(name);
      continue;
    }
    nameByThreadId.set(lane.providerId, name);
    state.set(name, openingStatus);
  }
}

// Establishes one metadata-only thread/resume subscription per active lane at
// its owned seat. Both returned cwd fields must match before it counts, and the
// resume snapshot itself can already wake the listener.
async function subscribeActiveThreads() {
  let count = 0;
  for (const [name, status] of state) {
    if (status.type !== 'active') continue;
    const lane = watch.get(name);
    const resumed = await client.call('thread/resume', {
      threadId: lane.providerId,
      cwd: lane.seat.path,
      excludeTurns: true,
    });
    const thread = assertProviderSeat(lane, resumed, 'thread/resume', true);
    if (thread.id !== lane.providerId || !thread.status) {
      throw new Error(`thread/resume returned an invalid thread for ${name}`);
    }
    count += 1;
    observeStatus(lane.providerId, thread.status, 'resume snapshot');
    if (closing) return count;
  }
  return count;
}

// Seat-verified thread/read fallback for lanes whose notifications never arrive.
// It is guarded against re-entry, and any polling failure ends the listener as
// protocol uncertainty rather than leaving a stale status standing.
async function pollStatuses() {
  if (polling || closing) return;
  polling = true;
  try {
    for (const [name, lane] of watch) {
      const result = await client.call('thread/read', {
        threadId: lane.providerId,
        includeTurns: false,
      });
      const thread = assertProviderSeat(lane, result, 'thread/read');
      if (thread.id !== lane.providerId || !thread.status) {
        throw new Error(`thread/read returned an invalid thread for ${name}`);
      }
      observeStatus(lane.providerId, thread.status, 'poll');
      if (closing) return;
    }
  } catch (error) {
    console.error(`RPC ERROR polling status (${error.code || 'PROTOCOL_ERROR'})`);
    finish(3);
  } finally {
    polling = false;
  }
}

(async () => {
  try {
    client = new AppServerClient({
      url: options.url,
      clientInfo: {
        name: 'transmogrify-lane-status-listen',
        title: 'Transmogrify lane status listener',
        version: VERSION,
      },
    });
    client.on('thread/status/changed', (params) => observeStatus(params?.threadId, params?.status, 'notification'));
    client.on('turn/completed', (params) => {
      const name = nameByThreadId.get(params?.threadId);
      if (name && state.has(name)) console.log(`${new Date().toISOString()} ${name} turn/completed`);
    });
    client.on('connection/closed', () => {
      if (!closing) {
        console.error('WS closed by server');
        process.exit(3);
      }
    });
    const initialized = await client.connect();
    if (!client.verifiedRuntime) throw new Error(`unsupported Codex app-server ${initialized.userAgent}`);
    for (const lane of watch.values()) {
      for (const key of ['endpoint', 'codexHome', 'platformFamily', 'platformOs']) {
        if (lane.runtime?.[key] !== client.runtimeIdentity?.[key]) {
          throw new Error(`lane ${lane.laneId} runtime identity changed (${key})`);
        }
      }
    }
    await readSnapshot();
    if (state.size === 0) {
      console.log('no registry-owned provider-active Codex lanes to watch');
      finish(0);
      return;
    }
    console.log(`watching ${state.size} registry-owned Codex lane${state.size === 1 ? '' : 's'}`);
    for (const [name, status] of state) console.log(`  ${name}: ${statusText(status)}`);
    const openingWake = [...state.entries()].filter(([, status]) => STOPPED.has(status.type) || hasActiveFlags(status));
    if (openingWake.length) {
      for (const [name, status] of openingWake) report(name, status);
      finish(0);
      return;
    }
    const subscriptions = await subscribeActiveThreads();
    if (closing) return;
    console.log(`subscriptions established: ${subscriptions}; metadata polling: ${POLL_MS / 1000}s`);
    pollTimer = setInterval(pollStatuses, POLL_MS);
  } catch (error) {
    console.error(`RPC ERROR listener failed (${error.code || 'PROTOCOL_ERROR'})`);
    finish(3);
  }
})();

// The expiry timer is unreferenced, so it bounds a live listener without holding
// the process open once the connection and poll timer are gone.
setTimeout(() => {
  console.log(`listener expired after ${options.maxMin}m with no lane idle`);
  finish(0);
}, options.maxMin * 60_000).unref?.();
