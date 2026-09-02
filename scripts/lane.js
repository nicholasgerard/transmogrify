#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, TextDecoder } = require('node:util');
const codex = require('./lib/codex-adapter');
const claude = require('./lib/claude-adapter');
const { requireOwnedLane } = require('./lib/state');

const MAX_INPUT_BYTES = 64 * 1024;
const HELP = `usage: lane.js <operation> --repo-root <absolute-path> [options]

operations:
  spawn      --target codex|claude --name <name> (--input <text> | --input-file <absolute|->)
             [--cwd <absolute>] [--worktrees <absolute> (or WORKTREES)]
             [--model <claude-model>]
  steer      --lane <lane-id> (--input <text> | --input-file <absolute|->)
  status     --lane <lane-id>
  interrupt  --lane <lane-id>                         Codex only
  stop       --lane <lane-id>                         Claude only
  recover    --lane <lane-id> [--input <text> | --input-file <absolute|->]
             Codex input starts one boundary turn; Claude recovery accepts no input
  retire     --lane <lane-id> --harvested-output-sha256 <sha256>
             [--private-archive] [--no-cleanup-worktree]
  reconcile  --target codex|claude [--lane <lane-id>]
             [--finish-retirements] [--private-archive] [--no-cleanup-worktree]

provider options:
  --url <loopback-ws-url>       Codex only (or TRANSMOGRIFY_URL)
  --claude-bin <absolute-path>  Claude only (or CLAUDE_BIN)

--private-archive and --finish-retirements are Claude-only. --repo-root may be
supplied through REPO_ROOT. Run the installed SKILL.md workflow before using
mutating operations.`;
const OPERATIONS = new Set([
  'spawn',
  'steer',
  'status',
  'interrupt',
  'stop',
  'recover',
  'retire',
  'reconcile',
]);
const OPERATION_OPTIONS = {
  spawn: new Set([
    'repo-root', 'target', 'name', 'input', 'input-file', 'cwd', 'worktrees',
    'url', 'claude-bin', 'model',
  ]),
  steer: new Set(['repo-root', 'lane', 'input', 'input-file', 'url', 'claude-bin']),
  status: new Set(['repo-root', 'lane', 'url', 'claude-bin']),
  interrupt: new Set(['repo-root', 'lane', 'url']),
  stop: new Set(['repo-root', 'lane', 'claude-bin']),
  recover: new Set(['repo-root', 'lane', 'input', 'input-file', 'url', 'claude-bin']),
  retire: new Set([
    'repo-root', 'lane', 'url', 'claude-bin', 'private-archive',
    'no-cleanup-worktree', 'harvested-output-sha256',
  ]),
  reconcile: new Set([
    'repo-root', 'target', 'lane', 'url', 'claude-bin', 'private-archive',
    'finish-retirements', 'no-cleanup-worktree',
  ]),
};
const SAFE_DETAIL_KEYS = new Set([
  'alreadyStopped',
  'attempted',
  'archive',
  'cleanup',
  'code',
  'delivery',
  'exactSession',
  'executionEpoch',
  'httpStatus',
  'laneId',
  'localRemoval',
  'operationId',
  'outcome',
  'phase',
  'presentation',
  'providerMutation',
  'providerRetired',
  'queued',
  'removed',
  'state',
  'stop',
]);
const SAFE_REFUSALS = new Set([
  'ADAPTER_MISMATCH',
  'CLEANUP_BLOCKED',
  'CLEANUP_RETRYABLE',
  'EXECUTION_EPOCH_UNBOUND',
  'HARVEST_MISMATCH',
  'HARVEST_REQUIRED',
  'INVALID_STATE',
  'LANE_RETIRED',
  'NOT_DELIVERED',
  'NO_ACTIVE_TURN',
  'NOT_OWNED',
  'OPERATION_PENDING',
  'OWNERSHIP_MISMATCH',
  'PENDING_OPERATION',
  'PRIVATE_API_DISABLED',
  'PRIVATE_AUTH_REJECTED',
  'PRIVATE_AUTH_UNAVAILABLE',
  'PRIVATE_TRUST_REQUIRED',
  'RUNTIME_MISMATCH',
  'SEAT_MISMATCH',
  'TARGET_ACTIVE',
  'UNSUPPORTED_ENVIRONMENT',
  'UNVERIFIED_PRIVATE_VERSION',
  'UNVERIFIED_RUNTIME',
  'USAGE_ERROR',
]);
const PUBLIC_ERROR_MESSAGES = new Map([
  ['ADAPTER_MISMATCH', 'lane backend does not support this operation'],
  ['CLEANUP_BLOCKED', 'provider retirement is verified; local cleanup remains blocked'],
  ['CLEANUP_RETRYABLE', 'provider retirement is verified; local cleanup failed safely and may be retried'],
  ['COMPLETION_UNKNOWN', 'lane launch is verified; completion observation is unknown'],
  ['DELIVERY_UNCERTAIN', 'provider delivery outcome is unknown'],
  ['EXECUTION_EPOCH_UNBOUND', 'live provider execution no longer matches the owned receipt'],
  ['FORKED_COPY', 'recovery may have created a separate provider session; no copy was touched'],
  ['HARVEST_MISMATCH', 'the supplied harvest receipt does not match the durable retirement receipt'],
  ['HARVEST_REQUIRED', 'retirement requires a durable harvested-output receipt'],
  ['HOST_CALLBACK_FAILED', 'lane launch is verified; the host launch callback failed'],
  ['INVALID_STATE', 'the owned lane is not in a valid state for this operation'],
  ['LANE_RETIRED', 'the owned lane is already retiring or retired'],
  ['LOCAL_REMOVAL_UNCERTAIN', 'local provider removal outcome is unknown'],
  ['NOT_DELIVERED', 'the provider mutation was not delivered'],
  ['NOT_OWNED', 'the requested lane is not owned by this operator installation'],
  ['NO_ACTIVE_TURN', 'the owned Codex lane has no active turn'],
  ['OWNERSHIP_MISMATCH', 'live provider identity does not match the owned receipt'],
  ['OPERATION_PENDING', 'the owned lane has an unresolved operation'],
  ['PENDING_OPERATION', 'the owned lane has an unresolved operation'],
  ['PRIVATE_API_DISABLED', 'Claude retirement requires explicit private archive authorization'],
  ['PRIVATE_AUTH_REJECTED', 'Claude rejected the private archive credential'],
  ['PRIVATE_AUTH_UNAVAILABLE', 'Claude private archive authentication is unavailable'],
  ['PRIVATE_TRUST_REQUIRED', 'Claude private archival requires manual trusted-device enrollment'],
  ['PROTOCOL_ERROR', 'the provider returned an unverified protocol shape'],
  ['RECOVERY_UNCERTAIN', 'provider recovery outcome is unknown'],
  ['REMOTE_ARCHIVE_UNCERTAIN', 'remote provider archive outcome is unknown'],
  ['RUNTIME_MISMATCH', 'the provider runtime no longer matches the owned receipt'],
  ['SEAT_MISMATCH', 'the lane worktree no longer matches the owned receipt'],
  ['SPAWN_UNCERTAIN', 'provider spawn outcome is unknown'],
  ['STOP_UNCERTAIN', 'provider stop outcome is unknown'],
  ['TARGET_ACTIVE', 'the provider lane is still active'],
  ['TRANSPORT_UNKNOWN', 'provider transport outcome is unknown'],
  ['UNSUPPORTED_ENVIRONMENT', 'the local provider environment is unsupported'],
  ['UNVERIFIED_PRIVATE_VERSION', 'the installed Claude private surface is not pinned'],
  ['USAGE_ERROR', 'invalid operator request'],
]);

function usage(message) {
  const error = new Error(message);
  error.code = 'USAGE_ERROR';
  throw error;
}

function decodeInput(buffer, label) {
  let value;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch {
    usage(`${label} must be valid UTF-8`);
  }
  if (value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) {
    usage(`${label} must not contain NUL or unpaired surrogates`);
  }
  return value;
}

function readBounded(descriptor, label) {
  const chunks = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(16 * 1024, MAX_INPUT_BYTES + 1 - total));
    const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_INPUT_BYTES) usage(`${label} exceeds ${MAX_INPUT_BYTES} bytes`);
    chunks.push(chunk.subarray(0, count));
  }
  return decodeInput(Buffer.concat(chunks), label);
}

function readInput(values) {
  if (values.input !== undefined && values['input-file'] !== undefined) {
    usage('use either --input or --input-file, not both');
  }
  if (values.input !== undefined) {
    if (Buffer.byteLength(values.input, 'utf8') > MAX_INPUT_BYTES) {
      usage(`inline input exceeds ${MAX_INPUT_BYTES} bytes`);
    }
    if (values.input.includes('\0') || /[\uD800-\uDFFF]/u.test(values.input)) {
      usage('inline input must not contain NUL or unpaired surrogates');
    }
    return values.input;
  }
  if (values['input-file'] === undefined) return undefined;
  if (values['input-file'] === '-') return readBounded(0, 'stdin input');
  if (!path.isAbsolute(values['input-file'])) usage('--input-file must be absolute or -');
  let descriptor;
  try {
    descriptor = fs.openSync(
      values['input-file'],
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        (stat.mode & 0o022) !== 0) {
      usage('--input-file must be a safe bounded regular file');
    }
    return readBounded(descriptor, 'input file');
  } catch (error) {
    if (error.code === 'USAGE_ERROR') throw error;
    usage('--input-file must be a safe bounded regular file');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function adapterForLane(repoRoot, laneId, env) {
  let lane;
  try { lane = requireOwnedLane(repoRoot, laneId, env); } catch (error) {
    if (/^NOT_OWNED:/.test(error.message)) error.code = 'NOT_OWNED';
    throw error;
  }
  if (lane.backend === 'codex-app-server') return codex;
  if (lane.backend === claude.BACKEND) return claude;
  const error = new Error(`unsupported lane backend ${lane.backend}`);
  error.code = 'ADAPTER_MISMATCH';
  throw error;
}

function safeString(value) {
  return value
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\b(?:session|cse)_[0-9A-Za-z_-]+\b/g, '[redacted-provider-id]')
    .replace(/([?&](?:token|secret|authorization|cookie|credential|api[-_]?key|password)=)[^&\s]+/gi,
      '$1[redacted]')
    .replace(/\b(token|secret|authorization|cookie|credential|api[-_ ]?key|password)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]');
}

function publicErrorMessage(code) {
  if (PUBLIC_ERROR_MESSAGES.has(code)) return PUBLIC_ERROR_MESSAGES.get(code);
  if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_')) {
    return 'invalid command-line arguments';
  }
  return 'operator operation failed';
}

function safeDetails(details) {
  if (details === null || details === undefined) return undefined;
  if (Array.isArray(details)) return details.map(safeDetails);
  if (typeof details === 'string') return safeString(details);
  if (typeof details !== 'object') return details;
  return Object.fromEntries(Object.entries(details)
    .filter(([key]) => SAFE_DETAIL_KEYS.has(key))
    .map(([key, value]) => [key, safeDetails(value)]));
}

const PRIVATE_RESULT_KEYS = new Set([
  'agent',
  'bridgeId',
  'completedTurnId',
  'codexHome',
  'cwd',
  'endpoint',
  'error',
  'expectedTurnId',
  'file',
  'id',
  'jobId',
  'log',
  'message',
  'name',
  'observedTurnId',
  'path',
  'pid',
  'pids',
  'providerId',
  'providerIdentity',
  'recoveredTurnId',
  'runtime',
  'sessionId',
  'socket',
  'stderr',
  'stdout',
  'transcript',
  'turnId',
  'url',
  'userAgent',
]);

function publicSuccess(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(publicSuccess);
  if (typeof value === 'string') return safeString(value);
  if (typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_RESULT_KEYS.has(key))
    .map(([key, nested]) => [key, publicSuccess(nested)]));
}

function validateOptionGrammar(operation, usedOptions) {
  const allowed = OPERATION_OPTIONS[operation];
  for (const option of usedOptions) {
    if (!allowed.has(option)) usage(`--${option} is not valid for ${operation}`);
  }
}

function errorEffect(code, details = {}) {
  if (['verified', 'unknown'].includes(details?.providerMutation) &&
      ['verified', 'notAttempted', 'unknown'].includes(details.stop || 'verified') &&
      ['verified', 'notAttempted', 'unknown'].includes(details.archive || 'verified') &&
      ['verified', 'blocked', 'retryable'].includes(details.cleanup || 'verified') &&
      ['verified', 'notAttempted', 'unknown'].includes(details.localRemoval || 'verified')) {
    return {
      providerMutation: details.providerMutation,
      ...(details.stop ? { stop: details.stop } : {}),
      ...(details.archive ? { archive: details.archive } : {}),
      ...(details.cleanup ? { cleanup: details.cleanup } : {}),
      ...(details.localRemoval ? { localRemoval: details.localRemoval } : {}),
    };
  }
  if (code === 'CLEANUP_BLOCKED') {
    return { providerMutation: 'verified', cleanup: 'blocked' };
  }
  if (code === 'CLEANUP_RETRYABLE') {
    return { providerMutation: 'verified', cleanup: 'retryable' };
  }
  if (code === 'NOT_DELIVERED' || SAFE_REFUSALS.has(code) || code === 'USAGE_ERROR') {
    return { providerMutation: 'notAttempted' };
  }
  if (code === 'FORKED_COPY' || /UNCERTAIN|UNKNOWN|PARTIAL/.test(code || '')) {
    return { providerMutation: 'unknown' };
  }
  return { providerMutation: 'unknown' };
}

function exitCodeForError(code) {
  return SAFE_REFUSALS.has(code) || String(code || '').startsWith('ERR_PARSE_ARGS_') ? 2 : 3;
}

function resultExitCode(result) {
  if (result?.ok !== false) return 0;
  const entries = [
    ...(Array.isArray(result.results) ? result.results : []),
    ...(Array.isArray(result.recovered) ? result.recovered : []),
  ];
  const safeIncompleteOutcomes = new Set([
    'cleanupRetryable', 'differentRuntime', 'retirementPending',
  ]);
  let foundIncomplete = false;
  for (const entry of entries) {
    if (entry?.skipped === 'differentRuntime' || safeIncompleteOutcomes.has(entry?.outcome)) {
      foundIncomplete = true;
      continue;
    }
    if (entry?.error || entry?.delivery === 'unknown' ||
        /Unknown$|Pending$|uncertain/i.test(entry?.outcome || '')) {
      foundIncomplete = true;
      if (!SAFE_REFUSALS.has(entry?.code)) return 3;
    }
  }
  return foundIncomplete ? 2 : 3;
}

async function main(argv, env = process.env) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    return { help: HELP };
  }
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    tokens: true,
    options: {
      'repo-root': { type: 'string' },
      lane: { type: 'string' },
      target: { type: 'string' },
      name: { type: 'string' },
      input: { type: 'string' },
      'input-file': { type: 'string' },
      cwd: { type: 'string' },
      worktrees: { type: 'string' },
      url: { type: 'string' },
      'claude-bin': { type: 'string' },
      model: { type: 'string' },
      'private-archive': { type: 'boolean' },
      'finish-retirements': { type: 'boolean' },
      'no-cleanup-worktree': { type: 'boolean' },
      'harvested-output-sha256': { type: 'string' },
    },
  });
  if (parsed.positionals.length !== 1 || !OPERATIONS.has(parsed.positionals[0])) {
    usage(`operation must be one of: ${[...OPERATIONS].join(', ')}`);
  }
  const operation = parsed.positionals[0];
  const values = parsed.values;
  validateOptionGrammar(
    operation,
    new Set(parsed.tokens.filter((token) => token.kind === 'option').map((token) => token.name)),
  );
  const repoRoot = values['repo-root'] || env.REPO_ROOT;
  if (!repoRoot || !path.isAbsolute(repoRoot)) usage('--repo-root (or REPO_ROOT) must be absolute');
  const input = readInput(values);
  const options = {
    repoRoot,
    laneId: values.lane,
    name: values.name,
    input,
    message: input,
    cwd: values.cwd,
    worktrees: values.worktrees,
    url: values.url,
    claudeBin: values['claude-bin'],
    model: values.model,
    privateArchive: values['private-archive'],
    finishRetirements: values['finish-retirements'],
    cleanupWorktree: !values['no-cleanup-worktree'],
    harvestedOutputSha256: values['harvested-output-sha256'],
  };

  if (operation === 'spawn') {
    if (!['codex', 'claude'].includes(values.target)) usage('spawn requires --target codex|claude');
    if (values.target === 'codex' && values['claude-bin'] !== undefined) {
      usage('--claude-bin is valid only for Claude targets');
    }
    if (values.target === 'codex' && values.model !== undefined) {
      usage('--model is currently valid only for Claude targets');
    }
    if (values.target === 'claude' && values.url !== undefined) {
      usage('--url is valid only for Codex targets');
    }
    return values.target === 'codex' ? codex.spawn(options, env) : claude.spawn(options, env);
  }
  if (operation === 'reconcile') {
    if (!['codex', 'claude'].includes(values.target)) usage('reconcile requires --target codex|claude');
    if (values.target === 'codex' && (values['claude-bin'] !== undefined || values['private-archive'] !== undefined)) {
      usage('Claude options are valid only for Claude reconciliation');
    }
    if (values.target === 'codex' && values['finish-retirements'] !== undefined) {
      usage('--finish-retirements is valid only for Claude reconciliation');
    }
    if (values.target === 'claude' && values.url !== undefined) {
      usage('--url is valid only for Codex reconciliation');
    }
    if (values.target === 'codex') {
      const result = await codex.recover(options, env);
      return { ...result, operation: 'reconcile' };
    }
    return claude.reconcile(options, env);
  }
  if (!values.lane) usage(`${operation} requires --lane`);
  const adapter = adapterForLane(repoRoot, values.lane, env);
  if (values.url !== undefined && adapter !== codex) usage('--url is valid only for Codex lanes');
  if (values['claude-bin'] !== undefined && adapter !== claude) usage('--claude-bin is valid only for Claude lanes');
  if (values['private-archive'] !== undefined && adapter !== claude) {
    usage('--private-archive is valid only for Claude retirement');
  }
  if (operation === 'interrupt') {
    if (adapter !== codex) usage('interrupt is supported only for Codex turn cancellation');
    return codex.interrupt(options, env);
  }
  if (operation === 'stop') {
    if (adapter !== claude) usage('stop is supported only for Claude whole-session stopping');
    return claude.stop(options, env);
  }
  if (operation === 'recover' && input !== undefined) {
    if (adapter !== codex) usage('--input is valid only for Codex boundary recovery');
    const result = await codex.resume(options, env);
    return { ...result, operation: 'recover' };
  }
  if (typeof adapter[operation] !== 'function') usage(`${operation} is not supported by ${adapter === codex ? 'codex' : 'claude'}`);
  return adapter[operation](options, env);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((result) => {
    if (result?.help) {
      console.log(result.help);
      return;
    }
    console.log(JSON.stringify(publicSuccess(result), null, 2));
    process.exitCode = resultExitCode(result);
  }).catch((error) => {
    const code = error.code || 'OPERATOR_ERROR';
    const effect = errorEffect(code, error.details);
    const details = safeDetails(error.details);
    const hasDetails = Array.isArray(details) ? details.length > 0 :
      details && typeof details === 'object' ? Object.keys(details).length > 0 :
        details !== undefined;
    const stageUnknown = Object.values(effect).includes('unknown');
    const body = {
      version: 1,
      ok: false,
      code,
      message: publicErrorMessage(code),
      delivery: stageUnknown ? 'unknown' :
        effect.providerMutation === 'verified' ? 'confirmed' :
          code === 'NOT_DELIVERED' ? 'notDelivered' : 'notAttempted',
      effect,
      ...(hasDetails ? { details } : {}),
    };
    console.error(JSON.stringify(body, null, 2));
    process.exitCode = exitCodeForError(body.code);
  });
}

module.exports = {
  errorEffect,
  exitCodeForError,
  main,
  publicSuccess,
  publicErrorMessage,
  readInput,
  resultExitCode,
  safeDetails,
  safeString,
  validateOptionGrammar,
};
