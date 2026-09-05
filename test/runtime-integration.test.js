'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const { createStateFixture } = require('./helpers/state-fixture');
const { mockCodexClient } = require('./helpers/measured-codex');
const { loadParentContext, recordParentWake } = require('../scripts/lib/dispatch');
const { measureCodexCompatibility } = require('../scripts/lib/codex-compat');
const { withClient } = require('../scripts/lib/codex-runtime');
const { failureBody } = require('../scripts/lib/public-error');

async function initializedParent(fixture) {
  const file = path.resolve(__dirname, '../scripts/lane.js');
  const realRequire = createRequire(file);
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name !== './lib/wake') return realRequire(name);
    const wake = realRequire(name);
    return { ...wake, discoverCodexWake(options, env) {
      return wake.discoverCodexWake({ ...options, clientFactory: () => mockCodexClient((request) => {
        if (request.method === 'thread/read') return { result: { thread: { id: 'thread_parent001', cwd: fs.realpathSync(fixture.repoRoot) } } };
        return { result: { data: [{ type: 'commandExecution', command: 'parent-init' }] } };
      }) }, env);
    } };
  };
  localRequire.main = null;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: localRequire, module, exports: module.exports, __dirname: path.dirname(file), __filename: file,
    process, console, Buffer, URL, setTimeout, clearTimeout,
  }, { filename: file });
  const result = await module.exports.main(['parent-init', '--host-provider', 'codex', '--host-app', 'codex-cli',
    '--name', 'Parent', '--repo-root', fixture.repoRoot], fixture.env);
  return loadParentContext(result.contextFile, fixture.env);
}

test('parent-init persists its real discovery runtime and rejects malformed saved identities', async (t) => {
  const fixture = createStateFixture(t);
  fixture.env.CODEX_THREAD_ID = 'thread_parent001';
  fixture.env.TRANSMOGRIFY_URL = 'ws://127.0.0.1:19001';
  const context = await initializedParent(fixture);
  assert.equal(context.parent.wake.channel, 'codex-thread');
  assert.deepEqual(context.parent.wake.runtime, { url: 'ws://127.0.0.1:19001/', userAgent: 'codex_cli_rs/0.153.4' });
  for (const runtime of [null, {}, { ...context.parent.wake.runtime, url: 'wss://foreign.invalid/' },
    { ...context.parent.wake.runtime, userAgent: 'invalid' }]) {
    assert.throws(() => recordParentWake(context, { ...context.parent.wake, runtime }, fixture.env),
      (error) => error.code === 'INVALID_LOCAL_STATE');
  }
  assert.deepEqual(loadParentContext(context.file, fixture.env).parent.wake.runtime, context.parent.wake.runtime);
});

test('the public failure preserves the failing method from real compatibility measurement', async (t) => {
  const fixture = createStateFixture(t);
  const client = mockCodexClient(() => ({ error: { code: -32600, message: 'Invalid request: unknown variant `thread/list`' } }));
  const measured = await measureCodexCompatibility(client, '0.153.4', { env: fixture.env });
  let failure;
  try {
    await withClient({ url: 'ws://127.0.0.1:1', clientFactory: () => client },
      (connected) => connected.call('thread/start', {}), fixture.env);
  } catch (error) { failure = failureBody(error); }
  assert.equal(failure.code, 'RUNTIME_UNSUPPORTED');
  assert.equal(failure.details.failingMethod, measured.failingMethod);
  assert.match(failure.message, /compatibility check/);
});

test('no executable legacy endpoint default remains outside codex-runtime', () => {
  const scripts = path.resolve(__dirname, '../scripts');
  for (const directory of [scripts, path.join(scripts, 'lib')]) {
    for (const file of fs.readdirSync(directory)) {
      if (!/\.(js|sh)$/.test(file) || file === 'codex-runtime.js') continue;
      assert.doesNotMatch(fs.readFileSync(path.join(directory, file), 'utf8'), /(?:['"]8843['"]|:-8843)/, file);
    }
  }
});
