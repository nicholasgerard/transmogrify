'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { startMockAppServer } = require('./helpers/mock-app-server');
const { runNodeScript } = require('./helpers/run-cli');
const { registerLane } = require('../scripts/lib/state');
const { verifySeat } = require('../scripts/lib/worktree');
const { createRepoWithSeat } = require('./helpers/repo-fixture');
const { createStateFixture, registerTestLane } = require('./helpers/state-fixture');

const stopped = { type: 'idle', activeFlags: [] };

function providerCwd(fixture) {
  return fs.realpathSync(fixture.seat);
}

test('listener help exposes all independent options', async () => {
  const result = await runNodeScript('scripts/lane-status-listen.js', ['--help']);
  assert.equal(result.code, 0, result.stderr);
  for (const flag of ['--url', '--repo-root', '--max-min', '--all']) {
    assert.match(result.stdout, new RegExp(flag));
  }
});

function registerListenerLane(t, url, providerId) {
  const fixture = createRepoWithSeat(t);
  registerLane(fixture.repoRoot, {
    backend: 'codex-app-server',
    providerId,
    displayName: `[test] ${providerId}`,
    state: 'active',
    runtime: {
      endpoint: new URL(url).toString(),
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'test',
    },
    seat: verifySeat(fixture.repoRoot, fixture.seat, fixture.worktreesRoot),
  }, fixture.env);
  return fixture;
}

test('named listener refuses an ambiguous thread-id prefix', async (t) => {
  const fixture = createStateFixture(t);
  for (const providerId of ['abc-111', 'abc-222']) {
    registerLane(fixture.repoRoot, {
      backend: 'codex-app-server',
      providerId,
      displayName: `[test] ${providerId}`,
      state: 'active',
    }, fixture.env);
  }
  const server = await startMockAppServer((request) => {
    assert.equal(request.method, 'thread/list');
    return {
      result: {
        data: [
          { id: 'abc-111', status: stopped },
          { id: 'abc-222', status: stopped },
        ],
        nextCursor: null,
      },
    };
  });
  t.after(() => server.close());

  const result = await runNodeScript('scripts/lane-status-listen.js', [
    '--url', server.url, 'lane=abc',
  ], { env: { REPO_ROOT: fixture.repoRoot, TRANSMOGRIFY_STATE_DIR: fixture.stateDir } });
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stderr, /ambiguous/i);
});

test('named listener refuses a missing thread-id prefix', async (t) => {
  const fixture = registerTestLane(t, { providerId: 'different-thread' });
  const server = await startMockAppServer(() => ({
    result: { data: [], nextCursor: null },
  }));
  t.after(() => server.close());

  const result = await runNodeScript('scripts/lane-status-listen.js', [
    '--url', server.url, 'lane=missing',
  ], { env: { REPO_ROOT: fixture.repoRoot, TRANSMOGRIFY_STATE_DIR: fixture.stateDir } });
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stderr, /did not match/i);
});

test('named listener accepts one exact match', async (t) => {
  let fixture;
  const server = await startMockAppServer(() => ({ result: {
    data: [{ id: 'abc-111', cwd: providerCwd(fixture), status: stopped }],
    nextCursor: null,
  } }));
  t.after(() => server.close());
  fixture = registerListenerLane(t, server.url, 'abc-111');

  const result = await runNodeScript('scripts/lane-status-listen.js', [
    '--url', server.url, 'lane=abc-111',
  ], { env: { REPO_ROOT: fixture.repoRoot, TRANSMOGRIFY_STATE_DIR: fixture.stateDir } });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /LANE IDLE: lane/);
  assert.doesNotMatch(result.stdout, /abc-111/);
});

test('listener rejects max durations that overflow Node timers', async () => {
  const result = await runNodeScript('scripts/lane-status-listen.js', [
    '--max-min', '35792', '--all',
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /maximum/i);
});

test('listener rejects control characters in watch names before registry access', async () => {
  const result = await runNodeScript('scripts/lane-status-listen.js', [
    'unsafe\nname=abc-111',
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /watch name must be non-empty bounded single-line text/);
  assert.doesNotMatch(result.stderr, /unsafe\nname/);
});

test('--all resumes only registry-owned active lanes', async (t) => {
  let fixture;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/list') {
      return {
        result: {
          data: [
            { id: 'owned-thread', cwd: providerCwd(fixture), status: { type: 'active', activeFlags: [] } },
            { id: 'foreign-thread', status: { type: 'active', activeFlags: [] } },
          ],
          nextCursor: null,
        },
      };
    }
    assert.equal(request.method, 'thread/resume');
    assert.equal(request.params.threadId, 'owned-thread');
    assert.equal(request.params.cwd, providerCwd(fixture));
    return { result: {
      cwd: providerCwd(fixture),
      thread: { id: 'owned-thread', cwd: providerCwd(fixture), status: stopped },
    } };
  });
  t.after(() => server.close());
  fixture = registerListenerLane(t, server.url, 'owned-thread');

  const result = await runNodeScript('scripts/lane-status-listen.js', [
    '--url', server.url, '--all',
  ], { env: { REPO_ROOT: fixture.repoRoot, TRANSMOGRIFY_STATE_DIR: fixture.stateDir } });
  assert.equal(result.code, 0, result.stderr);
  const resumed = server.requests.filter((request) => request.method === 'thread/resume');
  assert.deepEqual(resumed.map((request) => request.params.threadId), ['owned-thread']);
});

test('--all ignores registry-owned lanes that are not provider-active in the opening snapshot', async (t) => {
  let fixture;
  const server = await startMockAppServer((request) => {
    assert.equal(request.method, 'thread/list');
    return {
      result: {
        data: [{ id: 'owned-thread', cwd: providerCwd(fixture), status: stopped }],
        nextCursor: null,
      },
    };
  });
  t.after(() => server.close());
  fixture = registerListenerLane(t, server.url, 'owned-thread');

  const result = await runNodeScript('scripts/lane-status-listen.js', [
    '--url', server.url, '--all',
  ], { env: { REPO_ROOT: fixture.repoRoot, TRANSMOGRIFY_STATE_DIR: fixture.stateDir } });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /no registry-owned provider-active Codex lanes/i);
  assert.doesNotMatch(result.stdout, /owned-thread/);
  assert.deepEqual(
    server.requests.filter((request) => request.id !== undefined).map((request) => request.method),
    ['initialize', 'thread/list'],
  );
});

test('listener rejects unverified owned status strings without echoing them or provider ids', async (t) => {
  let fixture;
  const server = await startMockAppServer(() => ({
    result: {
      data: [{
        id: 'owned-thread',
        cwd: providerCwd(fixture),
        status: { type: 'active', activeFlags: ['private-provider-value'] },
      }],
      nextCursor: null,
    },
  }));
  t.after(() => server.close());
  fixture = registerListenerLane(t, server.url, 'owned-thread');

  const result = await runNodeScript('scripts/lane-status-listen.js', [
    '--url', server.url, '--all',
  ], { env: { REPO_ROOT: fixture.repoRoot, TRANSMOGRIFY_STATE_DIR: fixture.stateDir } });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /listener failed/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /private-provider-value|owned-thread/);
});

test('listener refuses a thread/resume cwd mismatch before accepting the subscription', async (t) => {
  let fixture;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/list') return { result: {
      data: [{
        id: 'owned-thread',
        cwd: providerCwd(fixture),
        status: { type: 'active', activeFlags: [] },
      }],
      nextCursor: null,
    } };
    assert.equal(request.method, 'thread/resume');
    assert.equal(request.params.cwd, providerCwd(fixture));
    return { result: {
      cwd: providerCwd(fixture),
      thread: {
        id: 'owned-thread',
        cwd: `${providerCwd(fixture)}-wrong`,
        status: { type: 'active', activeFlags: [] },
      },
    } };
  });
  t.after(() => server.close());
  fixture = registerListenerLane(t, server.url, 'owned-thread');

  const result = await runNodeScript('scripts/lane-status-listen.js', [
    '--url', server.url, '--all',
  ], { env: { REPO_ROOT: fixture.repoRoot, TRANSMOGRIFY_STATE_DIR: fixture.stateDir } });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /listener failed/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /owned-thread|wrong/);
});

test('listener refuses duplicate exact thread rows before subscription', async (t) => {
  let fixture;
  const server = await startMockAppServer((request) => {
    assert.equal(request.method, 'thread/list');
    return { result: {
      data: [
        {
          id: 'owned-thread',
          cwd: `${providerCwd(fixture)}-wrong`,
          status: { type: 'active', activeFlags: [] },
        },
        {
          id: 'owned-thread',
          cwd: providerCwd(fixture),
          status: { type: 'active', activeFlags: [] },
        },
      ],
      nextCursor: null,
    } };
  });
  t.after(() => server.close());
  fixture = registerListenerLane(t, server.url, 'owned-thread');

  const result = await runNodeScript('scripts/lane-status-listen.js', [
    '--url', server.url, '--all',
  ], { env: { REPO_ROOT: fixture.repoRoot, TRANSMOGRIFY_STATE_DIR: fixture.stateDir } });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /listener failed/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /owned-thread|wrong/);
  assert.equal(server.requests.some((request) => request.method === 'thread/resume'), false);
});

test('listener refuses a thread/read cwd mismatch during metadata polling', async (t) => {
  let fixture;
  const server = await startMockAppServer((request) => {
    if (request.method === 'thread/list') return { result: {
      data: [{
        id: 'owned-thread',
        cwd: providerCwd(fixture),
        status: { type: 'active', activeFlags: [] },
      }],
      nextCursor: null,
    } };
    if (request.method === 'thread/resume') return { result: {
      cwd: providerCwd(fixture),
      thread: {
        id: 'owned-thread',
        cwd: providerCwd(fixture),
        status: { type: 'active', activeFlags: [] },
      },
    } };
    assert.equal(request.method, 'thread/read');
    return { result: { thread: {
      id: 'owned-thread',
      cwd: `${providerCwd(fixture)}-wrong`,
      status: { type: 'active', activeFlags: [] },
    } } };
  });
  t.after(() => server.close());
  fixture = registerListenerLane(t, server.url, 'owned-thread');

  const result = await runNodeScript('scripts/lane-status-listen.js', [
    '--url', server.url, '--all',
  ], {
    env: { REPO_ROOT: fixture.repoRoot, TRANSMOGRIFY_STATE_DIR: fixture.stateDir },
    timeoutMs: 7000,
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /polling status/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /owned-thread|wrong/);
  assert.equal(server.requests.filter((request) => request.method === 'thread/read').length, 1);
});
