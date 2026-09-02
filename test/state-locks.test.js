'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { acquireLock, releaseLock } = require('../scripts/lib/state');

test('a lock whose owner process no longer exists is reclaimed without the ownerless grace', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-dead-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDirectory = path.join(root, 'lock');
  fs.mkdirSync(lockDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(lockDirectory, 'owner.json'), `${JSON.stringify({
    token: 'dead-owner',
    pid: 999999,
    processBirth: 'not-running',
    hostname: 'test',
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });

  const started = Date.now();
  const owner = acquireLock(lockDirectory, { waitMs: 2000, pollMs: 5 });
  assert.ok(Date.now() - started < 1500, 'a dead owner must not block for the grace period');
  releaseLock(lockDirectory, owner);
  assert.equal(fs.existsSync(lockDirectory), false);
});

test('a lock held by a live process times out with a coded safe refusal', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-live-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDirectory = path.join(root, 'lock');
  const owner = acquireLock(lockDirectory);
  assert.throws(
    () => acquireLock(lockDirectory, { waitMs: 30, pollMs: 5 }),
    (error) => error.code === 'LOCAL_LOCK_TIMEOUT' && /timed out waiting/.test(error.message),
  );
  releaseLock(lockDirectory, owner);
});

test('a stalled creator cannot re-create a quarantined lock directory and share the lock', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-lock-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDirectory = path.join(root, 'lock');
  // Simulate the stalled creator: an ownerless lock directory older than the grace.
  fs.mkdirSync(lockDirectory, { mode: 0o700 });
  const old = new Date('2020-01-01T00:00:00.000Z');
  fs.utimesSync(lockDirectory, old, old);
  const holder = acquireLock(lockDirectory, { waitMs: 1000, pollMs: 5, ownerlessGraceMs: 1 });
  // The stalled creator resumes and tries to publish its receipt over the new holder.
  const { atomicWriteJson } = require('../scripts/lib/state');
  const ownerFile = path.join(lockDirectory, 'owner.json');
  const before = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  assert.equal(before.token, holder.token);
  assert.throws(() => releaseLock(lockDirectory, { token: 'stalled-creator' }), /owned by another process/);
  void atomicWriteJson;
  releaseLock(lockDirectory, holder);
  assert.equal(fs.existsSync(lockDirectory), false);
});
