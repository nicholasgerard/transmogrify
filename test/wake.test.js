'use strict';

// Wake channels are discovered from the parent's own session or thread and
// delivered only to that recorded address. These tests use fakes for the
// process table, the session metadata directory, the app-server client, and
// the Claude surface; nothing here touches a real session or runtime.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  WakeError, deliverWake, discoverClaudeWake, discoverCodexWake, wakeMessage,
} = require('../scripts/lib/wake');

function sessionsFixture(t, records) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-wake-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(configDir, 'sessions'), { mode: 0o700 });
  for (const [pid, record] of Object.entries(records)) {
    fs.writeFileSync(path.join(configDir, 'sessions', `${pid}.json`), JSON.stringify(record), { mode: 0o644 });
  }
  return configDir;
}

// A fake process table: child pid -> parent pid.
function processTable(parents) {
  return (executable, args) => {
    assert.equal(executable, 'ps');
    const pid = Number(args[args.length - 1]);
    return `${parents[pid] ?? 1}\n`;
  };
}

const BRIDGE = 'session_testBridge01';
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('discoverClaudeWake walks the ancestry to the session that owns a Remote Control bridge', (t) => {
  const configDir = sessionsFixture(t, {
    500: { pid: 500, sessionId: SESSION, bridgeSessionId: BRIDGE, messagingSocketPath: '/tmp/cc-socks/500.sock' },
  });
  const run = processTable({ 700: 600, 600: 500, 500: 1 });
  const wake = discoverClaudeWake({ configDir, run, startPid: 700 });
  assert.equal(wake.channel, 'claude-bridge');
  assert.equal(wake.bridgeId, BRIDGE);
  assert.equal(wake.sessionId, SESSION);
  assert.equal(wake.receipt.source, 'process-ancestry');
  assert.equal(wake.receipt.depth, 2);
  assert.equal(wake.receipt.sessionPid, 500);
});

test('discoverClaudeWake reports none for sessions without a bridge, foreign records, and no session', (t) => {
  const noBridge = sessionsFixture(t, { 500: { pid: 500, sessionId: SESSION } });
  assert.deepEqual(discoverClaudeWake({ configDir: noBridge, run: processTable({ 600: 500 }), startPid: 600 }),
    { channel: 'none', reason: 'session-without-remote-control' });
  const mismatch = sessionsFixture(t, { 500: { pid: 501, sessionId: SESSION, bridgeSessionId: BRIDGE } });
  assert.equal(discoverClaudeWake({ configDir: mismatch, run: processTable({ 600: 500 }), startPid: 600 }).reason,
    'session-metadata-pid-mismatch');
  const empty = sessionsFixture(t, {});
  assert.deepEqual(discoverClaudeWake({ configDir: empty, run: processTable({ 600: 500, 500: 1 }), startPid: 600 }),
    { channel: 'none', reason: 'no-claude-session-in-ancestry' });
});

function fakeClient(responses, calls = []) {
  return () => ({
    verifiedRuntime: true,
    async connect() { return { userAgent: 'codex_cli_rs/0.151.0' }; },
    async call(method, params) {
      calls.push({ method, params });
      const handler = responses[method];
      if (!handler) throw Object.assign(new Error(`unexpected ${method}`), { code: 'RPC_ERROR' });
      return typeof handler === 'function' ? handler(params) : handler;
    },
    close() {},
  });
}

test('discoverCodexWake verifies the CODEX_THREAD_ID hint against the runtime and the running command', async () => {
  const repoRoot = '/tmp/repo';
  const items = { data: [{ item: { type: 'commandExecution', command: '/bin/zsh -lc \'node lane.js parent-init --host-provider codex --self-nonce nonce-123\'' } }] };
  const ok = await discoverCodexWake({
    threadIdHint: 'thread_abc12345', repoRoot, nonce: 'nonce-123',
    clientFactory: fakeClient({
      'thread/read': { thread: { id: 'thread_abc12345', cwd: repoRoot, status: { type: 'active' } } },
      'thread/items/list': items,
    }),
  }, { TRANSMOGRIFY_URL: 'ws://127.0.0.1:8843' });
  assert.equal(ok.channel, 'codex-thread');
  assert.equal(ok.threadId, 'thread_abc12345');
  assert.equal(ok.cwd, repoRoot);
  assert.equal(ok.receipt.source, 'env-thread-id+command-item');

  const wrongCwd = await discoverCodexWake({
    threadIdHint: 'thread_abc12345', repoRoot,
    clientFactory: fakeClient({ 'thread/read': { thread: { id: 'thread_abc12345', cwd: '/elsewhere' } } }),
  }, { TRANSMOGRIFY_URL: 'ws://127.0.0.1:8843' });
  assert.equal(wrongCwd.reason, 'thread-id-hint-cwd-mismatch');

  const noCommand = await discoverCodexWake({
    threadIdHint: 'thread_abc12345', repoRoot,
    clientFactory: fakeClient({
      'thread/read': { thread: { id: 'thread_abc12345', cwd: repoRoot } },
      'thread/items/list': { data: [{ item: { type: 'userMessage', content: [] } }] },
    }),
  }, { TRANSMOGRIFY_URL: 'ws://127.0.0.1:8843' });
  assert.equal(noCommand.reason, 'thread-id-hint-without-command-receipt');

  const missing = await discoverCodexWake({
    threadIdHint: 'thread_missing1',
    clientFactory: fakeClient({ 'thread/read': () => { throw Object.assign(new Error('no such thread'), { code: 'RPC_ERROR' }); } }),
  }, { TRANSMOGRIFY_URL: 'ws://127.0.0.1:8843' });
  assert.equal(missing.reason, 'thread-id-hint-not-on-runtime');
});

test('discoverCodexWake without a hint needs the nonce receipt and never trusts a bare cwd match', async () => {
  const repoRoot = '/tmp/repo';
  const rows = { data: [
    { id: 'thread_one00001', cwd: repoRoot, status: { type: 'active' } },
    { id: 'thread_two00002', cwd: repoRoot, status: { type: 'idle' } },
  ] };
  const withNonce = await discoverCodexWake({
    repoRoot, nonce: 'nonce-777',
    clientFactory: fakeClient({
      'thread/list': rows,
      'thread/items/list': ({ threadId }) => ({ data: threadId === 'thread_one00001'
        ? [{ item: { type: 'commandExecution', command: 'lane.js parent-init --self-nonce nonce-777' } }] : [] }),
    }),
  }, { TRANSMOGRIFY_URL: 'ws://127.0.0.1:8843' });
  assert.equal(withNonce.channel, 'codex-thread');
  assert.equal(withNonce.threadId, 'thread_one00001');
  assert.equal(withNonce.receipt.source, 'nonce-command-item');

  const bare = await discoverCodexWake({
    repoRoot, clientFactory: fakeClient({ 'thread/list': rows }),
  }, { TRANSMOGRIFY_URL: 'ws://127.0.0.1:8843' });
  assert.equal(bare.channel, 'codex-thread');
  assert.equal(bare.unverified, true);
  assert.equal(bare.receipt.source, 'sole-active-thread-with-repository-cwd');

  const nothing = await discoverCodexWake({
    clientFactory: fakeClient({}),
  }, { TRANSMOGRIFY_URL: 'ws://127.0.0.1:8843' });
  assert.equal(nothing.reason, 'no-thread-id-hint-and-no-repository');
});

test('wakeMessage names the lane, the kind, and the exact next commands without child output', () => {
  const text = wakeMessage({
    type: 'child.failed', kind: 'terminal', terminal: true,
    child: { laneId: 'lane-9' }, dispatchId: 'd-9', sequence: 4, eventId: 'e-9',
  }, { parentContextFile: '/state/parents/p.json' });
  assert.match(text, /child lane lane-9 reached a terminal state \(failed\)/);
  assert.match(text, /terminal, terminal\)|\(terminal, terminal\)/);
  assert.match(text, /lane\.js" wait --parent-context-file "\/state\/parents\/p\.json" --timeout-ms 0/);
  assert.match(text, /ack --parent-context-file "\/state\/parents\/p\.json" --event e-9/);
  assert.match(wakeMessage({ type: 'child.turn-completed', kind: 'complete', child: {}, sequence: 1, eventId: 'x' }),
    /completed its task and is idle/);
});

test('deliverWake sends a Claude follow-up to the recorded bridge and steers or starts a Codex turn', async () => {
  const sent = [];
  const surface = {
    preflight: () => ({ cliPath: '/opt/claude', cleanEnv: {} }),
    async sendRemoteFollowup(runtime, bridgeId, content, options) {
      sent.push({ bridgeId, content, timeoutMs: options.timeoutMs });
      return { ok: true, url: 'https://claude.ai/code/x' };
    },
  };
  const claude = await deliverWake({ channel: 'claude-bridge', bridgeId: BRIDGE }, 'wake text', { surface });
  assert.equal(claude.delivered, true);
  assert.deepEqual(sent, [{ bridgeId: BRIDGE, content: 'wake text', timeoutMs: 30000 }]);

  const uncertain = { ...surface, async sendRemoteFollowup() { throw Object.assign(new Error('x'), { code: 'DELIVERY_UNCERTAIN' }); } };
  await assert.rejects(() => deliverWake({ channel: 'claude-bridge', bridgeId: BRIDGE }, 'wake', { surface: uncertain }),
    (error) => error instanceof WakeError && error.code === 'WAKE_UNCERTAIN');

  const calls = [];
  const idle = fakeClient({
    'thread/read': { thread: { id: 'thread_parent001', cwd: '/tmp/repo' } },
    'thread/turns/list': { data: [{ id: 'turn-1', status: 'completed' }] },
    'turn/start': { turn: { id: 'turn-2' } },
  }, calls);
  const started = await deliverWake({ channel: 'codex-thread', threadId: 'thread_parent001', cwd: '/tmp/repo' }, 'wake', {
    clientFactory: idle, clientUserMessageId: 'msg-1',
  }, { TRANSMOGRIFY_URL: 'ws://127.0.0.1:8843' });
  assert.equal(started.method, 'turn/start');
  const start = calls.find((call) => call.method === 'turn/start');
  assert.equal(start.params.threadId, 'thread_parent001');
  assert.equal(start.params.cwd, '/tmp/repo');
  assert.equal(start.params.clientUserMessageId, 'msg-1');
  assert.deepEqual(start.params.input, [{ type: 'text', text: 'wake' }]);

  const steerCalls = [];
  const busy = fakeClient({
    'thread/read': { thread: { id: 'thread_parent001', cwd: '/tmp/repo' } },
    'thread/turns/list': { data: [{ id: 'turn-3', status: 'inProgress' }] },
    'turn/steer': { turnId: 'turn-3' },
  }, steerCalls);
  const steered = await deliverWake({ channel: 'codex-thread', threadId: 'thread_parent001', cwd: '/tmp/repo' }, 'wake', {
    clientFactory: busy,
  }, { TRANSMOGRIFY_URL: 'ws://127.0.0.1:8843' });
  assert.equal(steered.method, 'turn/steer');
  assert.equal(steerCalls.find((call) => call.method === 'turn/steer').params.expectedTurnId, 'turn-3');

  const moved = fakeClient({ 'thread/read': { thread: { id: 'thread_parent001', cwd: '/moved' } } });
  await assert.rejects(() => deliverWake({ channel: 'codex-thread', threadId: 'thread_parent001', cwd: '/tmp/repo' }, 'wake', {
    clientFactory: moved,
  }, { TRANSMOGRIFY_URL: 'ws://127.0.0.1:8843' }), (error) => error.code === 'WAKE_UNDELIVERED');

  await assert.rejects(() => deliverWake({ channel: 'none' }, 'wake'), (error) => error.code === 'WAKE_UNAVAILABLE');
});
