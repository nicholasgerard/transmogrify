'use strict';

// Golden projections for the public output contract. Each input is a superset
// of what an adapter returns, including keys that must never print; the
// expected value is the exact public result.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  PHASES, PROVIDER_PHASES, SCHEMAS, SETUP_PLAN, describeSchema, normalizePhase, phaseFields, publicResult,
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
    version: 1, ok: true, operation: 'harvest', operationId: 'op', laneId: 'lane',
    adapter: 'codex-app-server', handback: 'present', changedFiles: ['feature.js'],
    head: 'a'.repeat(40), handbackSha256: 'b'.repeat(64), retireCommand: 'node lane.js retire',
    durableHandback: '/Users/private/handback.md', providerId: 'private-thread',
  }), {
    version: 1, ok: true, operation: 'harvest', operationId: 'op', laneId: 'lane',
    adapter: 'codex-app-server', handback: 'present', changedFiles: ['feature.js'],
    head: 'a'.repeat(40), handbackSha256: 'b'.repeat(64), retireCommand: 'node lane.js retire',
  });
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
    results: [{
      laneId: 'lane', providerId: 'thread-private', state: 'idle', outcome: 'steerUnknown',
      delivery: 'unknown', pendingOperation: 'steer', repaired: [], ...phaseFields('codex', 'notLoaded'),
    }],
    receipt: { providerConnection: 'notRequired', endpoint: 'ws://private' },
  }), {
    version: 1, ok: false, operation: 'reconcile', adapter: 'codex-app-server',
    results: [{
      laneId: 'lane', state: 'idle', outcome: 'steerUnknown', delivery: 'unknown',
      pendingOperation: 'steer', repaired: [], phase: 'idle', providerPhase: 'notLoaded',
    }],
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

function markdownSection(doc, heading) {
  const lines = doc.split('\n');
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `missing documentation section ${heading}`);
  const level = /^#+/.exec(heading)[0].length;
  const end = lines.findIndex((line, index) => index > start &&
    /^#+ /.test(line) && /^#+/.exec(line)[0].length <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function missingOperationKeys(doc, operation, shape) {
  const own = markdownSection(doc, `### \`${operation}\``);
  // Only explicit shared-contract references admit keys from another section.
  // A key in an unrelated operation must never satisfy this operation's docs.
  const envelope = own.includes('Lane envelope') ? markdownSection(doc, '## Lane envelope') : '';
  const plan = own.includes('(#doctor-explanation)') ? markdownSection(doc, '## Doctor explanation') : '';
  const missing = [];
  function check(value, prefix = '') {
    for (const [key, child] of Object.entries(value)) {
      if (!prefix && ['version', 'ok', 'operation'].includes(key)) continue;
      const location = prefix ? `${prefix}.${key}` : key;
      const shared = location === 'plan' || location.startsWith('plan.') ||
        location === 'setup.plan' || location.startsWith('setup.plan.') ? plan : '';
      const inherited = !prefix || location.startsWith('capabilities.') ||
        location.startsWith('visibility.') ? envelope : '';
      if (![own, shared, inherited].some((section) => section.includes(`\`${key}\``))) {
        missing.push(`${operation}.${location}`);
      }
      if (child && typeof child === 'object') check(child, location);
    }
  }
  check(shape);
  return missing;
}

test('the schema command and docs/OUTPUT.md agree on per-operation schema keys', () => {
  // The documentation consumer reads the real schema producer, not a fixture.
  const described = describeSchema();
  assert.equal(described.operation, 'schema');
  assert.deepEqual(described.operations, Object.keys(SCHEMAS));
  assert.deepEqual(publicResult(described).operations, described.operations);
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'OUTPUT.md'), 'utf8');
  const missing = Object.entries(described.schemas)
    .flatMap(([operation, shape]) => missingOperationKeys(doc, operation, shape));
  assert.deepEqual(missing, [], 'every schema key belongs in its operation or an explicit shared contract');
  for (const phase of PHASES) assert.ok(doc.includes(`\`${phase}\``), `OUTPUT.md names phase ${phase}`);
});

test('output doc sync rejects a key moved into an unrelated operation', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'OUTPUT.md'), 'utf8');
  const section = markdownSection(doc, '### `harvest`');
  const moved = doc.replace(section, section.replace('`childReportedCommit`', 'child commit report')) +
    '\n`childReportedCommit` appears elsewhere.\n';
  assert.deepEqual(missingOperationKeys(moved, 'harvest', describeSchema().schemas.harvest),
    ['harvest.childReportedCommit']);
  const status = markdownSection(doc, '### `status`');
  const nestedMoved = doc.replace(status, status.replace('`exactSession`', 'exact session'));
  assert.ok(nestedMoved.includes('`exactSession`'), 'the key still exists elsewhere in the document');
  assert.deepEqual(missingOperationKeys(nestedMoved, 'status', describeSchema().schemas.status),
    ['status.receipt.exactSession']);
});

test('the setup plan schema exposes only the documented explanation fields', () => {
  assert.deepEqual(SETUP_PLAN, {
    context: true,
    steps: { action: true, what: true, why: true, consent: true, command: true, binary: true },
  });
  const projected = publicResult({
    version: 1, ok: true, operation: 'maintain', dryRun: true,
    setup: {
      ready: false,
      ownerActions: [],
      plan: {
        context: 'A terminal context.',
        privateSignal: 'secret',
        steps: [{ action: 'open-app', what: 'Do one thing.', why: 'It is needed.', consent: 'none', command: 'do-it', binary: '/tmp/codex', secret: 'hidden' }],
      },
    },
  });
  assert.deepEqual(projected.setup.plan, {
    context: 'A terminal context.',
    steps: [{ action: 'open-app', what: 'Do one thing.', why: 'It is needed.', consent: 'none', command: 'do-it', binary: '/tmp/codex' }],
  });
});

test('setup output keeps receipts and refusals but drops runner internals', () => {
  assert.deepEqual(publicResult({
    version: 1, ok: false, operation: 'setup', dryRun: false, ready: false,
    outcome: 'needs-action', providers: { claude: 'needs-action', codex: 'ready-with-limitations', private: 'hidden' },
    code: 'POLICY_REFUSAL', message: 'method refused by read-only policy',
    plan: { context: 'A host.', steps: [{ action: 'install-claude', what: 'Install.', why: 'Needed.', consent: 'install', command: 'fixed' }] },
    completed: [{ what: 'Checked.', consent: 'none', outcome: 'confirmed', private: 'hidden' }],
    refusal: { what: 'Install.', consent: 'install', reason: 'consent-required', private: 'hidden' },
    apps: { claude: 'needs setup', codex: 'ready', nextSession: 'Open the other app.', private: 'hidden' },
    childProcess: { pid: 1234 },
  }), {
    version: 1, ok: false, operation: 'setup', dryRun: false, ready: false,
    outcome: 'needs-action', providers: { claude: 'needs-action', codex: 'ready-with-limitations' },
    code: 'POLICY_REFUSAL', message: 'method refused by read-only policy',
    plan: { context: 'A host.', steps: [{ action: 'install-claude', what: 'Install.', why: 'Needed.', consent: 'install', command: 'fixed' }] },
    completed: [{ what: 'Checked.', consent: 'none', outcome: 'confirmed' }],
    refusal: { what: 'Install.', consent: 'install', reason: 'consent-required' },
    apps: { claude: 'needs setup', codex: 'ready', nextSession: 'Open the other app.' },
  });
});
