'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AppServerClient } = require('../scripts/lib/app-server');
const { withClient, inspectThread } = require('../scripts/lib/codex-runtime');
const {
  NIL_ID, PROBE_SET_VERSION, FAILED_TTL_MS, measureCodexCompatibility,
  runtimeCompatibilityFile, recordTurnsListEvidence,
} = require('../scripts/lib/codex-compat');
const { startMockAppServer } = require('./helpers/mock-app-server');
const { measuredReply, mockCodexClient } = require('./helpers/measured-codex');

function privateState(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-codex-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { TRANSMOGRIFY_STATE_DIR: path.join(root, 'state') };
}

const failures = {
  'unknown method fails the probe': { error: { code: -32600, message: 'Invalid request: unknown variant `no/such/method`, expected one of ...' } },
  'missing field fails the probe': { error: { code: -32600, message: 'Invalid request: missing field `name`' } },
  'internal error fails the probe': { error: { code: -32600, message: 'internal error' } },
  'success on nil id fails the safety assumption': { result: {} },
  'wrong nil id fails the probe': { error: { code: -32600, message: 'thread not found: another-thread' } },
  'unanchored not-found fails the probe': { error: { code: -32600, message: `thread not found: ${NIL_ID} extra` } },
  'wrong error code fails the probe': { error: { code: -32602, message: `thread not found: ${NIL_ID}` } },
  'another method not-found fails the probe': { error: { code: -32600, message: `no rollout found for thread id ${NIL_ID}` } },
};
// The same measured cases also traverse JSON-RPC framing on the host. This
// test requires loopback permission and is separately named for the operator.
test('mock app-server measured error cases drive real compatibility measurement over WebSocket', async (t) => {
  for (const [name, reply] of [['not-found', null], ...Object.entries(failures)]) {
    const env = privateState(t);
    const server = await startMockAppServer((request) =>
      (request.method === 'turn/steer' && reply) || measuredReply(request), { compatibilityProbes: false, initializeResult: { codexHome: '/tmp/codex-home',
        platformFamily: 'unix', platformOs: 'test', userAgent: 'codex_cli_rs/0.153.4' } });
    const client = new AppServerClient({ url: server.url, timeoutMs: 3000 });
    try {
      await client.connect();
      const record = await measureCodexCompatibility(client, '0.153.4', { env });
      assert.equal(record.result, name === 'not-found' ? 'good' : 'failed', name);
    } finally { client.close(); await server.close(); }
  }
});
