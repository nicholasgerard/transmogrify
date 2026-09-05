'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AppServerClient } = require('../scripts/lib/app-server');
const { withClient, inspectThread } = require('../scripts/lib/codex-runtime');
const {
  NIL_ID, PROBE_SET_VERSION, FAILED_TTL_MS, measureCodexCompatibility,
  runtimeCompatibilityFile, recordTurnsListEvidence,
} = require('../scripts/lib/codex-compat');
const { startMockAppServer } = require('./helpers/mock-app-server');
const { measuredReply, mockCodexClient } = require('./helpers/measured-codex');

function privateState(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-codex-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { TRANSMOGRIFY_STATE_DIR: path.join(root, 'state') };
}

for (const version of ['0.151.0', '0.153.4', '0.154.0']) {
  test(`not-found accepted per method; turns-list starts unmeasured on ${version}`, async (t) => {
    const env = privateState(t);
    const client = mockCodexClient();
    const record = await measureCodexCompatibility(client, version, { env });
    assert.equal(record.version, 2);
    assert.equal(record.probeSetVersion, PROBE_SET_VERSION);
    assert.equal(record.runtimeVersion, version);
    assert.equal(record.patternsMeasured, version !== '0.154.0');
    assert.equal(record.patternRuntimeVersion, version === '0.154.0' ? '0.153.4' : version);
    assert.equal(record.result, 'good');
    assert.deepEqual(record.probes.map((probe) => probe.evidence), [
      'validated-success', 'not-found', 'not-found', 'not-found', 'unmeasured',
    ]);
    assert.deepEqual(client.calls.map((request) => request.method), ['thread/list', 'turn/steer', 'thread/name/set', 'thread/archive']);
    for (const request of client.calls.slice(1)) assert.equal(request.params.threadId, NIL_ID);
    const before = client.calls.length;
    assert.deepEqual(await measureCodexCompatibility(client, version, { env }), record);
    assert.equal(client.calls.length, before);
    assert.equal(fs.statSync(runtimeCompatibilityFile(version, env)).mode & 0o777, 0o600);
    const positive = recordTurnsListEvidence(version, true, { env });
    assert.equal(positive.probes.at(-1).evidence, 'validated-success');
  });
}

const failures = {
  'unknown method fails the probe': { error: { code: -32600, message: 'Invalid request: unknown variant `no/such/method`, expected one of ...' } },
  'missing field fails the probe': { error: { code: -32600, message: 'Invalid request: missing field `name`' } },
  'internal error fails the probe': { error: { code: -32600, message: 'internal error' } },
  'success on nil id fails the safety assumption': { result: {} },
  'wrong nil id fails the probe': { error: { code: -32600, message: 'thread not found: another-thread' } },
  'unanchored not-found fails the probe': { error: { code: -32600, message: `thread not found: ${NIL_ID} extra` } },
  'trailing newline fails the anchored probe': { error: { code: -32600, message: `thread not found: ${NIL_ID}\n` } },
  'wrong error code fails the probe': { error: { code: -32602, message: `thread not found: ${NIL_ID}` } },
  'another method not-found fails the probe': { error: { code: -32600, message: `no rollout found for thread id ${NIL_ID}` } },
};
for (const [name, reply] of Object.entries(failures)) {
  test(name, async (t) => {
    const env = privateState(t);
    const record = await measureCodexCompatibility(mockCodexClient((request) => request.method === 'turn/steer' ? reply : null), '0.153.4', { env });
    assert.equal(record.result, 'failed');
    assert.equal(record.failingMethod, 'turn/steer');
    assert.equal(record.probes[1].evidence, 'rejected');
  });
}

test('read probe needs validated success', async (t) => {
  for (const reply of [{ result: {} }, { result: { data: [null] } }, { result: { data: [], nextCursor: 42 } },
    { error: { code: -32600, message: `thread not found: ${NIL_ID}` } }]) {
    const env = privateState(t);
    const record = await measureCodexCompatibility(mockCodexClient(() => reply), '0.153.4', { env });
    assert.equal(record.result, 'failed');
    assert.equal(record.failingMethod, 'thread/list');
  }
});

test('failed cache expires after 24 hours and a changed probe set re-measures', async (t) => {
  const env = privateState(t);
  let now = new Date('2026-09-05T00:00:00Z');
  const bad = mockCodexClient(() => failures['internal error fails the probe']);
  const options = { env, now: () => now };
  const failed = await measureCodexCompatibility(bad, '0.153.4', options);
  const good = mockCodexClient();
  now = new Date(now.getTime() + FAILED_TTL_MS - 1);
  assert.deepEqual(await measureCodexCompatibility(good, '0.153.4', options), failed);
  assert.equal(good.calls.length, 0);
  now = new Date(now.getTime() + 1);
  const renewed = await measureCodexCompatibility(good, '0.153.4', options);
  assert.equal(renewed.result, 'good');
  fs.writeFileSync(runtimeCompatibilityFile('0.153.4', env), JSON.stringify({ ...renewed, probeSetVersion: PROBE_SET_VERSION - 1 }));
  await measureCodexCompatibility(good, '0.153.4', options);
  assert.equal(good.calls.length, 8);
  const crypto = require('node:crypto');
  const previousKey = crypto.createHash('sha256').update(`${PROBE_SET_VERSION - 1}:0.153.4`).digest('hex');
  assert.notEqual(path.basename(runtimeCompatibilityFile('0.153.4', env)), `${previousKey}.json`);
});

test('transport and deadline failures never poison the compatibility cache', async (t) => {
  for (const code of ['TRANSPORT_ERROR', 'TRANSPORT_UNKNOWN', 'DEADLINE_EXCEEDED']) {
    const env = privateState(t);
    const failed = await measureCodexCompatibility(mockCodexClient(() => { throw Object.assign(new Error('unavailable'), { code }); }), '0.153.4', { env });
    assert.equal(failed.result, 'failed');
    assert.equal(failed.probes[0].evidence, 'unmeasured');
    assert.equal(fs.existsSync(runtimeCompatibilityFile('0.153.4', env)), false);
    assert.equal((await measureCodexCompatibility(mockCodexClient(), '0.153.4', { env })).result, 'good');
  }
});

for (const method of ['thread/start', 'turn/start', 'turn/steer', 'thread/name/set', 'thread/archive', 'turn/interrupt']) {
  test(`mutation refused without a good receipt: ${method}`, async (t) => {
    const env = privateState(t);
    const client = mockCodexClient(() => failures['unknown method fails the probe']);
    await assert.rejects(withClient({ url: 'ws://127.0.0.1:1', clientFactory: () => client },
      (connected) => connected.call(method, { threadId: 'exact-owned-thread' }), env),
    (error) => error.code === 'RUNTIME_UNSUPPORTED' && error.details.failingMethod === 'thread/list');
    assert.equal(client.calls.some((request) => request.params.threadId === 'exact-owned-thread'), false);
    assert.equal(client.compatibilityReceipt.result, 'failed');
  });
}

test('first mutation measures and carries the real good receipt; owned turns read adds evidence', async (t) => {
  const { createRepoWithSeat } = require('./helpers/repo-fixture');
  const { verifySeat } = require('../scripts/lib/worktree');
  const { registerLane } = require('../scripts/lib/state');
  const fixture = createRepoWithSeat(t);
  const { env } = fixture;
  const lane = registerLane(fixture.repoRoot, { backend: 'codex-app-server', providerId: 'owned-thread',
    displayName: '::: owned evidence', state: 'active',
    seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot) }, env);
  const client = mockCodexClient((request) => {
    if (request.params.threadId === 'owned-thread') {
      if (request.method === 'thread/read') return { result: { thread: { id: 'owned-thread', cwd: lane.seat.path, status: { type: 'idle' } } } };
      if (request.method === 'thread/turns/list') return { result: { data: [] } };
      return { result: {} };
    }
    return null;
  });
  await withClient({ url: 'ws://127.0.0.1:1', clientFactory: () => client }, async (connected) => {
    await inspectThread(connected, lane);
    await connected.call('thread/name/set', { threadId: 'owned-thread', name: '::: name' });
    assert.equal(connected.compatibilityReceipt.result, 'good');
    assert.equal(connected.compatibilityReceipt.probes.at(-1).evidence, 'validated-success');
  }, env);
});

test('Codex compatibility rejects a below-minimum version without lifecycle requests', async (t) => {
  const client = mockCodexClient();
  const record = await measureCodexCompatibility(client, '0.150.9', { env: privateState(t) });
  assert.equal(record.failingMethod, 'minimum-version');
  assert.deepEqual(client.calls, []);
});


test('real Codex spawn adapter refuses mutation without a good receipt', async (t) => {
  const { spawn } = require('../scripts/lib/codex-adapter');
  const { createRepoWithSeat } = require('./helpers/repo-fixture');
  const fixture = createRepoWithSeat(t);
  const client = mockCodexClient(() => failures['unknown method fails the probe']);
  await assert.rejects(spawn({ repoRoot: fixture.repoRoot, worktrees: fixture.worktreesRoot, cwd: fixture.seat,
    url: 'ws://127.0.0.1:1', allowProtocolOnly: true, name: '::: receipt refusal', input: 'Do the work.',
    clientFactory: () => client }, fixture.env), (error) => error.code === 'RUNTIME_UNSUPPORTED');
  assert.deepEqual(client.calls.map((request) => request.method), ['thread/list']);
});
