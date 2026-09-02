'use strict';

const fs = require('node:fs');
const { acquireLock, releaseLock } = require('../../scripts/lib/state');

const [lockDirectory, eventsFile, workerId, ownerlessGrace] = process.argv.slice(2);
const owner = acquireLock(lockDirectory, {
  waitMs: 10000,
  pollMs: 5,
  ...(ownerlessGrace === undefined ? {} : { ownerlessGraceMs: Number(ownerlessGrace) }),
});
fs.appendFileSync(eventsFile, `enter ${workerId}\n`);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
fs.appendFileSync(eventsFile, `exit ${workerId}\n`);
releaseLock(lockDirectory, owner);
