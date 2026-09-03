'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  EXIT, PUBLIC_ERROR_MESSAGES, SAFE_REFUSALS, exitCodeForError, failureBody, publicErrorMessage, safeDetails,
} = require('../scripts/lib/public-error');

// Execution-profile codes never reach a command line: both adapters wrap them
// as EXECUTION_PROFILE_UNSUPPORTED before they can escape.
const INTERNAL_ONLY = new Set(['scripts/lib/execution-profile.js']);
const CODE_PATTERNS = [
  /\bcode = '([A-Z][A-Z_]{3,})'/g,
  /\bfail\('([A-Z][A-Z_]{3,})'/g,
  /Error\('[^']*', '([A-Z][A-Z_]{3,})'/g,
  /\b[A-Za-z]+Error\('([A-Z][A-Z_]{3,})'/g,
  /\bcode: '([A-Z][A-Z_]{3,})'/g,
];

function thrownCodes() {
  const root = path.join(__dirname, '..', 'scripts');
  const files = [
    ...fs.readdirSync(root).filter((name) => name.endsWith('.js')).map((name) => path.join('scripts', name)),
    ...fs.readdirSync(path.join(root, 'lib')).filter((name) => name.endsWith('.js')).map((name) => path.join('scripts', 'lib', name)),
  ];
  const codes = new Map();
  for (const file of files) {
    if (INTERNAL_ONLY.has(file)) continue;
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const pattern of CODE_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        if (match[1].startsWith('ERR_')) continue;
        if (!codes.has(match[1])) codes.set(match[1], file);
      }
    }
  }
  return codes;
}

test('every code a command can throw has fixed public text', () => {
  const missing = [...thrownCodes()].filter(([code]) => !PUBLIC_ERROR_MESSAGES.has(code));
  assert.deepEqual(missing, []);
  for (const code of SAFE_REFUSALS) {
    assert.ok(PUBLIC_ERROR_MESSAGES.has(code), `safe refusal ${code} needs public text`);
  }
});

test('exit codes follow the shared table', () => {
  assert.deepEqual(EXIT, { ok: 0, internal: 1, refused: 2, failed: 3 });
  assert.equal(exitCodeForError('USAGE_ERROR'), 2);
  assert.equal(exitCodeForError('ERR_PARSE_ARGS_UNKNOWN_OPTION'), 2);
  assert.equal(exitCodeForError('NOT_OWNED'), 2);
  assert.equal(exitCodeForError('PENDING_OPERATION'), 2);
  assert.equal(exitCodeForError('SPAWN_UNCERTAIN'), 3);
  assert.equal(exitCodeForError('RPC_ERROR'), 3);
  assert.equal(exitCodeForError(undefined), 3);
});

test('failure envelopes carry fixed text and allowlisted, redacted details only', () => {
  const error = new Error('provider said: token=abc123 at /Users/private/repo');
  error.code = 'SPAWN_UNCERTAIN';
  error.details = {
    laneId: 'lane-1',
    causeMessage: 'Bearer sk-live-secret expired',
    transcript: 'private prompt text',
    nested: { operationId: 'op-1' },
  };
  const body = failureBody(error, { delivery: 'unknown' });
  assert.equal(body.ok, false);
  assert.equal(body.message, publicErrorMessage('SPAWN_UNCERTAIN'));
  assert.equal(body.delivery, 'unknown');
  assert.deepEqual(body.details, { laneId: 'lane-1', causeMessage: 'Bearer [redacted] expired' });
  assert.equal(JSON.stringify(body).includes('private'), false);
  assert.equal(failureBody(new Error('boom')).code, 'OPERATOR_ERROR');
  assert.equal(failureBody(new Error('boom')).details, undefined);
  assert.equal(publicErrorMessage('SOMETHING_NEW'), 'operator operation failed');
  const parse = new Error('bad flag');
  parse.code = 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
  assert.equal(failureBody(parse).code, 'USAGE_ERROR');
  assert.equal(failureBody(parse).message, 'bad flag');
  const usage = new Error('--timeout-ms must be between 100 and 600000');
  usage.code = 'USAGE_ERROR';
  assert.equal(failureBody(usage).message, '--timeout-ms must be between 100 and 600000');
  const blank = new Error('');
  blank.code = 'USAGE_ERROR';
  assert.equal(failureBody(blank).message, publicErrorMessage('USAGE_ERROR'));
  assert.equal(safeDetails(null), undefined);
});
