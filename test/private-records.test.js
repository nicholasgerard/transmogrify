'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { readOwnedText } = require('../scripts/lib/record-guards');
const { projectPaths, readRegistry } = require('../scripts/lib/state');
const { createStateFixture } = require('./helpers/state-fixture');

for (const hazard of ['0644', 'foreign owner', 'FIFO', 'oversized file', 'symlink swap', 'invalid shape']) {
  test(`private registry reads refuse ${hazard}`, (t) => {
    const fixture = createStateFixture(t);
    const file = projectPaths(fixture.repoRoot, fixture.env).registry;
    if (hazard === '0644') fs.chmodSync(file, 0o644);
    if (hazard === 'foreign owner') {
      const target = fs.statSync(file).ino;
      const original = fs.fstatSync;
      t.mock.method(fs, 'fstatSync', (fd, ...args) => {
        const stat = original(fd, ...args);
        if (stat.ino === target) stat.uid += 1;
        return stat;
      });
    }
    if (hazard === 'FIFO') { fs.unlinkSync(file); execFileSync('mkfifo', ['-m', '600', file]); }
    if (hazard === 'oversized file') fs.truncateSync(file, 8 * 1024 * 1024 + 1);
    if (hazard === 'invalid shape') fs.writeFileSync(file, '[]');
    if (hazard === 'symlink swap') {
      const original = fs.openSync;
      const target = path.join(fixture.root, 'redirect.json');
      fs.copyFileSync(file, target);
      t.mock.method(fs, 'openSync', (name, flags, ...args) => {
        if (name === file) { fs.unlinkSync(file); fs.symlinkSync(target, file); }
        return original(name, flags, ...args);
      });
    }
    assert.throws(() => readRegistry(fixture.repoRoot, fixture.env),
      (error) => ['UNSAFE_LOCAL_STATE', 'INVALID_LOCAL_STATE'].includes(error.code));
  });
}

test('private text reads stay bounded when a file grows after fstat', (t) => {
  const fixture = createStateFixture(t);
  const file = path.join(fixture.root, 'growing.txt');
  fs.writeFileSync(file, 'small', { mode: 0o600 });
  const original = fs.readSync;
  let reads = 0;
  t.mock.method(fs, 'readSync', (...args) => {
    if (reads++ === 0) fs.appendFileSync(file, 'x'.repeat(200));
    return original(...args);
  });
  assert.equal(readOwnedText(file, { maxBytes: 32, modeMask: 0o077 }).status, 'unsafe');
  assert.equal(reads, 1);
});

test('private descriptor reads preserve the producer snapshot when its pathname is replaced', (t) => {
  const fixture = createStateFixture(t);
  const file = projectPaths(fixture.repoRoot, fixture.env).registry;
  const expected = fs.readFileSync(file, 'utf8');
  const redirect = path.join(fixture.root, 'redirect.json');
  fs.writeFileSync(redirect, '{"redirected":true}', { mode: 0o600 });
  const original = fs.readSync;
  let swapped = false;
  t.mock.method(fs, 'readSync', (...args) => {
    if (!swapped) {
      swapped = true;
      fs.unlinkSync(file);
      fs.symlinkSync(redirect, file);
    }
    return original(...args);
  });
  const read = readOwnedText(file, { maxBytes: 8 * 1024 * 1024, modeMask: 0o077 });
  assert.equal(read.status, 'ok');
  assert.equal(read.value, expected);
});

test('private lock reads validate the owner receipt before process inspection', (t) => {
  const fixture = createStateFixture(t);
  const { acquireLock, releaseLock } = require('../scripts/lib/state');
  const directory = path.join(fixture.root, 'shape-lock');
  const owner = acquireLock(directory);
  const file = path.join(directory, 'owner.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ ...owner, pid: -1 }));
    assert.throws(() => acquireLock(directory), { code: 'INVALID_LOCAL_STATE' });
  } finally {
    fs.writeFileSync(file, JSON.stringify(owner));
    releaseLock(directory, owner);
  }
});
