'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  acknowledgeEvent,
  assertWriteCapacity,
  countEvents,
  createParentContext,
  listDispatches,
  listEvents,
  listParentContexts,
  loadParentContext,
  markDispatchJournaled,
  pathsFor,
  readDispatch,
  recordEvent,
  recordObservation,
  renderProvenanceBlock,
  reserveDispatch,
  setObservedProfile,
} = require('../scripts/lib/dispatch');
const { createStateFixture } = require('./helpers/state-fixture');

function parentFixture(t) {
  const fixture = createStateFixture(t);
  const context = createParentContext({
    hostProvider: 'codex',
    hostApp: 'codex-desktop',
    displayName: 'Release operator',
    nativeTaskRef: 'private-task-ref',
  }, fixture.env);
  return { ...fixture, context };
}

test('bounded collections refuse the first write beyond capacity', () => {
  assert.doesNotThrow(() => assertWriteCapacity(999, 1_000, 'records'));
  assert.throws(
    () => assertWriteCapacity(1_000, 1_000, 'records'),
    (error) => error.code === 'LOCAL_STATE_LIMIT',
  );
});

test('parent contexts are installation-owned private records', (t) => {
  const fixture = parentFixture(t);
  const stat = fs.statSync(fixture.context.file);
  assert.equal(stat.mode & 0o077, 0);
  assert.deepEqual(loadParentContext(fixture.context.file, fixture.env), fixture.context);
  assert.deepEqual(listParentContexts(fixture.env), [fixture.context]);
  const reused = createParentContext({
    hostProvider: 'codex',
    hostApp: 'codex-desktop',
    displayName: 'Release operator',
    nativeTaskRef: 'private-task-ref',
  }, fixture.env);
  assert.deepEqual(reused, fixture.context);
  assert.throws(() => createParentContext({
    hostProvider: 'codex',
    hostApp: 'codex-desktop',
    displayName: 'Different operator',
    nativeTaskRef: 'private-task-ref',
  }, fixture.env), /registered differently/);

  const foreign = createStateFixture(t);
  assert.throws(
    () => loadParentContext(fixture.context.file, foreign.env),
    /does not exist|not registered|installation/i,
  );
});

test('provenance rendering is deterministic and rejects line injection', () => {
  const metadata = {
    parentProvider: 'codex',
    fromApp: 'codex-desktop',
    parentTask: 'Release operator',
    dispatchId: '11111111-1111-4111-8111-111111111111',
    target: 'claude',
    profile: 'intent=deep, model=claude-opus-5, effort=xhigh, speed=standard',
  };
  const rendered = renderProvenanceBlock(metadata);
  assert.equal(rendered, renderProvenanceBlock(metadata));
  assert.match(rendered, /^\+-- transmogrify dispatch/m);
  assert.match(rendered, /\| parent-provider: "codex"/);
  assert.match(rendered, /\| parent-task: "Release operator"/);
  assert.throws(
    () => renderProvenanceBlock({ ...metadata, parentTask: 'escape\n+---' }),
    /single-line/,
  );
  assert.throws(
    () => renderProvenanceBlock({ ...metadata, profile: 'bad\u0000profile' }),
    /single-line/,
  );
});

test('dispatch reservation precedes provider work and separates prompt receipts', (t) => {
  const fixture = parentFixture(t);
  const reserved = reserveDispatch({
    parentContext: fixture.context,
    repoRoot: fixture.repoRoot,
    laneId: '22222222-2222-4222-8222-222222222222',
    targetProvider: 'claude',
    backend: 'claude-code',
    displayName: '::: review lane',
    profile: {
      requestedProfile: { intent: 'deep', model: 'claude-opus-5' },
      resolvedProfile: {
        intent: 'deep', model: 'claude-opus-5', effort: 'xhigh', setting: 'ultracode', speed: 'standard',
      },
      observedProfile: null,
    },
    prompt: 'Review the release.',
  }, fixture.env);

  assert.match(reserved.renderedPrompt, /^\+-- transmogrify dispatch/);
  assert.match(reserved.renderedPrompt, /\| profile: "intent=deep, model=claude-opus-5, effort=xhigh, setting=ultracode, speed=standard"/);
  assert.match(reserved.renderedPrompt, /\n\nReview the release\.$/);
  assert.notEqual(reserved.receipts.bodySha256, reserved.receipts.provenanceSha256);
  assert.notEqual(reserved.receipts.renderedSha256, reserved.receipts.bodySha256);
  assert.equal(reserved.dispatch.parent.nativeTaskRef, undefined);
  assert.equal(reserved.lineage.dispatchId, reserved.dispatch.dispatchId);
  assert.deepEqual(listDispatches(fixture.context, fixture.env), [reserved.dispatch]);

  const journaled = markDispatchJournaled(reserved.dispatch.dispatchId, fixture.env);
  assert.equal(journaled.state, 'journaled');
  assert.deepEqual(markDispatchJournaled(reserved.dispatch.dispatchId, fixture.env), journaled);
  const observed = {
    model: 'claude-opus-5', effort: null, speed: null,
    nativeControl: null, receipt: null,
  };
  const withObservation = setObservedProfile(reserved.dispatch.dispatchId, observed, fixture.env);
  assert.deepEqual(withObservation.observedProfile, observed);
  assert.deepEqual(setObservedProfile(reserved.dispatch.dispatchId, observed, fixture.env), withObservation);
  assert.throws(
    () => setObservedProfile(reserved.dispatch.dispatchId, { ...observed, model: 'other' }, fixture.env),
    /immutable/,
  );
  assert.deepEqual(readDispatch(reserved.dispatch.dispatchId, fixture.env), withObservation);
});

test('events are stable, monotonic, at-least-once, and separately acknowledged', (t) => {
  const fixture = parentFixture(t);
  const reserved = reserveDispatch({
    parentContext: fixture.context,
    repoRoot: fixture.repoRoot,
    laneId: '33333333-3333-4333-8333-333333333333',
    targetProvider: 'codex',
    backend: 'codex-app-server',
    displayName: '::: child',
    profile: { resolvedProfile: { intent: 'balanced', speed: 'standard' } },
    prompt: 'Implement the task.',
  }, fixture.env);
  const spawned = recordEvent({
    dispatchId: reserved.dispatch.dispatchId,
    type: 'child.spawned',
    fingerprint: 'provider-bound',
    data: { state: 'active' },
  }, fixture.env);
  const retry = recordEvent({
    dispatchId: reserved.dispatch.dispatchId,
    type: 'child.spawned',
    fingerprint: 'provider-bound',
    data: { state: 'active' },
  }, fixture.env);
  assert.deepEqual(retry, spawned);

  const idle = recordEvent({
    dispatchId: reserved.dispatch.dispatchId,
    type: 'child.idle-observed',
    fingerprint: 'work-unit-1:idle',
    data: { state: 'idle' },
  }, fixture.env);
  assert.equal(idle.sequence, spawned.sequence + 1);
  assert.deepEqual(listEvents(fixture.context, {}, fixture.env), [spawned, idle]);
  assert.equal(countEvents(fixture.context, {}, fixture.env), 2);

  const acknowledgement = acknowledgeEvent(fixture.context, spawned.eventId, fixture.env);
  assert.equal(acknowledgement.eventId, spawned.eventId);
  assert.deepEqual(listEvents(fixture.context, {}, fixture.env), [idle]);
  assert.equal(countEvents(fixture.context, {}, fixture.env), 1);
  assert.deepEqual(recordEvent({
    dispatchId: reserved.dispatch.dispatchId,
    type: 'child.spawned',
    fingerprint: 'provider-bound',
    data: { state: 'active' },
  }, fixture.env), spawned);
  assert.deepEqual(listEvents(fixture.context, {}, fixture.env), [idle]);
  assert.deepEqual(
    listEvents(fixture.context, { includeAcknowledged: true }, fixture.env),
    [spawned, idle],
  );
  assert.deepEqual(
    acknowledgeEvent(fixture.context, spawned.eventId, fixture.env),
    acknowledgement,
  );
});

test('event counts are exact beyond the delivery batch size', (t) => {
  const fixture = parentFixture(t);
  const reserved = reserveDispatch({
    parentContext: fixture.context,
    repoRoot: fixture.repoRoot,
    laneId: '34343434-3434-4434-8434-343434343434',
    targetProvider: 'codex',
    backend: 'codex-app-server',
    displayName: '::: many events',
    prompt: 'Exercise bounded event counting.',
  }, fixture.env);
  for (let index = 0; index < 101; index += 1) {
    recordEvent({
      dispatchId: reserved.dispatch.dispatchId,
      type: 'child.needs-attention',
      fingerprint: `attention-${index}`,
      data: { state: 'waiting' },
    }, fixture.env);
  }
  assert.equal(listEvents(fixture.context, {}, fixture.env).length, 100);
  assert.equal(countEvents(fixture.context, {}, fixture.env), 101);
});

test('observation checkpoints deduplicate unchanged state and preserve recurring attention', (t) => {
  const fixture = parentFixture(t);
  const reserved = reserveDispatch({
    parentContext: fixture.context,
    repoRoot: fixture.repoRoot,
    laneId: '44444444-4444-4444-8444-444444444444',
    targetProvider: 'claude',
    backend: 'claude-code',
    displayName: '::: attention child',
    profile: { resolvedProfile: { intent: 'deep', speed: 'standard' } },
    prompt: 'Pause for input twice.',
  }, fixture.env);
  const first = recordObservation({
    dispatchId: reserved.dispatch.dispatchId,
    phase: 'waiting',
    providerFingerprint: 'epoch-1:waiting',
    eventType: 'child.needs-attention',
    data: { state: 'waiting' },
  }, fixture.env);
  assert.ok(first.event);
  const unchanged = recordObservation({
    dispatchId: reserved.dispatch.dispatchId,
    phase: 'waiting',
    providerFingerprint: 'epoch-1:waiting',
    eventType: 'child.needs-attention',
    data: { state: 'waiting' },
  }, fixture.env);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.event, null);

  recordObservation({
    dispatchId: reserved.dispatch.dispatchId,
    phase: 'working',
    providerFingerprint: 'epoch-1:working',
    eventType: null,
  }, fixture.env);
  const recurring = recordObservation({
    dispatchId: reserved.dispatch.dispatchId,
    phase: 'waiting',
    providerFingerprint: 'epoch-1:waiting',
    eventType: 'child.needs-attention',
    data: { state: 'waiting' },
  }, fixture.env);
  assert.ok(recurring.event);
  assert.notEqual(recurring.event.eventId, first.event.eventId);
});

test('event sequencing does not invalidate an already loaded parent for a later spawn', (t) => {
  const fixture = parentFixture(t);
  const first = reserveDispatch({
    parentContext: fixture.context,
    repoRoot: fixture.repoRoot,
    laneId: '55555555-5555-4555-8555-555555555555',
    targetProvider: 'codex',
    backend: 'codex-app-server',
    displayName: '::: first child',
    prompt: 'First.',
  }, fixture.env);
  recordEvent({
    dispatchId: first.dispatch.dispatchId,
    type: 'child.spawned',
    fingerprint: 'spawn-complete:first',
  }, fixture.env);
  assert.doesNotThrow(() => reserveDispatch({
    parentContext: fixture.context,
    repoRoot: fixture.repoRoot,
    laneId: '66666666-6666-4666-8666-666666666666',
    targetProvider: 'claude',
    backend: 'claude-code',
    displayName: '::: second child',
    prompt: 'Second.',
  }, fixture.env));
});

test('corrupt acknowledgements and dispatch records fail closed', (t) => {
  const fixture = parentFixture(t);
  const reserved = reserveDispatch({
    parentContext: fixture.context,
    repoRoot: fixture.repoRoot,
    laneId: '77777777-7777-4777-8777-777777777777',
    targetProvider: 'codex',
    backend: 'codex-app-server',
    displayName: '::: guarded child',
    prompt: 'Guard state.',
  }, fixture.env);
  const event = recordEvent({
    dispatchId: reserved.dispatch.dispatchId,
    type: 'child.spawned',
    fingerprint: 'spawn-complete:guarded',
  }, fixture.env);
  acknowledgeEvent(fixture.context, event.eventId, fixture.env);
  const paths = pathsFor(fixture.env);
  const ackFile = `${paths.acknowledgements}/${fixture.context.parent.parentRef}/${event.eventId}.json`;
  fs.writeFileSync(ackFile, 'not-json', { mode: 0o600 });
  assert.throws(() => listEvents(fixture.context, {}, fixture.env), /valid private JSON/);

  const dispatchFile = `${paths.dispatches}/${reserved.dispatch.dispatchId}.json`;
  const corrupt = { ...reserved.dispatch, schemaVersion: 999 };
  fs.writeFileSync(dispatchFile, `${JSON.stringify(corrupt)}\n`, { mode: 0o600 });
  assert.throws(() => listDispatches(fixture.context, fixture.env), /dispatch record is invalid/);
});

test('events cannot substitute another provider or lane for their dispatch', (t) => {
  const fixture = parentFixture(t);
  const reserved = reserveDispatch({
    parentContext: fixture.context,
    repoRoot: fixture.repoRoot,
    laneId: '88888888-8888-4888-8888-888888888888',
    targetProvider: 'codex',
    backend: 'codex-app-server',
    displayName: '::: linked child',
    prompt: 'Guard event linkage.',
  }, fixture.env);
  const event = recordEvent({
    dispatchId: reserved.dispatch.dispatchId,
    type: 'child.spawned',
    fingerprint: 'spawn-complete:linked',
  }, fixture.env);
  const paths = pathsFor(fixture.env);
  const eventFile = `${paths.events}/${fixture.context.parent.parentRef}/${event.eventId}.json`;
  const substituted = { ...event, child: { ...event.child, provider: 'claude' } };
  fs.writeFileSync(eventFile, `${JSON.stringify(substituted)}\n`, { mode: 0o600 });
  assert.throws(
    () => listEvents(fixture.context, {}, fixture.env),
    /does not match its dispatch/,
  );
  assert.throws(
    () => acknowledgeEvent(fixture.context, event.eventId, fixture.env),
    /does not match its dispatch/,
  );
});

test('event identity covers every immutable field and event data is fixed and safe', (t) => {
  const fixture = parentFixture(t);
  const reserved = reserveDispatch({
    parentContext: fixture.context,
    repoRoot: fixture.repoRoot,
    laneId: '99999999-9999-4999-8999-999999999999',
    targetProvider: 'codex',
    backend: 'codex-app-server',
    displayName: '::: immutable event',
    prompt: 'Guard immutable events.',
  }, fixture.env);
  assert.throws(() => recordEvent({
    dispatchId: reserved.dispatch.dispatchId,
    type: 'child.spawned',
    fingerprint: 'spawn-complete:immutable',
    data: { state: 'spawned', accessToken: 'must-not-escape' },
  }, fixture.env), /invalid fields/);

  const event = recordEvent({
    dispatchId: reserved.dispatch.dispatchId,
    type: 'child.spawned',
    fingerprint: 'spawn-complete:immutable',
    data: { state: 'spawned' },
  }, fixture.env);
  const paths = pathsFor(fixture.env);
  const eventFile = path.join(
    paths.events, fixture.context.parent.parentRef, `${event.eventId}.json`,
  );
  fs.writeFileSync(eventFile, `${JSON.stringify({
    ...event,
    data: { state: 'idle' },
  })}\n`, { mode: 0o600 });
  assert.throws(() => listEvents(fixture.context, {}, fixture.env), /immutable content/);
});

test('dispatch collections ignore only internal atomic-write remnants', (t) => {
  const fixture = parentFixture(t);
  const reserved = reserveDispatch({
    parentContext: fixture.context,
    repoRoot: fixture.repoRoot,
    laneId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    targetProvider: 'claude',
    backend: 'claude-code',
    displayName: '::: atomic reader',
    prompt: 'Survive a write boundary.',
  }, fixture.env);
  const paths = pathsFor(fixture.env);
  const temporary = `.${crypto.randomUUID()}.json.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(path.join(paths.dispatches, temporary), '{}\n', { mode: 0o600 });
  assert.deepEqual(listDispatches(fixture.context, fixture.env), [reserved.dispatch]);
  fs.writeFileSync(path.join(paths.dispatches, 'unexpected.tmp'), '{}\n', { mode: 0o600 });
  assert.throws(() => listDispatches(fixture.context, fixture.env), /invalid record name/);
});

test('dispatch ownership binds project, parent snapshot, and private directory chain', (t) => {
  const fixture = parentFixture(t);
  const reserved = reserveDispatch({
    parentContext: fixture.context,
    repoRoot: fixture.repoRoot,
    laneId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    targetProvider: 'codex',
    backend: 'codex-app-server',
    displayName: '::: linked dispatch',
    prompt: 'Bind every identity.',
  }, fixture.env);
  const paths = pathsFor(fixture.env);
  const dispatchFile = path.join(paths.dispatches, `${reserved.dispatch.dispatchId}.json`);
  fs.writeFileSync(dispatchFile, `${JSON.stringify({
    ...reserved.dispatch,
    child: { ...reserved.dispatch.child, projectKey: 'f'.repeat(64) },
  })}\n`, { mode: 0o600 });
  assert.throws(() => readDispatch(reserved.dispatch.dispatchId, fixture.env), /project identity/);

  fs.writeFileSync(dispatchFile, `${JSON.stringify(reserved.dispatch)}\n`, { mode: 0o600 });
  const eventDirectory = path.join(paths.events, fixture.context.parent.parentRef);
  fs.mkdirSync(eventDirectory, { recursive: true, mode: 0o700 });
  const moved = `${eventDirectory}.real`;
  fs.renameSync(eventDirectory, moved);
  fs.symlinkSync(moved, eventDirectory, 'dir');
  assert.throws(() => listEvents(fixture.context, {}, fixture.env), /owner-only directory/);
});

test('visible provenance rejects path and credential-shaped parent metadata', (t) => {
  const fixture = createStateFixture(t);
  for (const displayName of [
    '/Users/person/private/repo',
    'Review output at /Users/person/private/repo',
    'Review output at C:\\Users\\person\\private',
    'Bearer secret-token',
    'api_key=hidden',
  ]) {
    assert.throws(() => createParentContext({
      hostProvider: 'codex',
      hostApp: 'codex-desktop',
      displayName,
    }, fixture.env), /must not contain a path or credential-like value/);
  }
});
