'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const {
  MAX_HANDBACK_BYTES,
  exchangePaths,
  exchangePreamble,
  harvestLane,
  parseHandback,
  readHandback,
  writePacket,
} = require('../scripts/lib/exchange');
const { listOperations, registerLane } = require('../scripts/lib/state');
const { cleanupStatus, createManagedSeat } = require('../scripts/lib/worktree');
const { createRepoWithSeat } = require('./helpers/repo-fixture');

function handback(overrides = {}) {
  return `# Handback: exchange test

## Commit

${overrides.title || 'Implement portable lane harvest'}

${overrides.body || 'Persist the child handback and commit the reviewed work in the operator process.'}

## What changed and why

Added the requested behavior.

## Verified

The focused tests pass.

## Not verified

The host-only suite was not run.

## Risks and decisions for the operator

No known risks.
`;
}

function managedLane(t, options = {}) {
  const fixture = createRepoWithSeat(t);
  if (options.dependencies) {
    fs.writeFileSync(path.join(fixture.repoRoot, 'package.json'), '{}\n');
    execFileSync('git', ['-C', fixture.repoRoot, 'add', 'package.json']);
    execFileSync('git', ['-C', fixture.repoRoot, 'commit', '-qm', 'add package']);
    fs.mkdirSync(path.join(fixture.repoRoot, 'node_modules'));
    fs.writeFileSync(path.join(fixture.repoRoot, 'node_modules', 'dependency.txt'), 'shared\n');
  }
  const laneId = crypto.randomUUID();
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, laneId);
  const lane = registerLane(fixture.repoRoot, {
    laneId,
    backend: 'codex-app-server',
    target: 'codex',
    providerId: `thread-${laneId}`,
    displayName: '::: exchange test',
    state: options.state || 'idle',
    seat,
  }, fixture.env);
  writePacket(fixture.repoRoot, seat, 'Original packet, verbatim.\n');
  return { ...fixture, lane, seat };
}

test('exchange preamble names the seat, child boundary, handback, and commit contract', () => {
  const seat = '/tmp/lane-seat';
  const preamble = exchangePreamble(seat);
  assert.match(preamble, /^# Transmogrify lane exchange\n/);
  assert.match(preamble, /Write only inside this directory and \/tmp\./);
  assert.match(preamble, /Do not commit\. The operator commits your work/);
  assert.match(preamble, /\.transmogrify\/handback\.md/);
  assert.match(preamble, /Start with # Handback: <packet name>\./);
  for (const section of [
    'Commit', 'What changed and why', 'Verified', 'Not verified',
    'Risks and decisions for the operator',
  ]) assert.match(preamble, new RegExp(`^## ${section}$`, 'm'));
  assert.match(preamble, /DONE, or BLOCKED and the reason/);
});

test('handback parsing strips controls and keeps hostile text inert', () => {
  const hostile = handback({
    body: 'Describe $(touch /tmp/must-not-run) and `uname` as text.\u0007',
  });
  const parsed = parseHandback(hostile);
  assert.equal(parsed.body.includes('\u0007'), false);
  assert.match(parsed.body, /\$\(touch \/tmp\/must-not-run\)/);
  assert.equal(fs.existsSync('/tmp/must-not-run'), false);
  assert.throws(() => parseHandback(handback().replace('## Verified', '## Something else')), {
    code: 'HARVEST_MISMATCH',
  });
  assert.throws(() => parseHandback(handback({ title: 'short' })), {
    code: 'HARVEST_MISMATCH',
  });
});

test('handback reads are bounded and refuse oversize files', (t) => {
  const fixture = managedLane(t);
  const file = exchangePaths(fixture.seat.path).handback;
  fs.writeFileSync(file, 'x'.repeat(MAX_HANDBACK_BYTES + 1));
  assert.throws(() => readHandback(fixture.seat.path), { code: 'HARVEST_MISMATCH' });
});

test('harvest reports a missing handback without opening a journal', async (t) => {
  const fixture = managedLane(t);
  const result = await harvestLane({
    repoRoot: fixture.repoRoot,
    laneId: fixture.lane.laneId,
  }, fixture.env, { observe: async () => ({ phase: 'idle' }) });
  assert.equal(result.handback, 'missing');
  assert.equal(result.handbackSha256, null);
  assert.equal(result.retireCommand, null);
  assert.equal(listOperations(fixture.repoRoot, fixture.env).filter((entry) => entry.type === 'harvest').length, 0);
});

test('harvest commits reviewed changes, excludes provisions, and copies a matching digest', async (t) => {
  const fixture = managedLane(t, { dependencies: true });
  const source = path.join(fixture.seat.path, 'feature.txt');
  fs.writeFileSync(source, 'implemented\n');
  fs.writeFileSync(path.join(fixture.seat.path, ':(exclude)literal.txt'), 'literal pathspec\n');
  fs.writeFileSync(exchangePaths(fixture.seat.path).handback, handback());
  assert.equal(fs.lstatSync(path.join(fixture.seat.path, 'node_modules')).isSymbolicLink(), true);

  const result = await harvestLane({
    repoRoot: fixture.repoRoot,
    laneId: fixture.lane.laneId,
    commit: true,
  }, fixture.env, { observe: async () => ({ phase: 'idle' }) });

  assert.equal(result.handback, 'present');
  assert.deepEqual(result.changedFiles, [':(exclude)literal.txt', 'feature.txt']);
  assert.match(result.handbackSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.head, execFileSync('git', ['-C', fixture.seat.path, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim());
  const copied = path.join(fixture.stateDir, 'harvests', fixture.lane.laneId, 'handback.md');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(copied)).digest('hex'), result.handbackSha256);
  assert.equal(fs.statSync(copied).mode & 0o077, 0);
  assert.equal(fs.existsSync(path.join(fixture.seat.path, '.transmogrify')), false);
  assert.equal(fs.existsSync(path.join(fixture.seat.path, 'node_modules')), false);
  assert.equal(cleanupStatus(fixture.seat.path).clean, true);
  const message = execFileSync('git', ['-C', fixture.seat.path, 'show', '-s', '--format=%B'], {
    encoding: 'utf8',
  });
  assert.match(message, /^Implement portable lane harvest\n/);
  assert.match(message, /Co-Authored-By: Codex <noreply@openai\.com>/);
  assert.equal(execFileSync('git', ['-C', fixture.seat.path, 'ls-tree', '-r', '--name-only', 'HEAD'], {
    encoding: 'utf8',
  }).includes('node_modules'), false);
  assert.match(execFileSync('git', [
    '-C', fixture.seat.path, 'show', 'HEAD::(exclude)literal.txt',
  ], { encoding: 'utf8' }), /literal pathspec/);
});

test('harvest refuses an active turn before opening its journal', async (t) => {
  const fixture = managedLane(t, { state: 'active' });
  fs.writeFileSync(exchangePaths(fixture.seat.path).handback, handback());
  await assert.rejects(() => harvestLane({
    repoRoot: fixture.repoRoot,
    laneId: fixture.lane.laneId,
    commit: false,
  }, fixture.env, { observe: async () => ({ phase: 'executing' }) }), { code: 'TARGET_ACTIVE' });
  assert.equal(listOperations(fixture.repoRoot, fixture.env).filter((entry) => entry.type === 'harvest').length, 0);
});

test('harvest recovers a commit completed before its journal and durable copy', async (t) => {
  const fixture = managedLane(t);
  fs.writeFileSync(path.join(fixture.seat.path, 'recover.txt'), 'recover me\n');
  fs.writeFileSync(exchangePaths(fixture.seat.path).handback, handback());
  await assert.rejects(() => harvestLane({
    repoRoot: fixture.repoRoot,
    laneId: fixture.lane.laneId,
    commit: true,
    cleanupProvisioned: false,
  }, fixture.env, {
    observe: async () => ({ phase: 'idle' }),
    afterCommit: async () => { throw new Error('simulated operator crash'); },
  }), /simulated operator crash/);
  const pending = listOperations(fixture.repoRoot, fixture.env)
    .find((entry) => entry.type === 'harvest');
  assert.equal(pending.state, 'commitDispatching');

  const recovered = await harvestLane({
    repoRoot: fixture.repoRoot,
    laneId: fixture.lane.laneId,
    commit: true,
    cleanupProvisioned: false,
  }, fixture.env);
  assert.equal(recovered.handback, 'present');
  assert.equal(execFileSync('git', ['-C', fixture.seat.path, 'rev-list', '--count', 'HEAD'], {
    encoding: 'utf8',
  }).trim(), '2');
  assert.equal(listOperations(fixture.repoRoot, fixture.env)
    .find((entry) => entry.operationId === pending.operationId).state, 'complete');
});
