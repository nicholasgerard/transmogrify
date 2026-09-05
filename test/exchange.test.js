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
  immutableHandbackPath,
  parseHandback,
  readHandback,
  writePacket,
} = require('../scripts/lib/exchange');
const { phaseFields } = require('../scripts/lib/output-schema');
const { listOperations, registerLane, updateLane } = require('../scripts/lib/state');
const {
  captureHarvestReceipt,
  cleanupStatus,
  removeManagedSeat,
  createManagedSeat,
  plannedProvisionedEntries,
  verifySeat,
} = require('../scripts/lib/worktree');
const { createRepoWithSeat } = require('./helpers/repo-fixture');

function handback(overrides = {}) {
  return `# Handback: exchange test

## Commit

${overrides.title || 'Implement portable lane harvest'}

${overrides.body || 'Persist the child handback and commit the reviewed work in the operator process.'}
${overrides.sha ? `\nSHA: ${overrides.sha}\n` : ''}

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

function gitHead(directory) {
  return execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
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
  assert.match(preamble, /Commit your work on the current branch/);
  assert.match(preamble, /Never push\. Never change branches\./);
  assert.match(preamble, /Co-Authored-By: Codex <noreply@openai\.com>/);
  assert.match(exchangePreamble(seat, 'claude'), /Co-Authored-By: Claude Code <noreply@anthropic\.com>/);
  assert.match(preamble, /SHA: <the full commit SHA you made>/);
  assert.match(preamble, /In a managed clone seat, your own \.git directory is writable/);
  assert.match(preamble, /Ordinary git add, git commit, git log, and git status work/);
  assert.match(preamble, /If git add reports "Operation not permitted", this seat lacks the clone Git-directory grant/);
  assert.match(preamble, /instead of working around it/);
  assert.match(preamble, /harvest --commit as a fallback/);
  assert.match(preamble, /If you made no commit, omit the SHA line entirely and explain why in the Not verified section/);
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

test('writePacket refuses an unreceipted packet and retries only the same inode', (t) => {
  const fixture = createRepoWithSeat(t);
  const seat = createManagedSeat(fixture.repoRoot, fixture.worktreesRoot, crypto.randomUUID());
  const packet = exchangePaths(seat.path).packet;
  fs.writeFileSync(packet, 'unowned packet\n');
  assert.throws(() => writePacket(fixture.repoRoot, seat, 'replacement\n'), {
    code: 'SEAT_MISMATCH',
  });
  assert.equal(fs.readFileSync(packet, 'utf8'), 'unowned packet\n');

  fs.unlinkSync(packet);
  const first = writePacket(fixture.repoRoot, seat, 'first\n');
  const firstStat = fs.statSync(packet);
  const retry = writePacket(fixture.repoRoot, first.seat, 'second\n');
  const retryStat = fs.statSync(packet);
  assert.deepEqual(retry.seat.packetReceipt, { dev: firstStat.dev, ino: firstStat.ino });
  assert.equal(retryStat.ino, firstStat.ino);
  assert.equal(fs.readFileSync(packet, 'utf8'), 'second\n');
});

test('writePacket refuses a pre-existing exchange directory in an external seat', (t) => {
  const fixture = createRepoWithSeat(t);
  const exchange = exchangePaths(fixture.seat).directory;
  fs.mkdirSync(exchange);
  fs.writeFileSync(path.join(exchange, 'external-output.txt'), 'preserve me\n');
  const seat = {
    ...verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot),
    provisioned: plannedProvisionedEntries(fixture.repoRoot),
  };

  assert.throws(() => writePacket(fixture.repoRoot, seat, 'packet\n'), {
    code: 'SEAT_IDENTITY_MISMATCH',
  });
  assert.equal(fs.readFileSync(path.join(exchange, 'external-output.txt'), 'utf8'), 'preserve me\n');
});

test('harvest reports a missing handback without opening a journal', async (t) => {
  const fixture = managedLane(t);
  const result = await harvestLane({
    repoRoot: fixture.repoRoot,
    laneId: fixture.lane.laneId,
  }, fixture.env, { observe: async () => phaseFields('codex', 'idle') });
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
  fs.writeFileSync(exchangePaths(fixture.seat.path).handback, handback({ sha: gitHead(fixture.seat.path) }));
  assert.equal(fs.lstatSync(path.join(fixture.seat.path, 'node_modules')).isSymbolicLink(), true);

  const result = await harvestLane({
    repoRoot: fixture.repoRoot,
    laneId: fixture.lane.laneId,
    commit: true,
  }, fixture.env, { observe: async () => phaseFields('codex', 'idle') });

  assert.equal(result.handback, 'present');
  assert.deepEqual(result.changedFiles, [':(exclude)literal.txt', 'feature.txt']);
  assert.match(result.handbackSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.head, execFileSync('git', ['-C', fixture.seat.path, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim());
  assert.equal(execFileSync('git', ['-C', fixture.repoRoot, 'rev-parse', fixture.seat.branchRef], { encoding: 'utf8' }).trim(), result.head);
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

test('harvest refuses every phase that is not affirmatively quiescent', async (t) => {
  const fixture = managedLane(t, { state: 'active' });
  fs.writeFileSync(exchangePaths(fixture.seat.path).handback, handback({ sha: gitHead(fixture.seat.path) }));
  for (const observation of [
    phaseFields('codex', 'executing'),
    phaseFields('claude', 'waiting'),
    phaseFields('codex', 'unknown'),
    undefined,
  ]) {
    await assert.rejects(() => harvestLane({
      repoRoot: fixture.repoRoot,
      laneId: fixture.lane.laneId,
      commit: false,
    }, fixture.env, observation === undefined ? {} : {
      observe: async () => observation,
    }), (error) => error.code === 'TARGET_ACTIVE' &&
      error.details.nextReadOnlyStep === `lane.js status --lane ${fixture.lane.laneId}`);
  }
  assert.equal(listOperations(fixture.repoRoot, fixture.env).filter((entry) => entry.type === 'harvest').length, 0);
});

test('harvest accepts an idle provider observation', async (t) => {
  const fixture = managedLane(t);
  fs.writeFileSync(exchangePaths(fixture.seat.path).handback, handback({ sha: gitHead(fixture.seat.path) }));
  const result = await harvestLane({
    repoRoot: fixture.repoRoot,
    laneId: fixture.lane.laneId,
    commit: false,
    cleanupProvisioned: false,
  }, fixture.env, { observe: async () => phaseFields('codex', 'idle') });
  assert.equal(result.handback, 'present');
});

test('harvest recovers a commit completed before its journal and durable copy', async (t) => {
  const fixture = managedLane(t);
  fs.writeFileSync(path.join(fixture.seat.path, 'recover.txt'), 'recover me\n');
  fs.writeFileSync(exchangePaths(fixture.seat.path).handback, handback({ sha: gitHead(fixture.seat.path) }));
  await assert.rejects(() => harvestLane({
    repoRoot: fixture.repoRoot,
    laneId: fixture.lane.laneId,
    commit: true,
    cleanupProvisioned: false,
  }, fixture.env, {
    observe: async () => phaseFields('codex', 'idle'),
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
  }, fixture.env, { observe: async () => phaseFields('codex', 'idle') });
  assert.equal(recovered.handback, 'present');
  assert.equal(execFileSync('git', ['-C', fixture.seat.path, 'rev-list', '--count', 'HEAD'], {
    encoding: 'utf8',
  }).trim(), '2');
  assert.equal(listOperations(fixture.repoRoot, fixture.env)
    .find((entry) => entry.operationId === pending.operationId).state, 'complete');
});

test('durable handback fsyncs before rename and fsyncs the directory', async (t) => {
  const fixture = managedLane(t);
  fs.writeFileSync(exchangePaths(fixture.seat.path).handback, handback({ sha: gitHead(fixture.seat.path) }));
  const calls = [];
  const descriptorKinds = new Map();
  const recordingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') return (file, flags, mode) => {
        const descriptor = target.openSync(file, flags, mode);
        descriptorKinds.set(descriptor, flags === 'r' ? 'directory' : 'file');
        calls.push(`open:${descriptorKinds.get(descriptor)}`);
        return descriptor;
      };
      if (property === 'writeFileSync') return (destination, ...args) => {
        if (typeof destination === 'number') calls.push('write:file');
        return target.writeFileSync(destination, ...args);
      };
      if (property === 'fsyncSync') return (descriptor) => {
        calls.push(`fsync:${descriptorKinds.get(descriptor)}`);
        return target.fsyncSync(descriptor);
      };
      if (property === 'closeSync') return (descriptor) => {
        calls.push(`close:${descriptorKinds.get(descriptor)}`);
        descriptorKinds.delete(descriptor);
        return target.closeSync(descriptor);
      };
      if (property === 'renameSync') return (...args) => {
        calls.push('rename');
        return target.renameSync(...args);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  await harvestLane({
    repoRoot: fixture.repoRoot,
    laneId: fixture.lane.laneId,
    commit: false,
    cleanupProvisioned: false,
  }, fixture.env, {
    observe: async () => phaseFields('codex', 'idle'),
    fs: recordingFs,
  });

  assert.deepEqual(calls, [
    'open:file', 'write:file', 'fsync:file', 'close:file',
    'open:directory', 'fsync:directory', 'close:directory',
    'open:file', 'write:file', 'fsync:file', 'close:file', 'rename',
    'open:directory', 'fsync:directory', 'close:directory',
  ]);
});

test('a copied harvest never advances after its durable copy changes', async (t) => {
  const fixture = managedLane(t);
  fs.writeFileSync(exchangePaths(fixture.seat.path).handback, handback({ sha: gitHead(fixture.seat.path) }));
  await assert.rejects(() => harvestLane({
    repoRoot: fixture.repoRoot,
    laneId: fixture.lane.laneId,
    commit: false,
    cleanupProvisioned: false,
  }, fixture.env, {
    observe: async () => phaseFields('codex', 'idle'),
    afterCopy: async () => { throw new Error('simulated operator crash after copy'); },
  }), /simulated operator crash after copy/);
  const operation = listOperations(fixture.repoRoot, fixture.env)
    .find((entry) => entry.type === 'harvest');
  assert.equal(operation.state, 'copied');
  fs.writeFileSync(operation.details.durableHandback, 'changed after copy\n');

  await assert.rejects(() => harvestLane({
    repoRoot: fixture.repoRoot,
    laneId: fixture.lane.laneId,
    commit: false,
    cleanupProvisioned: false,
  }, fixture.env, { observe: async () => phaseFields('codex', 'idle') }), {
    code: 'HARVEST_MISMATCH',
  });
  assert.equal(listOperations(fixture.repoRoot, fixture.env)
    .find((entry) => entry.operationId === operation.operationId).state, 'copied');
});

test('a second harvest keeps the first immutable handback copy', async (t) => {
  const fixture = managedLane(t);
  const handbackFile = exchangePaths(fixture.seat.path).handback;
  const firstText = handback({ title: 'Preserve first durable handback', sha: gitHead(fixture.seat.path) });
  fs.writeFileSync(handbackFile, firstText);
  const first = await harvestLane({
    repoRoot: fixture.repoRoot,
    laneId: fixture.lane.laneId,
    commit: false,
    cleanupProvisioned: false,
  }, fixture.env, { observe: async () => phaseFields('codex', 'idle') });
  const firstCopy = immutableHandbackPath(fixture.lane.laneId, first.handbackSha256, fixture.env);
  assert.equal(fs.readFileSync(firstCopy, 'utf8'), firstText);

  const secondText = handback({ title: 'Preserve second durable handback', sha: gitHead(fixture.seat.path) });
  fs.writeFileSync(handbackFile, secondText);
  const second = await harvestLane({
    repoRoot: fixture.repoRoot,
    laneId: fixture.lane.laneId,
    commit: false,
    cleanupProvisioned: false,
  }, fixture.env, { observe: async () => phaseFields('codex', 'idle') });
  const secondCopy = immutableHandbackPath(fixture.lane.laneId, second.handbackSha256, fixture.env);
  const latest = path.join(fixture.stateDir, 'harvests', fixture.lane.laneId, 'handback.md');
  assert.notEqual(firstCopy, secondCopy);
  assert.equal(fs.readFileSync(firstCopy, 'utf8'), firstText);
  assert.equal(fs.readFileSync(secondCopy, 'utf8'), secondText);
  assert.equal(fs.readFileSync(latest, 'utf8'), secondText);
});

function childCommit(fixture, content = 'child work\n') {
  fs.writeFileSync(path.join(fixture.seat.path, 'child.txt'), content);
  execFileSync('git', ['-C', fixture.seat.path, 'add', 'child.txt']);
  execFileSync('git', ['-C', fixture.seat.path, 'commit', '-qm',
    'Implement child-owned commit\n\nComplete the assigned feature.\n\nCo-Authored-By: Codex <noreply@openai.com>']);
  return gitHead(fixture.seat.path);
}

function writeChildHandback(fixture, sha) {
  fs.writeFileSync(exchangePaths(fixture.seat.path).handback, handback({ sha }));
}

function harvestOptions(fixture, extra = {}) {
  return { repoRoot: fixture.repoRoot, laneId: fixture.lane.laneId, ...extra };
}

const idleProvider = { observe: async () => phaseFields('codex', 'idle') };

test('child commits in a clone and harvest fetches the exact SHA before clone retirement', async (t) => {
  const fixture = managedLane(t, { dependencies: true });
  const head = childCommit(fixture);
  writeChildHandback(fixture, head);
  assert.throws(() => execFileSync('git', ['-C', fixture.repoRoot, 'cat-file', '-e', head], { stdio: 'pipe' }));
  const result = await harvestLane(harvestOptions(fixture), fixture.env, idleProvider);
  assert.equal(result.head, head);
  assert.equal(require('../scripts/lib/output-schema').publicResult(result).childReportedCommit, true);
  assert.equal(fs.existsSync(path.join(fixture.seat.path, '.transmogrify')), false);
  assert.equal(execFileSync('git', ['-C', fixture.repoRoot, 'rev-parse', fixture.seat.branchRef], {
    encoding: 'utf8',
  }).trim(), head);
  assert.equal(cleanupStatus(fixture.seat.path).clean, true);
  assert.equal(execFileSync('git', ['-C', fixture.seat.path, 'show', '-s', '--format=%an <%ae>', head], {
    encoding: 'utf8',
  }).trim(), 'Test <test@example.invalid>');
  const receipt = captureHarvestReceipt(fixture.repoRoot, fixture.seat, result.handbackSha256);
  updateLane(fixture.repoRoot, fixture.lane.laneId, { state: 'retireRequested' }, fixture.env);
  updateLane(fixture.repoRoot, fixture.lane.laneId, { state: 'archivedVerified' }, fixture.env);
  removeManagedSeat(fixture.repoRoot, fixture.lane.laneId, receipt, fixture.env);
  assert.equal(fs.existsSync(fixture.seat.path), false);
  assert.equal(execFileSync('git', ['-C', fixture.repoRoot, 'show', `${head}:child.txt`], {
    encoding: 'utf8',
  }), 'child work\n');
});

test('harvest refuses a handback SHA that is not the clone HEAD before opening a journal', async (t) => {
  const fixture = managedLane(t);
  const oldHead = gitHead(fixture.seat.path);
  childCommit(fixture);
  writeChildHandback(fixture, oldHead);
  await assert.rejects(() => harvestLane(harvestOptions(fixture), fixture.env, idleProvider), /SHA is not the clone HEAD/);
  assert.equal(listOperations(fixture.repoRoot, fixture.env).filter((operation) => operation.type === 'harvest').length, 0);
  assert.equal(fs.existsSync(exchangePaths(fixture.seat.path).handback), true);
});

test('harvest refuses non-fast-forward clone history and preserves the repository branch', async (t) => {
  const fixture = managedLane(t);
  const first = childCommit(fixture);
  writeChildHandback(fixture, first);
  await harvestLane(harvestOptions(fixture, { cleanupProvisioned: false }), fixture.env, idleProvider);
  execFileSync('git', ['-C', fixture.seat.path, 'reset', '--hard', fixture.seat.baseCommit], { stdio: 'pipe' });
  const divergent = childCommit(fixture, 'divergent work\n');
  writeChildHandback(fixture, divergent);
  await assert.rejects(() => harvestLane(harvestOptions(fixture, { cleanupProvisioned: false }), fixture.env, idleProvider),
    /non-fast-forward/);
  assert.equal(execFileSync('git', ['-C', fixture.repoRoot, 'rev-parse', fixture.seat.branchRef], {
    encoding: 'utf8',
  }).trim(), first);
  assert.equal(fs.existsSync(exchangePaths(fixture.seat.path).handback), true);
});

test('harvest advances an existing clone branch and --commit accepts an already committed child', async (t) => {
  const fixture = managedLane(t);
  writeChildHandback(fixture, childCommit(fixture));
  await harvestLane(harvestOptions(fixture, { cleanupProvisioned: false }), fixture.env, idleProvider);
  const head = childCommit(fixture, 'next child commit\n');
  writeChildHandback(fixture, head);
  const result = await harvestLane(harvestOptions(fixture, { commit: true }), fixture.env, idleProvider);
  assert.equal(result.head, head);
  assert.equal(gitHead(fixture.seat.path), head);
});

test('clone harvest requires a SHA and refuses uncommitted work without the fallback', async (t) => {
  const fixture = managedLane(t);
  fs.writeFileSync(exchangePaths(fixture.seat.path).handback, handback());
  await assert.rejects(() => harvestLane(harvestOptions(fixture), fixture.env, idleProvider), /requires the child commit SHA/);
  writeChildHandback(fixture, gitHead(fixture.seat.path));
  fs.writeFileSync(path.join(fixture.seat.path, 'unfinished.txt'), 'unfinished\n');
  await assert.rejects(() => harvestLane(harvestOptions(fixture), fixture.env, idleProvider), /uncommitted changes/);
});


test('clone harvest refuses a HEAD change after copy before removing provisions', async (t) => {
  const fixture = managedLane(t);
  writeChildHandback(fixture, childCommit(fixture));
  await assert.rejects(() => harvestLane(harvestOptions(fixture), fixture.env, {
    ...idleProvider,
    afterCopy: async () => { childCommit(fixture, 'changed after fetch\n'); },
  }), /HEAD changed after the handback was fetched/);
  assert.equal(fs.existsSync(exchangePaths(fixture.seat.path).handback), true);
  assert.equal(listOperations(fixture.repoRoot, fixture.env)
    .find((operation) => operation.type === 'harvest').state, 'copied');
});

test('handback parsing treats non-40-hex SHA reports as absent and removes them from the commit body', () => {
  for (const sha of ['unavailable — git add was denied', 'a'.repeat(39), 'a'.repeat(64), 'g'.repeat(40), '']) {
    const text = handback({ body: `Explain the completed change.\n\nSHA: ${sha}` });
    const parsed = parseHandback(text);
    assert.equal(parsed.commitSha, null);
    assert.equal(parsed.body, 'Explain the completed change.');
    assert.match(parsed.text, /SHA:/, 'the durable handback retains the child report');
  }
  assert.equal(parseHandback(handback({ sha: 'A'.repeat(40) })).commitSha, 'a'.repeat(40));
});

test('operator fallback harvests an unavailable SHA report and publicly records no child commit', async (t) => {
  const fixture = managedLane(t);
  fs.writeFileSync(path.join(fixture.seat.path, 'fallback.txt'), 'completed work\n');
  fs.writeFileSync(exchangePaths(fixture.seat.path).handback,
    handback({ sha: 'unavailable — git add reported Operation not permitted' }));
  const options = harvestOptions(fixture, { commit: true });
  const result = await harvestLane(options, fixture.env, idleProvider);
  const { publicResult } = require('../scripts/lib/output-schema');
  assert.equal(publicResult(result).childReportedCommit, false);
  assert.equal(execFileSync('git', ['-C', fixture.repoRoot, 'show', `${result.head}:fallback.txt`], {
    encoding: 'utf8',
  }), 'completed work\n');
  assert.doesNotMatch(execFileSync('git', ['-C', fixture.repoRoot, 'show', '-s', '--format=%B', result.head], {
    encoding: 'utf8',
  }), /SHA:|unavailable/);
  const repeated = await harvestLane(options, fixture.env, idleProvider);
  assert.equal(publicResult(repeated).childReportedCommit, false);
  assert.equal(repeated.head, result.head);
});

test('operator fallback accepts an omitted SHA and preserves the no-commit report across crash recovery', async (t) => {
  const fixture = managedLane(t);
  fs.writeFileSync(path.join(fixture.seat.path, 'fallback.txt'), 'completed work\n');
  fs.writeFileSync(exchangePaths(fixture.seat.path).handback, handback());
  const options = harvestOptions(fixture, { commit: true });
  await assert.rejects(() => harvestLane(options, fixture.env, {
    ...idleProvider,
    afterCommit: async () => { throw new Error('fixture crash after fallback'); },
  }), /fixture crash after fallback/);
  const committedHead = gitHead(fixture.seat.path);
  const result = await harvestLane(options, fixture.env, idleProvider);
  assert.equal(result.childReportedCommit, false);
  assert.equal(result.head, committedHead);
});

test('operator harvest disables child-configured hooks and fsmonitor and fetches without submodule recursion', async (t) => {
  const fixture = managedLane(t);
  const marker = path.join(fixture.root, 'executed-helpers');
  const hooks = path.join(fixture.seat.gitDir, 'hostile-hooks');
  const monitor = path.join(fixture.seat.gitDir, 'hostile-fsmonitor');
  fs.mkdirSync(hooks);
  const quote = (value) => `'${value.replace(/'/gu, `'\\''`)}'`;
  fs.writeFileSync(path.join(hooks, 'post-commit'), `#!/bin/sh\nprintf 'hook\\n' >> ${quote(marker)}\n`, { mode: 0o700 });
  fs.writeFileSync(monitor, `#!/bin/sh\nprintf 'fsmonitor\\n' >> ${quote(marker)}\nprintf 'token\\000'\n`, { mode: 0o700 });
  for (const [key, value] of [['core.hooksPath', hooks], ['core.fsmonitor', monitor]]) {
    execFileSync('git', ['-C', fixture.seat.path, 'config', key, value]);
  }
  // Positive controls prove the planted helpers execute without host overrides.
  execFileSync('git', ['-C', fixture.seat.path, 'status', '--porcelain'], { stdio: 'pipe' });
  execFileSync('git', ['-C', fixture.seat.path, 'commit', '--allow-empty', '-qm', 'Exercise fixture helpers'], { stdio: 'pipe' });
  assert.match(fs.readFileSync(marker, 'utf8'), /fsmonitor/);
  assert.match(fs.readFileSync(marker, 'utf8'), /hook/);
  fs.unlinkSync(marker);
  fs.writeFileSync(path.join(fixture.seat.path, 'safe-fallback.txt'), 'reviewed fallback\n');
  fs.writeFileSync(exchangePaths(fixture.seat.path).handback, handback());

  // Record actual process argv while delegating to real Git. This also covers
  // the local upload-pack child receiving the sanitized config environment.
  const bin = path.join(fixture.root, 'git-wrapper');
  const argvLog = path.join(fixture.root, 'git-argv.jsonl');
  fs.mkdirSync(bin);
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\n` +
    `require('node:fs').appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n` +
    `const result = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit', env: process.env });\n` +
    `process.exit(result.status ?? 1);\n`, { mode: 0o700 });
  const priorPath = process.env.PATH;
  let result;
  try {
    process.env.PATH = `${bin}${path.delimiter}${priorPath}`;
    result = await harvestLane(harvestOptions(fixture, { commit: true }), fixture.env, idleProvider);
  } finally {
    process.env.PATH = priorPath;
  }
  assert.equal(fs.existsSync(marker), false);
  assert.equal(execFileSync('git', ['-C', fixture.repoRoot, 'show', `${result.head}:safe-fallback.txt`], {
    encoding: 'utf8',
  }), 'reviewed fallback\n');
  const calls = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  for (const command of ['status', 'add', 'commit', 'fetch']) {
    const call = calls.find((args) => args.includes(command));
    assert.ok(call, `harvest ran ${command}`);
    const hooksSetting = call.find((arg) => arg.startsWith('core.hooksPath='));
    assert.ok(hooksSetting);
    assert.equal(call[call.indexOf(hooksSetting) - 1], '-c');
    assert.deepEqual(fs.readdirSync(hooksSetting.slice('core.hooksPath='.length)), []);
    for (const setting of ['core.fsmonitor=false', 'core.sshCommand=']) {
      assert.equal(call[call.indexOf(setting) - 1], '-c');
    }
  }
  assert.ok(calls.find((args) => args.includes('fetch')).includes('--no-recurse-submodules'));
});
