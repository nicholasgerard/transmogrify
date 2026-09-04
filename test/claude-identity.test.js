'use strict';

// scripts/lib/claude-identity.js and scripts/lib/claude-runtime.js: the durable
// Claude runtime tuple stays exact. Preflight's build-measurement receipt is
// diagnostic output and is stripped before anything is persisted or compared,
// so a lane spawned by a measured CLI still round-trips through the registry.

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateClaudeRuntime } = require('../scripts/lib/claude-identity');
const { publicRuntime, sameRuntime } = require('../scripts/lib/claude-runtime');

function runtime(extra = {}) {
  return {
    protocolGeneration: 1,
    platform: 'darwin',
    arch: 'arm64',
    cliPath: '/opt/claude/bin/claude',
    cliVersion: '2.1.258',
    cliSha256: 'a'.repeat(64),
    configDir: '/Users/owner/.claude',
    configDevice: 1,
    configInode: 2,
    projectsDirectory: '/Users/owner/.claude/projects',
    projectsDevice: 1,
    projectsInode: 3,
    accountFingerprint: 'b'.repeat(64),
    ...extra,
  };
}

const measured = {
  cliMeasurement: { result: 'good', source: 'verified-build-fast-path', measuredAt: '2026-09-04T20:45:03.498Z' },
  cleanEnv: { PATH: '/bin' },
  orgId: 'org-test',
};

test('the persisted runtime tuple carries no measurement receipt, environment, or org id', () => {
  const persisted = publicRuntime(runtime(measured));
  assert.deepEqual(persisted, runtime());
  assert.doesNotThrow(() => validateClaudeRuntime(persisted));
});

test('a measured preflight still matches the tuple recorded at spawn', () => {
  const recorded = JSON.parse(JSON.stringify(publicRuntime(runtime(measured))));
  assert.equal(sameRuntime(recorded, runtime({
    ...measured,
    cliMeasurement: { result: 'good', source: 'live-probe', measuredAt: '2026-09-05T01:00:00.000Z' },
  })), true);
  assert.equal(sameRuntime(recorded, runtime({ ...measured, cliSha256: 'c'.repeat(64) })), false);
});

test('the identity validator rejects a receipt or environment that leaked into a record', () => {
  assert.throws(() => validateClaudeRuntime(runtime({ cliMeasurement: measured.cliMeasurement })), /unsupported field cliMeasurement/);
  assert.throws(() => validateClaudeRuntime(runtime({ cleanEnv: {} })), /unsupported field cleanEnv/);
});
