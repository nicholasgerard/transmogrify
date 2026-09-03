'use strict';

// Codex app-server runtime and thread helpers shared by the lane adapter and
// its retirement and recovery modules: the selected endpoint, exact ownership
// and seat checks, the loopback client, thread and turn inspection, and the
// input-receipt search. Nothing here mutates a thread.

const crypto = require('node:crypto');
const { requireOwnedLane, requireOwnedProviderLane, updateLane } = require('./state');
const { AppServerClient, validateUrl } = require('./app-server');
const { AdapterError } = require('./adapter-kit');
const { sleep } = require('./async');
const { VERSION } = require('./version');
const { verifyLaneSeat } = require('./worktree');
const { boundedCursor, normalizeThreadStatus } = require('./validation');

// Resume journal states in which turn/start was never sent. thread/resume
// loads a thread without changing it, so recovery may close these as input
// not delivered instead of probing for a turn that cannot exist.
const UNDISPATCHED_RESUME_STATES = new Set([
  'planned', 'resumeDispatching', 'resumeAcknowledged', 'unknownResume',
]);

// The complete thread/list source set. Listing every kind is what makes an
// archived-thread census complete rather than a partial view of one client.
const SOURCE_KINDS = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
];

const RETIRED_STATES = new Set([
  'archivedVerified', 'cleanupEligible', 'worktreeRemoved',
]);

// Spawn journal states in which the provider thread is bound but the first
// turn's outcome was never receipted. Only exact retirement may close them,
// and only after observing that no turn is active and the input receipt is
// absent; the input is never replayed.
const UNRESOLVED_SPAWN_STATES = new Set([
  'turnRequestDispatched', 'materialized', 'partial', 'unknown',
]);

// Spawn journal states in which the first turn's input receipt may simply not
// exist: turn/start was dispatched (or its outcome became unknown) but no turn
// carrying our client message ever appeared. Deliberately excludes
// 'materialized', where the receipt was already verified before a later
// postcondition failed, so a settled turn is never relabeled absent.
const SPAWN_ABSENCE_JOURNAL_STATES = new Set(['turnRequestDispatched', 'partial', 'unknown']);

// Bounds for every paginated provider read, plus the measured retry budget for
// the input receipt that a turn/start response can omit on this runtime line.
const MAX_PAGINATION_PAGES = 100;

const MAX_PAGINATION_ROWS = 10_000;

const DEFAULT_INPUT_RECEIPT_VERIFY_ATTEMPTS = 100;

const DEFAULT_INPUT_RECEIPT_VERIFY_DELAY_MS = 100;

// Default and bound for the spawn-absence grace period: how long a
// turn/start dispatch may go unreceipted before recovery treats the input as
// proven absent rather than merely not yet observed.
const DEFAULT_SPAWN_ABSENCE_GRACE_MS = 60_000;

const MAX_SPAWN_ABSENCE_GRACE_MS = 86_400_000;

// The shared adapter error under the name this adapter has always exported.
const TransmogrifyError = AdapterError;

// The selected runtime endpoint: explicit option, then TRANSMOGRIFY_URL, then
// the default loopback port. Callers still pass the result through validateUrl.
function runtimeUrl(options, env = process.env) {
  return options.url || env.TRANSMOGRIFY_URL ||
    `ws://127.0.0.1:${env.TRANSMOGRIFY_PORT || '8843'}`;
}

// Resolve the lane a command may act on, by lane id or provider id. Refuses
// another backend as ADAPTER_MISMATCH, a retired lane for a mutation as
// LANE_RETIRED, an unbound provider as DELIVERY_UNKNOWN, and a lane owned on a
// different runtime endpoint as RUNTIME_MISMATCH. No provider call is made.
function ownedLane(options, env, action = 'read') {
  if (options.laneId) {
    const lane = requireOwnedLane(options.repoRoot, options.laneId, env);
    if (lane.backend !== 'codex-app-server') {
      throw new TransmogrifyError('ADAPTER_MISMATCH', `lane ${lane.laneId} uses ${lane.backend}`);
    }
    if (action !== 'read' && RETIRED_STATES.has(lane.state)) {
      throw new TransmogrifyError('LANE_RETIRED', `lane ${lane.laneId} is retired`);
    }
    if (!lane.providerId) throw new TransmogrifyError('DELIVERY_UNKNOWN', `lane ${lane.laneId} has no provider id`);
    const endpoint = validateUrl(runtimeUrl(options, env));
    if (!lane.runtime?.endpoint || lane.runtime.endpoint !== endpoint) {
      throw new TransmogrifyError('RUNTIME_MISMATCH', `lane ${lane.laneId} is owned on another runtime endpoint`);
    }
    return lane;
  }
  const lane = requireOwnedProviderLane(
    options.repoRoot, 'codex-app-server', options.providerId, env,
  );
  if (action !== 'read' && RETIRED_STATES.has(lane.state)) {
    throw new TransmogrifyError('LANE_RETIRED', `lane ${lane.laneId} is retired`);
  }
  const endpoint = validateUrl(runtimeUrl(options, env));
  if (!lane.runtime?.endpoint || lane.runtime.endpoint !== endpoint) {
    throw new TransmogrifyError('RUNTIME_MISMATCH', `lane ${lane.laneId} is owned on another runtime endpoint`);
  }
  return lane;
}

// The connected runtime must be the exact one the lane was created on. The same
// endpoint serving a different Codex home or platform is RUNTIME_MISMATCH.
function assertRuntimeIdentity(lane, client) {
  for (const key of ['endpoint', 'codexHome', 'platformFamily', 'platformOs']) {
    if (lane.runtime?.[key] !== client.runtimeIdentity?.[key]) {
      throw new TransmogrifyError('RUNTIME_MISMATCH', `lane runtime identity changed (${key})`);
    }
  }
}

// Re-verify the seat's recorded identity before a mutation, so a replaced or
// moved worktree becomes SEAT_MISMATCH instead of silent execution elsewhere.
function assertSeatIdentity(options, lane, env) {
  try { return verifyLaneSeat(options.repoRoot, lane.seat); } catch (error) {
    throw new TransmogrifyError('SEAT_MISMATCH', error.message);
  }
}

// Every Codex response carrying a cwd must name the exact reserved seat. A
// missing or non-string value is PROTOCOL_ERROR as malformed; a well-formed
// different path is OWNERSHIP_MISMATCH. Both fail closed before input is sent.
function assertProviderSeat(lane, thread, responseCwd, method, requireResponseCwd = false) {
  if (!thread || typeof thread !== 'object' || Array.isArray(thread) ||
      typeof thread.cwd !== 'string' ||
      ((requireResponseCwd || responseCwd !== undefined) && typeof responseCwd !== 'string')) {
    throw new TransmogrifyError(
      'PROTOCOL_ERROR',
      `${method} response omitted required provider cwd metadata`,
      { providerSeatVerification: 'malformed' },
    );
  }
  if (thread.cwd !== lane.seat?.path ||
      ((requireResponseCwd || responseCwd !== undefined) && responseCwd !== lane.seat?.path)) {
    throw new TransmogrifyError(
      'OWNERSHIP_MISMATCH',
      `${method} provider cwd does not match the exact reserved seat`,
      { providerSeatVerification: 'mismatch' },
    );
  }
  return thread;
}

// Bounded attempts and delay for the persisted input receipt. Out-of-range
// values are USAGE_ERROR, so no caller can turn this into an unbounded poll.
function turnReceiptVerificationBounds(options) {
  const attempts = options.inputReceiptVerifyAttempts ?? DEFAULT_INPUT_RECEIPT_VERIFY_ATTEMPTS;
  const delayMs = options.inputReceiptVerifyDelayMs ?? DEFAULT_INPUT_RECEIPT_VERIFY_DELAY_MS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 100 ||
      !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 1000) {
    throw new TransmogrifyError('USAGE_ERROR', 'invalid turn input receipt verification bounds');
  }
  return { attempts, delayMs };
}

// Bounded grace period before an absent turn/start receipt settles the spawn
// journal as not delivered. Out of range is USAGE_ERROR, so no caller can turn
// this into an instant or unbounded failure trigger.
function spawnAbsenceGraceMs(options) {
  const graceMs = options.spawnAbsenceGraceMs ?? DEFAULT_SPAWN_ABSENCE_GRACE_MS;
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > MAX_SPAWN_ABSENCE_GRACE_MS) {
    throw new TransmogrifyError('USAGE_ERROR', 'invalid spawn absence grace period');
  }
  return graceMs;
}

// Open one app-server connection for the duration of a callback and always
// close it. A runtime outside the supported version line is UNVERIFIED_RUNTIME
// and no lifecycle mutation is attempted behind it.
async function withClient(options, callback, env = process.env) {
  // options.clientFactory lets a test or an embedding host supply the
  // app-server client; the default is the real loopback WebSocket client.
  const createClient = options.clientFactory || ((config) => new AppServerClient(config));
  const client = createClient({
    url: runtimeUrl(options, env),
    timeoutMs: options.timeoutMs ?? 20000,
    clientInfo: {
      name: 'transmogrify',
      title: 'transmogrify',
      version: VERSION,
    },
    serverRequestHandler: options.serverRequestHandler,
  });
  try {
    const initialized = await client.connect();
    if (!client.verifiedRuntime) {
      throw new TransmogrifyError('UNVERIFIED_RUNTIME', `unsupported Codex app-server ${initialized.userAgent}`);
    }
    return await callback(client, initialized);
  } finally {
    client.close();
  }
}

// Fully paginate model/list under the page, row, and cursor-cycle bounds. A
// truncated or looping catalog is PROTOCOL_ERROR, never a partial answer.
async function readModelCatalog(client) {
  const data = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
    const response = await client.call('model/list', {
      cursor,
      includeHidden: true,
      limit: 100,
    });
    if (!response || !Array.isArray(response.data)) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'model/list response did not include data');
    }
    data.push(...response.data);
    if (data.length > MAX_PAGINATION_ROWS) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'model/list exceeded the bounded catalog size');
    }
    if (response.nextCursor === null || response.nextCursor === undefined) {
      return { data, nextCursor: null };
    }
    if (typeof response.nextCursor !== 'string' || !response.nextCursor ||
        seenCursors.has(response.nextCursor)) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'model/list returned an invalid pagination cursor');
    }
    seenCursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new TransmogrifyError('PROTOCOL_ERROR', 'model/list exceeded the bounded page count');
}

// The newest turn only. A not-materialized precondition error means a genuinely
// empty thread and returns null; every other RPC error propagates.
async function newestTurn(client, threadId) {
  try {
    const turns = await client.call('thread/turns/list', {
      threadId,
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    });
    if (!turns || !Array.isArray(turns.data)) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/turns/list response did not include data[]');
    }
    const turn = turns.data[0] || null;
    if (turn && (typeof turn.id !== 'string' ||
        !['completed', 'interrupted', 'failed', 'inProgress'].includes(turn.status) ||
        !Array.isArray(turn.items))) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/turns/list returned an invalid newest turn');
    }
    return turn;
  } catch (error) {
    if (error.rpc?.code === -32600 && /not materialized yet/i.test(error.rpc?.message || '')) return null;
    throw error;
  }
}

// The exact input receipt: one userMessage item carrying this operation's client
// id whose single text part hashes to the dispatched input. Zero matches,
// several, or different content is PROTOCOL_ERROR and fails closed.
function userMessageTurnReceipt(turn, clientUserMessageId, inputSha256) {
  if (!turn || typeof turn.id !== 'string' || !Array.isArray(turn.items)) {
    throw new TransmogrifyError('PROTOCOL_ERROR', 'turn receipt is missing its item list');
  }
  const matches = turn.items.filter((item) =>
    item?.type === 'userMessage' && item.clientId === clientUserMessageId
  );
  if (matches.length !== 1) {
    throw new TransmogrifyError('PROTOCOL_ERROR', 'turn receipt did not contain one exact client message id');
  }
  const content = matches[0].content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' ||
      typeof content[0].text !== 'string' || messageDigest(content[0].text) !== inputSha256) {
    throw new TransmogrifyError('PROTOCOL_ERROR', 'turn receipt did not match the dispatched input');
  }
  return turn.id;
}

// Accept the turn/start response as the input receipt when it carries the exact
// marker; otherwise page thread/items/list for the persisted row within the
// bounded retry budget. A receipt naming another turn fails closed, and an
// exhausted budget is PROTOCOL_ERROR with the input never resent.
async function verifiedUserMessageTurnReceipt(
  client,
  threadId,
  turn,
  clientUserMessageId,
  inputSha256,
  options = {},
) {
  if (!turn || typeof turn.id !== 'string' || !Array.isArray(turn.items)) {
    throw new TransmogrifyError('PROTOCOL_ERROR', 'turn receipt is missing its item list');
  }
  const responseMatches = turn.items.filter((item) =>
    item?.type === 'userMessage' && item.clientId === clientUserMessageId
  );
  if (responseMatches.length > 0) {
    userMessageTurnReceipt(turn, clientUserMessageId, inputSha256);
    return 'turnStartResponse';
  }

  const { attempts, delayMs } = options;
  const aggregateBudget = {
    pagesRemaining: MAX_PAGINATION_PAGES,
    rowsRemaining: MAX_PAGINATION_ROWS,
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let persistedTurnId = null;
    try {
      persistedTurnId = await findTurnByClientMessage(
        client,
        threadId,
        clientUserMessageId,
        inputSha256,
        aggregateBudget,
      );
    } catch (error) {
      const transientUnmaterializedList = error.code === 'RPC_ERROR' &&
        error.method === 'thread/items/list' &&
        /^thread\/items\/list is not supported yet$/i.test(error.rpc?.message || '');
      if (!transientUnmaterializedList) throw error;
    }
    if (persistedTurnId !== null) {
      if (persistedTurnId !== turn.id) {
        throw new TransmogrifyError(
          'PROTOCOL_ERROR',
          'persisted turn input receipt did not match turn/start response',
        );
      }
      return 'threadItemsList';
    }
    if (attempt + 1 < attempts && delayMs > 0) {
      await sleep(delayMs);
    }
  }
  throw new TransmogrifyError('PROTOCOL_ERROR', 'turn receipt did not contain one exact client message id');
}

// Search a thread's persisted items for one client message id under shared page
// and row budgets. Returns the turn id, or null when it is absent. A duplicated
// marker, a marker in two turns, or a cursor cycle is PROTOCOL_ERROR.
async function findTurnByClientMessage(
  client,
  threadId,
  clientUserMessageId,
  inputSha256,
  aggregateBudget = null,
) {
  let cursor = null;
  const seen = new Set();
  let matchedTurnId = null;
  let matchedEntries = 0;
  const budget = aggregateBudget || {
    pagesRemaining: MAX_PAGINATION_PAGES,
    rowsRemaining: MAX_PAGINATION_ROWS,
  };
  do {
    if (budget.pagesRemaining < 1) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/items/list exceeded the aggregate page bound');
    }
    budget.pagesRemaining -= 1;
    const page = await client.call('thread/items/list', {
      threadId,
      cursor,
      limit: 100,
      sortDirection: 'desc',
    });
    if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.data)) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/items/list response did not include data[]');
    }
    if (page.data.length > budget.rowsRemaining) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/items/list exceeded the aggregate row bound');
    }
    budget.rowsRemaining -= page.data.length;
    for (const entry of page.data) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          typeof entry.turnId !== 'string' || !entry.item ||
          typeof entry.item !== 'object' || Array.isArray(entry.item)) {
        throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/items/list returned an invalid entry');
      }
      if (entry.item.type !== 'userMessage' || entry.item.clientId !== clientUserMessageId) continue;
      matchedEntries += 1;
      if (matchedEntries > 1) {
        throw new TransmogrifyError('PROTOCOL_ERROR', 'client message id appeared more than once');
      }
      const observedTurnId = userMessageTurnReceipt({ id: entry.turnId, items: [entry.item] },
        clientUserMessageId, inputSha256);
      if (matchedTurnId && matchedTurnId !== observedTurnId) {
        throw new TransmogrifyError('PROTOCOL_ERROR', 'client message id appeared in multiple turns');
      }
      matchedTurnId = observedTurnId;
    }
    const next = boundedCursor(page.nextCursor, 'thread/items/list nextCursor');
    if (next !== null && seen.has(next)) {
      throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/items/list cursor cycle');
    }
    if (next !== null) seen.add(next);
    cursor = next;
  } while (cursor !== null);
  return matchedTurnId;
}

// Collapse thread status and newest-turn status into one observed phase. The
// turn wins where both speak, because a thread can read active with no turn.
function phaseFor(thread, turn) {
  if (turn?.status === 'inProgress') return 'executing';
  if (turn?.status === 'failed' || thread.status.type === 'systemError') return 'failed';
  if (turn?.status === 'interrupted') return 'interrupted';
  if (turn?.status === 'completed' || thread.status.type === 'idle') return 'idle';
  if (thread.status.type === 'notLoaded') return 'notLoaded';
  if (thread.status.type === 'active') return 'executing';
  return 'unknown';
}

// One seat-verified read of the thread plus its newest turn. Mutations call it
// first, so an ownership or protocol failure lands before any dispatch.
async function inspectThread(client, lane) {
  const read = await client.call('thread/read', {
    threadId: lane.providerId,
    includeTurns: false,
  });
  if (!read?.thread || read.thread.id !== lane.providerId) {
    throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/read returned an invalid thread');
  }
  assertProviderSeat(lane, read.thread, undefined, 'thread/read');
  let status;
  try { status = normalizeThreadStatus(read.thread.status); } catch {
    throw new TransmogrifyError('PROTOCOL_ERROR', 'thread/read returned an invalid thread status');
  }
  const turn = await newestTurn(client, lane.providerId);
  const thread = { ...read.thread, status };
  return { thread, turn, phase: phaseFor(thread, turn) };
}

// Map an observed phase onto a lane state. Retirement states are sticky: an
// observation never walks a lane back out of retirement.
function observedLaneState(lane, phase) {
  if (RETIRED_STATES.has(lane.state) || ['retireRequested', 'archiveUnknown'].includes(lane.state)) {
    return lane.state;
  }
  if (phase === 'executing') return 'active';
  if (phase === 'failed') return 'failed';
  if (['idle', 'interrupted', 'notLoaded'].includes(phase)) return 'idle';
  return lane.state;
}

function messageDigest(message) {
  return crypto.createHash('sha256').update(message).digest('hex');
}

// A pending operation must be the same type and carry the same request details,
// otherwise this request is PENDING_OPERATION. This is what makes a retry
// idempotent instead of a second provider effect.
function assertPendingMutation(operation, type, lane, details = {}) {
  if (operation.type !== type) {
    throw new TransmogrifyError(
      'PENDING_OPERATION',
      `lane ${lane.laneId} already has pending ${operation.type} operation ${operation.operationId}`,
    );
  }
  for (const [key, value] of Object.entries(details)) {
    if (operation.details[key] !== value) {
      throw new TransmogrifyError(
        'PENDING_OPERATION',
        `pending ${type} operation ${operation.operationId} does not match this request`,
      );
    }
  }
  return operation;
}

// Move the lane to deliveryUnknown, leaving an already-failed lane alone.
function markLaneDeliveryUnknown(options, lane, env) {
  if (lane.state === 'failed') return lane;
  return updateLane(options.repoRoot, lane.laneId, { state: 'deliveryUnknown' }, env);
}

// Write an inspection back onto the lane. interruptRequested has no direct edge
// to active, so a lane observed executing again settles through idle rather
// than skipping a legal transition.
function updateLaneFromInspection(options, lane, inspected, env) {
  const state = observedLaneState(lane, inspected.phase);
  if (lane.state === 'interruptRequested' && state === 'active') {
    lane = updateLane(options.repoRoot, lane.laneId, { state: 'idle' }, env);
  }
  return updateLane(options.repoRoot, lane.laneId, {
    state,
    providerState: inspected.thread.status,
    turnId: inspected.turn?.id || lane.turnId,
    lastVerifiedAt: new Date().toISOString(),
  }, env);
}

module.exports = {
  UNDISPATCHED_RESUME_STATES,
  SOURCE_KINDS,
  RETIRED_STATES,
  UNRESOLVED_SPAWN_STATES,
  SPAWN_ABSENCE_JOURNAL_STATES,
  MAX_PAGINATION_PAGES,
  MAX_PAGINATION_ROWS,
  DEFAULT_INPUT_RECEIPT_VERIFY_ATTEMPTS,
  DEFAULT_INPUT_RECEIPT_VERIFY_DELAY_MS,
  DEFAULT_SPAWN_ABSENCE_GRACE_MS,
  MAX_SPAWN_ABSENCE_GRACE_MS,
  TransmogrifyError,
  runtimeUrl,
  ownedLane,
  assertRuntimeIdentity,
  assertSeatIdentity,
  assertProviderSeat,
  turnReceiptVerificationBounds,
  spawnAbsenceGraceMs,
  withClient,
  readModelCatalog,
  newestTurn,
  userMessageTurnReceipt,
  verifiedUserMessageTurnReceipt,
  findTurnByClientMessage,
  phaseFor,
  inspectThread,
  observedLaneState,
  messageDigest,
  assertPendingMutation,
  markLaneDeliveryUnknown,
  updateLaneFromInspection,
};
