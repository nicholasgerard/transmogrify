'use strict';

const { measuredReply } = require('./measured-codex');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const adapter = require('../../scripts/lib/codex-adapter');
const { listLanes, registerLane } = require('../../scripts/lib/state');
const { verifySeat } = require('../../scripts/lib/worktree');
const { createRepoWithSeat } = require('./repo-fixture');

// New seats and policies come from spawn. Legacy seats use real worktree
// verification and registration. Only the provider is fake.
async function createCloneProviderFixture(t, externalSeat) {
  const fixture = createRepoWithSeat(t);
  let requestedCwd;
  if (externalSeat === 'clone') {
    requestedCwd = path.join(fs.realpathSync(fixture.worktreesRoot), 'external-clone');
    execFileSync('git', ['clone', '--no-hardlinks', fs.realpathSync(fixture.repoRoot), requestedCwd], { stdio: 'pipe' });
  } else if (['worktree', 'legacy-worktree'].includes(externalSeat)) {
    requestedCwd = fixture.seat;
  }
  const turnRequests = [];
  const turns = [];
  let cwd;
  let name;
  const options = {
    repoRoot: fixture.repoRoot, worktreesRoot: fixture.worktreesRoot,
    ...(requestedCwd ? { cwd: requestedCwd } : {}),
    url: 'ws://127.0.0.1:9999', allowProtocolOnly: true,
    name: '::: clone permission fixture', input: 'Implement the fixture packet.',
    clientFactory(config) {
      return {
        verifiedRuntime: true,
        userAgent: 'codex_cli_rs/0.151.0',
        runtimeIdentity: {
          endpoint: new URL(config.url).toString(), codexHome: '/tmp/fixture-codex',
          platformFamily: 'unix', platformOs: 'test',
        },
        async connect() { return { userAgent: 'codex_cli_rs/0.151.0' }; },
        close() {},
        async call(method, params) {
          // The compatibility gate probes the measured runtime before any mutation.
          const measured = measuredReply({ method, params });
          if (measured) {
            if (measured.error) { const error = new Error(measured.error.message); error.code = 'RPC_ERROR'; error.rpc = measured.error; throw error; }
            return measured.result;
          }
          if (method === 'model/list') return { data: [{
            id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture model',
            description: 'Fixture model', hidden: false, isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }],
            defaultReasoningEffort: 'low', serviceTiers: [], defaultServiceTier: null,
          }], nextCursor: null };
          if (method === 'thread/start') {
            cwd = params.cwd;
            return { cwd, thread: { id: 'fixture-thread', cwd }, model: params.model, serviceTier: 'default' };
          }
          if (method === 'turn/start') {
            turnRequests.push(structuredClone(params));
            const turn = {
              id: `fixture-turn-${turns.length + 1}`, status: 'inProgress',
              items: [{ type: 'userMessage', id: `fixture-item-${turns.length + 1}`,
                clientId: params.clientUserMessageId, content: params.input }],
            };
            turns.push(turn);
            return { turn: structuredClone(turn) };
          }
          if (method === 'thread/name/set') { name = params.name; return {}; }
          if (method === 'thread/read' || method === 'thread/resume') {
            return { cwd, thread: { id: 'fixture-thread', cwd, name, status: { type: 'idle' } } };
          }
          if (method === 'thread/turns/list') return { data: [...turns].reverse(), nextCursor: null };
          throw new Error(`unexpected fixture method ${method}`);
        },
      };
    },
  };
  let result;
  let lane;
  if (externalSeat === 'legacy-worktree') {
    const seat = verifySeat(fixture.repoRoot, requestedCwd, fixture.worktreesRoot);
    cwd = seat.path;
    name = options.name;
    lane = registerLane(fixture.repoRoot, {
      backend: 'codex-app-server', providerId: 'fixture-thread', displayName: name, state: 'idle',
      runtime: options.clientFactory(options).runtimeIdentity,
      seat: { ...seat, managed: true },
    }, fixture.env);
  } else {
    result = await adapter.spawn(options, fixture.env);
    [lane] = listLanes(fixture.repoRoot, fixture.env);
  }
  return {
    ...fixture, seat: lane.seat, lane, result, options, turnRequests,
    async finishTurn() {
      for (const turn of turns) turn.status = 'completed';
      return adapter.status({ ...options, laneId: lane.laneId }, fixture.env);
    },
  };
}

module.exports = { createCloneProviderFixture };
