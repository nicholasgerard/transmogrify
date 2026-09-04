'use strict';

// Read-only compatibility measurement for the Codex app-server methods this
// tree relies on. Destructive-looking method names are addressed only to the
// nil UUID, which cannot identify a real Codex thread; a recognized not-found
// refusal is compatibility evidence, while method or parameter rejection is
// not. Results are cached once per reported runtime version.

const crypto = require('node:crypto');
const path = require('node:path');
const { atomicWriteJson, stateRoot } = require('./state');
const { readOwnedJson } = require('./record-guards');
const { MINIMUM_APP_SERVER_VERSION } = require('./app-server');

const NIL_ID = '00000000-0000-0000-0000-000000000000';
const MAX_RECORD_BYTES = 64 * 1024;
const SOURCE_KINDS = [
  'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown',
];

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version || '');
  return match ? match.slice(1).map(Number) : null;
}

function supportedRuntimeVersion(version) {
  const observed = versionParts(version);
  const minimum = versionParts(MINIMUM_APP_SERVER_VERSION);
  if (!observed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (observed[index] !== minimum[index]) return observed[index] > minimum[index];
  }
  return true;
}

function runtimeCompatibilityFile(runtimeVersion, env = process.env) {
  const key = crypto.createHash('sha256').update(runtimeVersion).digest('hex');
  return path.join(stateRoot(env), 'measured-runtimes', `${key}.json`);
}

function readCachedCompatibility(runtimeVersion, env = process.env) {
  const read = readOwnedJson(runtimeCompatibilityFile(runtimeVersion, env), {
    maxBytes: MAX_RECORD_BYTES,
    modeMask: 0o077,
  });
  if (read.status === 'missing') return null;
  if (read.status !== 'ok') {
    const error = new Error(read.status === 'unsafe'
      ? 'Codex compatibility record is not owner-only'
      : 'Codex compatibility record is invalid');
    error.code = read.status === 'unsafe' ? 'UNSAFE_LOCAL_STATE' : 'INVALID_LOCAL_STATE';
    throw error;
  }
  const record = read.value;
  if (!record || record.version !== 1 || record.provider !== 'codex-app-server' ||
      record.runtimeVersion !== runtimeVersion || !['good', 'failed'].includes(record.result) ||
      typeof record.measuredAt !== 'string' || !Array.isArray(record.probes) ||
      record.probes.some((probe) => !probe || typeof probe.method !== 'string' ||
        typeof probe.ok !== 'boolean') ||
      (record.result === 'failed' && typeof record.failingMethod !== 'string')) {
    const error = new Error('Codex compatibility record has an invalid shape');
    error.code = 'INVALID_LOCAL_STATE';
    throw error;
  }
  return record;
}

function parameterRejection(error) {
  if (error?.code !== 'RPC_ERROR') return true;
  if (error.rpc?.code === -32601 || error.rpc?.code === -32602) return true;
  return /method not found|invalid params|unknown field|missing field|deserialize|expected .*field/i
    .test(JSON.stringify(error.rpc || {}));
}

function probeDefinitions() {
  return [
    {
      method: 'thread/list',
      params: { archived: true, cursor: null, limit: 1, sourceKinds: SOURCE_KINDS, useStateDbOnly: true },
      validate(result) { return Array.isArray(result?.data); },
    },
    {
      method: 'thread/turns/list',
      params: { threadId: NIL_ID, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' },
      validate(result) { return Array.isArray(result?.data); },
    },
    {
      method: 'turn/steer',
      params: {
        threadId: NIL_ID,
        expectedTurnId: NIL_ID,
        clientUserMessageId: NIL_ID,
        input: [{ type: 'text', text: 'compatibility probe' }],
      },
    },
    { method: 'thread/name/set', params: { threadId: NIL_ID, name: '::: compatibility probe' } },
    { method: 'thread/archive', params: { threadId: NIL_ID } },
  ];
}

function compatibilityRecord(runtimeVersion, probes, result, failingMethod, now) {
  return {
    version: 1,
    provider: 'codex-app-server',
    runtimeVersion,
    measuredAt: now.toISOString(),
    result,
    probes,
    ...(failingMethod ? { failingMethod } : {}),
  };
}

async function measureCodexCompatibility(client, runtimeVersion, options = {}) {
  const env = options.env || process.env;
  const cached = readCachedCompatibility(runtimeVersion, env);
  if (cached) return cached;
  const now = options.now || (() => new Date());
  const write = options.atomicWriteJson || atomicWriteJson;
  const probes = [];

  if (!supportedRuntimeVersion(runtimeVersion)) {
    const record = compatibilityRecord(
      runtimeVersion, [{ method: 'minimum-version', ok: false }],
      'failed', 'minimum-version', now(),
    );
    write(runtimeCompatibilityFile(runtimeVersion, env), record);
    return record;
  }

  const deadline = Date.now() + (options.timeoutMs || 20_000);
  for (const probe of probeDefinitions()) {
    let ok = false;
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await client.call(probe.method, probe.params, remaining);
      ok = probe.validate ? probe.validate(result) : true;
    } catch (error) {
      // A resource-level refusal proves that the method and its parameter
      // shape were understood. Transport, missing-method, and shape errors do
      // not. No raw runtime text enters the cache or doctor output.
      ok = !parameterRejection(error);
    }
    probes.push({ method: probe.method, ok });
    if (!ok) {
      const record = compatibilityRecord(runtimeVersion, probes, 'failed', probe.method, now());
      write(runtimeCompatibilityFile(runtimeVersion, env), record);
      return record;
    }
  }
  const record = compatibilityRecord(runtimeVersion, probes, 'good', null, now());
  write(runtimeCompatibilityFile(runtimeVersion, env), record);
  return record;
}

module.exports = {
  NIL_ID,
  SOURCE_KINDS,
  measureCodexCompatibility,
  runtimeCompatibilityFile,
  supportedRuntimeVersion,
};
