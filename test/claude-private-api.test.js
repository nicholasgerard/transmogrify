'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CCR_HEADERS,
  DESKTOP_APP_ASAR,
  DESKTOP_APP_ASAR_SHA256,
  DESKTOP_BUILD,
  DESKTOP_BUNDLE_ID,
  DESKTOP_BUNDLE_VERSION,
  createClaudePrivateApi,
  parseCredential,
} = require('../scripts/lib/claude-private-api');
const {
  PINNED_CLI_SHA256,
  PINNED_CLI_VERSION,
} = require('../scripts/lib/claude-surface');

const BRIDGE_ID = 'session_testBridge';
const TOKEN = 'oauth-secret-value-that-must-not-be-logged';
const RUNTIME = {
  platform: 'darwin',
  arch: 'arm64',
  cliVersion: PINNED_CLI_VERSION,
  cliSha256: PINNED_CLI_SHA256,
  orgId: 'org-test',
};

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

function streamedResponse(status, chunks, onCancel = () => {}) {
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() { onCancel(); },
        };
      },
    },
  };
}

function privateApi(fetch, calls = []) {
  return createClaudePrivateApi({
    username: 'test-user',
    fetch,
    lstatSync(file) {
      assert.equal(file, DESKTOP_APP_ASAR);
      return {
        isSymbolicLink: () => false,
        isFile: () => true,
        mode: 0o100644,
      };
    },
    sha256File(file) {
      assert.equal(file, DESKTOP_APP_ASAR);
      return DESKTOP_APP_ASAR_SHA256;
    },
    execFileSync(executable, args) {
      calls.push({ executable, args });
      if (executable === '/usr/bin/plutil') {
        assert.equal(args[0], '-extract');
        assert.deepEqual(args.slice(2), [
          'raw', '-o', '-', '/Applications/Claude.app/Contents/Info.plist',
        ]);
        if (args[1] === 'CFBundleShortVersionString') return `${DESKTOP_BUILD}\n`;
        if (args[1] === 'CFBundleVersion') return `${DESKTOP_BUNDLE_VERSION}\n`;
        if (args[1] === 'CFBundleIdentifier') return `${DESKTOP_BUNDLE_ID}\n`;
        throw new Error('unexpected plist key');
      }
      if (executable === '/usr/bin/security') {
        assert.deepEqual(args, [
          'find-generic-password', '-s', 'Claude Code-credentials', '-a', 'test-user', '-w',
        ]);
        return JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } });
      }
      throw new Error('unexpected command');
    },
  });
}

test('private Claude archive returns only after exact remote archived read-back', async () => {
  const requests = [];
  const statuses = ['active', 'archived'];
  const api = privateApi(async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'GET') {
      return response(200, { response_shape: { id: 'cse_testBridge', status: statuses.shift() } });
    }
    return response(409, {});
  });
  const result = await api.ensureArchived({
    bridgeId: BRIDGE_ID,
    runtime: RUNTIME,
    delayMs: 0,
  });
  assert.equal(result.archived, true);
  assert.equal(result.alreadyArchived, false);
  assert.deepEqual(requests.map((entry) => entry.options.method), ['GET', 'POST', 'GET']);
  assert.equal(requests[0].url.endsWith('/v1/code/sessions/cse_testBridge'), true);
  assert.equal(requests[1].url.endsWith('/v1/code/sessions/cse_testBridge/archive'), true);
  for (const request of requests) {
    assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(request.options.headers['x-organization-uuid'], 'org-test');
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.credentials, 'omit');
  }
  assert.deepEqual(requests[0].options.headers, {
    ...CCR_HEADERS,
    'Content-Type': 'application/json',
    'x-organization-uuid': 'org-test',
    'x-environment-runner-version': DESKTOP_BUILD,
    Authorization: `Bearer ${TOKEN}`,
  });
  assert.deepEqual(requests[1].options.headers, {
    ...CCR_HEADERS,
    'Content-Type': 'application/json',
    'x-organization-uuid': 'org-test',
    'x-environment-runner-version': DESKTOP_BUILD,
    Authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(requests[1].options.body, '{}');
  assert.equal(Object.hasOwn(requests[0].options, 'body'), false);
});

test('private Claude archive is idempotent when exact remote status is already archived', async () => {
  let requests = 0;
  const api = privateApi(async () => {
    requests += 1;
    return response(200, { response_shape: { id: 'cse_testBridge', status: 'archived' } });
  });
  const result = await api.ensureArchived({ bridgeId: BRIDGE_ID, runtime: RUNTIME });
  assert.equal(result.alreadyArchived, true);
  assert.equal(requests, 1);
});

test('private Claude archive accepts the alternate exact Desktop session envelope', async () => {
  const api = privateApi(async () => response(200, {
    session: { id: 'session_testBridge', status: 'archived' },
  }));
  const result = await api.ensureArchived({ bridgeId: BRIDGE_ID, runtime: RUNTIME });
  assert.equal(result.alreadyArchived, true);
});

test('private Claude archive fails closed before Keychain or mutation on version mismatch', async () => {
  const calls = [];
  const api = privateApi(async () => {
    throw new Error('fetch must not run');
  }, calls);
  await assert.rejects(() => api.ensureArchived({
    bridgeId: BRIDGE_ID,
    runtime: { ...RUNTIME, cliVersion: '2.1.259' },
  }), /not verified/);
  assert.equal(calls.some((call) => call.executable === '/usr/bin/security'), false);
});

test('private Claude archive never treats missing remote state as archival proof', async () => {
  const api = privateApi(async () => response(404, {}));
  await assert.rejects(() => api.ensureArchived({
    bridgeId: BRIDGE_ID,
    runtime: RUNTIME,
  }), /HTTP 404/);
  assert.throws(() => parseCredential('{}'), /no OAuth access token/);
});

test('private Claude archive rejects a status without the measured record shape', async () => {
  const api = privateApi(async () => response(200, {
    response_shape: { status: 'archived' },
  }));
  await assert.rejects(() => api.ensureArchived({
    bridgeId: BRIDGE_ID,
    runtime: RUNTIME,
  }), /record id/);
});

test('private Claude archive stops reading a response above its hard byte bound', async () => {
  let cancelled = false;
  const api = privateApi(async () => streamedResponse(200, [
    Buffer.alloc(64 * 1024, 0x20),
    Buffer.from('x'),
  ], () => { cancelled = true; }));
  await assert.rejects(() => api.ensureArchived({
    bridgeId: BRIDGE_ID,
    runtime: RUNTIME,
  }), (error) => error.code === 'REMOTE_ARCHIVE_UNCERTAIN' && /response bound/.test(error.message));
  assert.equal(cancelled, true);
});

test('private Claude archive rejects another canonical session id and unknown status', async () => {
  let api = privateApi(async () => response(200, {
    response_shape: { id: 'cse_another', status: 'archived' },
  }));
  await assert.rejects(() => api.ensureArchived({
    bridgeId: BRIDGE_ID,
    runtime: RUNTIME,
  }), /another session/);

  api = privateApi(async () => response(200, {
    response_shape: { id: 'cse_testBridge', status: 'trusted_device_required' },
  }));
  await assert.rejects(() => api.ensureArchived({
    bridgeId: BRIDGE_ID,
    runtime: RUNTIME,
  }), /status is unrecognized/);
});

test('private Claude archive fails closed on OAuth and trusted-device denials', async () => {
  let api = privateApi(async () => response(401, {}));
  await assert.rejects(() => api.ensureArchived({
    bridgeId: BRIDGE_ID,
    runtime: RUNTIME,
  }), (error) => error.code === 'PRIVATE_AUTH_REJECTED');

  api = privateApi(async () => response(403, {
    error: { resource: 'untrusted_device' },
  }));
  await assert.rejects(() => api.ensureArchived({
    bridgeId: BRIDGE_ID,
    runtime: RUNTIME,
  }), (error) => error.code === 'PRIVATE_TRUST_REQUIRED' && /automatic enrollment is disabled/.test(error.message));

  api = privateApi(async () => response(403, {
    error: { details: { error_code: 'session_stale_relogin' } },
  }));
  await assert.rejects(() => api.ensureArchived({
    bridgeId: BRIDGE_ID,
    runtime: RUNTIME,
  }), (error) => error.code === 'PRIVATE_AUTH_REJECTED' && /sign-in again/.test(error.message));
});

test('post-dispatch archive auth failures remain mutation-unknown', async () => {
  for (const denial of [
    response(401, {}),
    response(403, { error: { resource: 'untrusted_device' } }),
  ]) {
    let request = 0;
    const api = privateApi(async (_url, options) => {
      request += 1;
      if (request === 1) {
        assert.equal(options.method, 'GET');
        return response(200, {
          response_shape: { id: 'cse_testBridge', status: 'active' },
        });
      }
      if (request === 2) {
        assert.equal(options.method, 'POST');
        return response(200, {});
      }
      assert.equal(options.method, 'GET');
      return denial;
    });
    await assert.rejects(
      () => api.ensureArchived({
        bridgeId: BRIDGE_ID,
        runtime: RUNTIME,
        attempts: 1,
        delayMs: 0,
      }),
      (error) => error.code === 'REMOTE_ARCHIVE_UNCERTAIN' &&
        error.details.archiveDispatched === true,
    );
  }
});

test('private Claude archive pins app.asar before Keychain access', async () => {
  const calls = [];
  const api = createClaudePrivateApi({
    username: 'test-user',
    fetch: async () => { throw new Error('fetch must not run'); },
    lstatSync: () => ({
      isSymbolicLink: () => false,
      isFile: () => true,
      mode: 0o100644,
    }),
    sha256File: () => '0'.repeat(64),
    execFileSync(executable, args) {
      calls.push({ executable, args });
      if (args[1] === 'CFBundleShortVersionString') return DESKTOP_BUILD;
      if (args[1] === 'CFBundleVersion') return DESKTOP_BUNDLE_VERSION;
      if (args[1] === 'CFBundleIdentifier') return DESKTOP_BUNDLE_ID;
      throw new Error('Keychain must not run');
    },
  });
  await assert.rejects(() => api.ensureArchived({
    bridgeId: BRIDGE_ID,
    runtime: RUNTIME,
  }), /app.asar is not the pinned bundle/);
  assert.equal(calls.some((call) => call.executable === '/usr/bin/security'), false);
});
