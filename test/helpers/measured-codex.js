'use strict';

const { NIL_ID } = require('../../scripts/lib/codex-compat');

// Provider-boundary replies measured on the two supported builds. Keep these
// literal messages independent of the production matchers under test.
function measuredReply(request) {
  if (request.method === 'thread/list' && request.params?.useStateDbOnly === true && request.params.limit === 1) {
    return { result: { data: [], nextCursor: null } };
  }
  if (request.params?.threadId !== NIL_ID) return null;
  if (request.method === 'turn/steer') {
    return { error: { code: -32600, message: `thread not found: ${NIL_ID}` } };
  }
  if (['thread/name/set', 'thread/archive'].includes(request.method)) {
    return { error: { code: -32600, message: `no rollout found for thread id ${NIL_ID}` } };
  }
  return null;
}

function mockCodexClient(handler = () => null, options = {}) {
  const calls = [];
  return {
    calls, verifiedRuntime: true, userAgent: options.userAgent || 'codex_cli_rs/0.153.4',
    async connect() { return { userAgent: this.userAgent }; },
    close() {},
    async call(method, params) {
      const request = { method, params };
      calls.push(request);
      const reply = await handler(request) || measuredReply(request);
      if (!reply) throw new Error(`Unexpected mock request: ${method}`);
      if (reply.error) throw Object.assign(new Error('mock RPC rejection'), { code: 'RPC_ERROR', rpc: reply.error });
      return reply.result;
    },
  };
}

module.exports = { measuredReply, mockCodexClient };
