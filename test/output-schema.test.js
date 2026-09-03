'use strict';

// Golden projections for the public output contract. Each input is a superset
// of what an adapter returns, including keys that must never print; the
// expected value is the exact public result.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  PHASES, PROVIDER_PHASES, SCHEMAS, describeSchema, normalizePhase, phaseFields, publicResult,
} = require('../scripts/lib/output-schema');

test('every provider phase maps to one normalized phase and unknown words stay unknown', () => {
  for (const [target, mapping] of Object.entries(PROVIDER_PHASES)) {
    for (const [providerPhase, phase] of Object.entries(mapping)) {
      assert.ok(PHASES.includes(phase), `${target}:${providerPhase} -> ${phase}`);
      assert.deepEqual(phaseFields(target, providerPhase), { phase, providerPhase });
    }
  }
  assert.equal(normalizePhase('codex', 'interrupted'), 'idle');
  assert.equal(normalizePhase('claude', 'working'), 'executing');
  assert.equal(normalizePhase('claude', 'retiring'), 'stopped');
  assert.equal(normalizePhase('codex', 'something-new'), 'unknown');
  assert.equal(normalizePhase('other', 'idle'), 'unknown');
});

test('status results carry both phases and drop provider handles', () => {
  const projected = publicResult({
    version: 1, ok: true, operation: 'status', operationId: 'op', laneId: 'lane', adapter: 'codex-app-server',
    providerId: 'thread-private', state: 'idle', ...phaseFields('codex', 'interrupted'),
    capabilities: { midTurnSteer: true, interrupt: true, retirement: 'archive', recovery: 'reconcile', approvalRelay: false },
    visibility: { surface: 'codex', state: 'desktopAttached', receipt: { runtimeUrl: 'ws://127.0.0.1:8843/', clientPid: 5, connection: '127.0.0.1:1->127.0.0.1:8843', observedAt: 't', bundleId: 'b', desktopVersion: 'v', desktopBuild: '1', buildTested: true, secretPath: '/Users/private' } },
    turn: { id: 'turn-private', status: 'interrupted' },
    rawState: { type: 'idle', activeFlags: [], internal: 'x' },
    receipt: { userAgent: 'Codex Desktop/0.151.0', exactSession: true },
  });
  assert.deepEqual(projected, {
    version: 1, ok: true, operation: 'status', operationId: 'op', laneId: 'lane', adapter: 'codex-app-server',
    state: 'idle', phase: 'idle', providerPhase: 'interrupted',
    capabilities: { midTurnSteer: true, interrupt: true, retirement: 'archive', recovery: 'reconcile', approvalRelay: false },
    visibility: { surface: 'codex', state: 'desktopAttached', receipt: { runtimeUrl: 'ws://127.0.0.1:8843/', clientPid: 5, connection: '127.0.0.1:1->127.0.0.1:8843', observedAt: 't', bundleId: 'b', desktopVersion: 'v', desktopBuild: '1', buildTested: true } },
    turn: { status: 'interrupted' },
    rawState: { type: 'idle', activeFlags: [] },
    receipt: { exactSession: true },
  });
});

test('retire, reconcile, abandon, and wait results keep their declared keys only', () => {
  assert.deepEqual(publicResult({
    version: 1, ok: true, operation: 'retire', operationId: 'op', laneId: 'lane', adapter: 'claude-code',
    providerId: 'session-private', state: 'worktreeRemoved', capabilities: { stop: 'wholeSession' },
    receipt: {
      remoteArchived: true, localJobRemoved: true, localRemovalDeferred: false, harvestedOutputSha256: 'f'.repeat(64),
      worktree: { attempted: true, removed: true, path: '/Users/private/seat' }, archiveResponse: { id: 'private' },
    },
  }), {
    version: 1, ok: true, operation: 'retire', operationId: 'op', laneId: 'lane', adapter: 'claude-code',
    state: 'worktreeRemoved', capabilities: { stop: 'wholeSession' },
    receipt: {
      remoteArchived: true, localJobRemoved: true, localRemovalDeferred: false, harvestedOutputSha256: 'f'.repeat(64),
      worktree: { attempted: true, removed: true },
    },
  });
  assert.deepEqual(publicResult({
    version: 1, ok: false, operation: 'reconcile', adapter: 'codex-app-server',
    recovered: [{ laneId: 'lane', providerId: 'thread-private', state: 'idle', delivery: 'unknown', pendingOperation: 'steer', repaired: [], ...phaseFields('codex', 'notLoaded') }],
    receipt: { providerConnection: 'notRequired', endpoint: 'ws://private' },
  }), {
    version: 1, ok: false, operation: 'reconcile', adapter: 'codex-app-server',
    recovered: [{ laneId: 'lane', state: 'idle', delivery: 'unknown', pendingOperation: 'steer', repaired: [], phase: 'idle', providerPhase: 'notLoaded' }],
    receipt: { providerConnection: 'notRequired' },
  });
  assert.deepEqual(publicResult({
    version: 1, ok: true, operation: 'abandon', laneId: 'lane', providerOutcome: 'unknown',
    lane: { laneId: 'lane', state: 'failed', backend: 'codex-app-server', seat: { path: '/Users/private' } },
    abandoned: { operationId: 'op', type: 'steer', fromState: 'unknown', reason: 'token=abc operator gave up', at: 't' },
    delivery: { providerMutation: 'unknown' },
  }), {
    version: 1, ok: true, operation: 'abandon', laneId: 'lane', providerOutcome: 'unknown',
    lane: { laneId: 'lane', state: 'failed', backend: 'codex-app-server' },
    abandoned: { operationId: 'op', type: 'steer', fromState: 'unknown', reason: 'token=[redacted] operator gave up', at: 't' },
    delivery: { providerMutation: 'unknown' },
  });
  assert.deepEqual(publicResult({
    version: 1, ok: true, operation: 'wait',
    events: [{ schemaVersion: 1, sequence: 3, parentRef: 'p', dispatchId: 'd', child: { provider: 'codex', laneId: 'lane', projectKey: 'k', repoRoot: '/Users/private' }, type: 'child.retired', observationFingerprint: 'f', data: { state: 'retired', transcript: 'private' }, occurredAt: 't', eventId: 'e' }],
    observerErrors: [{ dispatchId: 'd2', code: 'RUNTIME_MISMATCH', message: 'private detail' }],
  }), {
    version: 1, ok: true, operation: 'wait',
    events: [{ schemaVersion: 1, sequence: 3, parentRef: 'p', dispatchId: 'd', child: { provider: 'codex', laneId: 'lane', projectKey: 'k' }, type: 'child.retired', observationFingerprint: 'f', data: { state: 'retired' }, occurredAt: 't', eventId: 'e' }],
    observerErrors: [{ dispatchId: 'd2', code: 'RUNTIME_MISMATCH' }],
  });
});

test('the schema command and docs/OUTPUT.md agree on operations and top-level keys', () => {
  const described = describeSchema();
  assert.equal(described.operation, 'schema');
  assert.deepEqual(described.operations, Object.keys(SCHEMAS));
  assert.deepEqual(publicResult(described).operations, described.operations);
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'OUTPUT.md'), 'utf8');
  for (const [operation, shape] of Object.entries(SCHEMAS)) {
    assert.match(doc, new RegExp(`^### \`${operation}\``, 'm'), `OUTPUT.md documents ${operation}`);
    for (const key of Object.keys(shape)) {
      if (['version', 'ok', 'operation'].includes(key)) continue;
      assert.ok(doc.includes(`\`${key}\``), `OUTPUT.md names ${operation}.${key}`);
    }
  }
  for (const phase of PHASES) assert.ok(doc.includes(`\`${phase}\``), `OUTPUT.md names phase ${phase}`);
});
