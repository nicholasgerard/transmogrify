'use strict';

// Read-only compatibility measurement for the Codex app-server methods this
// tree relies on. Destructive-looking method names are addressed only to the
// nil UUID, which cannot identify a real Codex thread; a recognized not-found
// refusal is compatibility evidence, while method or parameter rejection is
// not. Rules and runtime version identify the cache; failed measurements expire.

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

const PROBE_SET_VERSION = 1;
const FAILED_TTL_MS = 24 * 60 * 60 * 1000;
// These responses were measured against both builds. Anchor the whole message
// and include the exact sentinel so an unrelated failure cannot authorize writes.
const patterns = Object.freeze({
  'turn/steer': new RegExp(`^thread not found: ${NIL_ID}$`),
  'thread/name/set': new RegExp(`^no rollout found for thread id ${NIL_ID}$`),
  'thread/archive': new RegExp(`^no rollout found for thread id ${NIL_ID}$`),
});
const notFoundPatterns = Object.freeze({ '0.151.0': patterns, '0.153.4': patterns });
const NEWEST_MEASURED_VERSION = '0.153.4';

function runtimeCompatibilityFile(runtimeVersion, env = process.env) {
  const key = crypto.createHash('sha256').update(`${PROBE_SET_VERSION}:${runtimeVersion}`).digest('hex');
  return path.join(stateRoot(env), 'measured-runtimes', `${key}.json`);
}

function readCachedCompatibility(runtimeVersion, env = process.env, now = new Date()) {
  const read = readOwnedJson(runtimeCompatibilityFile(runtimeVersion, env), {
    maxBytes: MAX_RECORD_BYTES, modeMask: 0o077,
  });
  if (read.status === 'missing') return null;
  if (read.status !== 'ok') {
    const error = new Error('Codex compatibility record is not readable owner-only state');
    error.code = read.status === 'unsafe' ? 'UNSAFE_LOCAL_STATE' : 'INVALID_LOCAL_STATE';
    throw error;
  }
  const record = read.value;
  // Old rules are not authority for the current probe set.
  if (record?.probeSetVersion !== PROBE_SET_VERSION || record?.version !== 2) return null;
  if (!record || record.provider !== 'codex-app-server' ||
      record.runtimeVersion !== runtimeVersion || !['good', 'failed', 'unmeasured'].includes(record.result) ||
      !Number.isFinite(Date.parse(record.measuredAt)) || !Array.isArray(record.probes) ||
      record.probes.some((probe) => !probe || typeof probe.method !== 'string' ||
        typeof probe.ok !== 'boolean' ||
        !['validated-success', 'not-found', 'unmeasured', 'rejected'].includes(probe.evidence)) ||
      (record.result === 'failed' && typeof record.failingMethod !== 'string')) {
    throw Object.assign(new Error('Codex compatibility record has an invalid shape'), { code: 'INVALID_LOCAL_STATE' });
  }
  if (record.result === 'failed' && (now.getTime() - Date.parse(record.measuredAt) >= FAILED_TTL_MS ||
      record.probes.some((probe) => probe.method === record.failingMethod && probe.evidence === 'unmeasured'))) return null;
  if (record.result === 'good' && probeDefinitions().some((definition) =>
    !record.probes.some((probe) => probe.method === definition.method && probe.ok &&
      probe.evidence === (definition.validate ? 'validated-success' : 'not-found')))) return null;
  return record;
}

function probeDefinitions() {
  return [
    {
      method: 'thread/list',
      params: { archived: true, cursor: null, limit: 1, sourceKinds: SOURCE_KINDS, useStateDbOnly: true },
      validate(result) { return Array.isArray(result?.data) &&
        result.data.every((row) => row && typeof row === 'object' && typeof row.id === 'string') &&
        (result.nextCursor == null || typeof result.nextCursor === 'string'); },
    },
    {
      method: 'turn/steer',
      params: {
        threadId: NIL_ID, expectedTurnId: NIL_ID, clientUserMessageId: NIL_ID,
        input: [{ type: 'text', text: 'compatibility probe' }],
      },
    },
    { method: 'thread/name/set', params: { threadId: NIL_ID, name: '::: compatibility probe' } },
    { method: 'thread/archive', params: { threadId: NIL_ID } },
  ];
}

function compatibilityRecord(runtimeVersion, probes, result, failingMethod, now) {
  return {
    version: 2, provider: 'codex-app-server', probeSetVersion: PROBE_SET_VERSION,
    runtimeVersion, measuredAt: now.toISOString(),
    patternRuntimeVersion: notFoundPatterns[runtimeVersion] ? runtimeVersion : NEWEST_MEASURED_VERSION,
    patternsMeasured: Boolean(notFoundPatterns[runtimeVersion]),
    result, probes, ...(failingMethod ? { failingMethod } : {}),
  };
}

async function measureCodexCompatibility(client, runtimeVersion, options = {}) {
  const env = options.env || process.env;
  const now = options.now || (() => new Date());
  const cached = readCachedCompatibility(runtimeVersion, env, now());
  if (cached && cached.result !== 'unmeasured') return cached;
  const write = options.atomicWriteJson || atomicWriteJson;
  const probes = [];
  const finish = (result, failingMethod, persist = true) => {
    probes.push(cached?.probes.find((probe) => probe.method === 'thread/turns/list') ||
      { method: 'thread/turns/list', ok: false, evidence: 'unmeasured' });
    const record = compatibilityRecord(runtimeVersion, probes, result, failingMethod, now());
    if (persist) write(runtimeCompatibilityFile(runtimeVersion, env), record);
    return record;
  };
  if (!supportedRuntimeVersion(runtimeVersion)) {
    probes.push({ method: 'minimum-version', ok: false, evidence: 'rejected' });
    return finish('failed', 'minimum-version');
  }
  const methodPatterns = notFoundPatterns[runtimeVersion] || notFoundPatterns[NEWEST_MEASURED_VERSION];
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  for (const probe of probeDefinitions()) {
    let ok = false;
    let transient = false;
    let evidence = 'rejected';
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Object.assign(new Error('measurement deadline'), { code: 'TRANSPORT_UNKNOWN' });
      const result = await client.call(probe.method, probe.params, remaining);
      // A mutation succeeding on the sentinel violates the safety assumption.
      ok = Boolean(probe.validate && probe.validate(result));
      if (ok) evidence = 'validated-success';
    } catch (error) {
      transient = error?.code !== 'RPC_ERROR';
      ok = !probe.validate && error?.code === 'RPC_ERROR' && error.rpc?.code === -32600 &&
        typeof error.rpc.message === 'string' && methodPatterns[probe.method].exec(error.rpc.message)?.[0] === error.rpc.message;
      evidence = ok ? 'not-found' : transient ? 'unmeasured' : 'rejected';
    }
    probes.push({ method: probe.method, ok, evidence });
    if (!ok) return finish('failed', probe.method, !transient);
  }
  return finish('good');
}

// Only callers that have verified an exact owned thread may supply positive
// evidence. A failed read does not establish unsupported capability.
function recordTurnsListEvidence(runtimeVersion, ok, options = {}) {
  if (ok !== true) return null;
  const env = options.env || process.env;
  const now = (options.now || (() => new Date()))();
  const record = readCachedCompatibility(runtimeVersion, env, now) ||
    compatibilityRecord(runtimeVersion, [], 'unmeasured', null, now);
  if (record.probes.some((probe) => probe.method === 'thread/turns/list' && probe.ok &&
      probe.evidence === 'validated-success')) return record;
  record.probes = record.probes.filter((probe) => probe.method !== 'thread/turns/list');
  record.probes.push({ method: 'thread/turns/list', ok: true, evidence: 'validated-success' });
  (options.atomicWriteJson || atomicWriteJson)(runtimeCompatibilityFile(runtimeVersion, env), record);
  return record;
}

module.exports = {
  NIL_ID, SOURCE_KINDS, PROBE_SET_VERSION, FAILED_TTL_MS, notFoundPatterns,
  measureCodexCompatibility, readCachedCompatibility, recordTurnsListEvidence,
  runtimeCompatibilityFile, supportedRuntimeVersion,
};
