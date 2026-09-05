'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { spawn } = require('../scripts/lib/codex-adapter');
const { createParentContext } = require('../scripts/lib/dispatch');
const { exchangePreamble } = require('../scripts/lib/exchange');
const { listLanes } = require('../scripts/lib/state');
const { verifyRecordedSeat } = require('../scripts/lib/worktree');
const { createRepoWithSeat } = require('./helpers/repo-fixture');
const { measuredReply } = require('./helpers/measured-codex');

test('Codex clone spawn keeps provenance, attributed preamble, and packet order at the provider boundary', async (t) => {
  const fixture = createRepoWithSeat(t);
  const parentContext = createParentContext({
    hostProvider: 'claude', hostApp: 'claude-desktop', displayName: 'Clone operator',
  }, fixture.env);
  const catalog = { data: [{
    id: 'sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'Test model',
    hidden: false, isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }],
    defaultReasoningEffort: 'low', serviceTiers: [], defaultServiceTier: null,
  }], nextCursor: null };
  let cwd;
  let name;
  let input;
  const calls = [];
  const result = await spawn({
    repoRoot: fixture.repoRoot, worktreesRoot: fixture.worktreesRoot,
    url: 'ws://127.0.0.1:9999', allowProtocolOnly: true,
    name: '::: clone boundary', input: 'Implement the clone packet.', parentContext,
    clientFactory(config) {
      return {
        verifiedRuntime: true,
        runtimeVersion: '0.151.0',
        userAgent: 'codex_cli_rs/0.151.0',
        runtimeIdentity: { endpoint: new URL(config.url).toString(), codexHome: '/tmp/fixture-codex', platformFamily: 'unix', platformOs: 'test' },
        async connect() { return { userAgent: 'codex_cli_rs/0.151.0' }; },
        close() {},
        async call(method, params) {
          // The compatibility gate probes the measured runtime before any mutation.
          const measured = measuredReply({ method, params });
          if (measured) {
            if (measured.error) { const error = new Error(measured.error.message); error.code = 'RPC_ERROR'; error.rpc = measured.error; throw error; }
            return measured.result;
          }
          calls.push(method);
          if (method === 'model/list') return catalog;
          if (method === 'thread/start') {
            cwd = params.cwd;
            assert.equal(fs.lstatSync(`${cwd}/.git`).isDirectory(), true);
            assert.equal(params.sandbox, 'workspace-write');
            assert.equal(params.approvalPolicy, 'never');
            return { cwd, thread: { id: 'clone-thread', cwd }, model: params.model, serviceTier: 'default' };
          }
          if (method === 'turn/start') {
            input = params.input[0].text;
            return { turn: {
              id: 'clone-turn', status: 'inProgress',
              items: [{ type: 'userMessage', id: 'input-item', clientId: params.clientUserMessageId,
                content: params.input }],
            } };
          }
          if (method === 'thread/name/set') { name = params.name; return {}; }
          if (method === 'thread/read') return { thread: { id: 'clone-thread', cwd, name, status: { type: 'idle' } } };
          throw new Error(`unexpected fixture method ${method}`);
        },
      };
    },
  }, fixture.env);
  assert.equal(result.ok, true);
  const [lane] = listLanes(fixture.repoRoot, fixture.env);
  assert.equal(lane.seat.kind, 'clone');
  assert.equal(verifyRecordedSeat(fixture.repoRoot, lane.seat).path, cwd);
  assert.match(input, /^╭─ Transmogrify/);
  assert.ok(input.includes(`\n\n${exchangePreamble(cwd, 'codex')}\n\nImplement the clone packet.`));
  assert.match(input, /Co-Authored-By: Codex <noreply@openai\.com>/);
  assert.equal(fs.readFileSync(result.exchange.packet, 'utf8'), 'Implement the clone packet.');
  assert.equal(calls.filter((method) => method === 'turn/start').length, 1);
});
