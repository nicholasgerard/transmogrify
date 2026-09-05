#!/usr/bin/env node
'use strict';

const { runtimeUrl } = require('./lib/codex-runtime');

// A bounded maintenance runner around the read-only doctor and each
// provider's own exact-owned reconcile. It runs the doctor for the selected
// targets, then reconciles every provider the doctor reports available; it
// never spawns, steers, stops, harvests, or infers completion on its own,
// and it passes --private-archive / --finish-retirements to a provider only
// when the caller supplied them. `--retention` switches to a separate,
// conservative cleanup pass (scripts/lib/retention.js) over this
// installation's own local state and reports a different result shape.
//
// Output is one JSON document carrying only aggregate counts: no provider
// id, lane id, name, or path ever reaches it.

const path = require('node:path');
const { parseArgs } = require('node:util');
const { validateUrl } = require('./lib/app-server');
const { boundedInteger: sharedBoundedInteger } = require('./lib/validation');
const { reconcileEntryOk } = require('./lib/adapter-kit');
const { doctor } = require('./doctor');
const codexAdapter = require('./lib/codex-adapter');
const claudeAdapter = require('./lib/claude-adapter');
const { runRetention, DEFAULT_KEEP_BACKUPS, DEFAULT_KEEP_DAYS } = require('./lib/retention');
const { listParentContexts, countEvents } = require('./lib/dispatch');
const { listLanes, listOperations } = require('./lib/state');
const { EXIT, exitCodeForError, failureBody } = require('./lib/public-error');
const { publicResult } = require('./lib/output-schema');

const ADAPTERS = { codex: codexAdapter, claude: claudeAdapter };
// Flags a reconcile call may carry, gated per target by that adapter's own
// published option set -- the same source lane.js's option grammar uses.
const RECONCILE_FLAGS = ['url', 'claude-bin', 'private-archive', 'finish-retirements'];
const DEFAULT_DOCTOR_TIMEOUT_MS = 20_000;
const OWNED_ACTIVE_STATES = new Set(['active', 'idle', 'created', 'materialized']);

const HELP = `usage: maintain.js --repo-root <absolute-path> [options]

options:
  --target codex|claude|all     providers to maintain (default: all)
  --url <loopback-ws-url>       Codex app-server endpoint
  --claude-bin <absolute>       exact Claude CLI executable
  --private-archive             Claude only: authorize private retirement archival
  --finish-retirements          settle a retirement whose provider side is verified
  --timeout-ms <100..600000>    bound the doctor probe and each reconcile
  --dry-run                     run the doctor only; report what would reconcile

retention mode:
  maintain.js --repo-root <absolute-path> --retention [--dry-run]
              [--keep-days <n>] [--keep-backups <n>]

  --keep-days <n>       operation-journal age window in days (default: ${DEFAULT_KEEP_DAYS})
  --keep-backups <n>    installer backups kept per backup root (default: ${DEFAULT_KEEP_BACKUPS})

This never spawns, steers, stops, or harvests a provider lane, and never
infers completion. It only runs the read-only doctor, each available
provider's own exact-owned reconcile, or the recoverable retention pass.

exit codes (shared by every Transmogrify command):
  0  every available provider reconciled with ok:true (or a dry run/retention pass)
  2  usage error; nothing was attempted
  3  a provider reconcile returned ok:false or threw
  1  unexpected internal error`;

function usage(message) {
  const error = new Error(message);
  error.code = 'USAGE_ERROR';
  throw error;
}

function boundedInteger(value, label, minimum, maximum, fallback) {
  return sharedBoundedInteger(value, label, minimum, maximum, fallback, usage);
}

function parseMaintainArgs(argv, env = process.env) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    return { help: HELP };
  }
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    tokens: true,
    options: {
      'repo-root': { type: 'string' },
      target: { type: 'string' },
      url: { type: 'string' },
      'claude-bin': { type: 'string' },
      'private-archive': { type: 'boolean' },
      'finish-retirements': { type: 'boolean' },
      'timeout-ms': { type: 'string' },
      'dry-run': { type: 'boolean' },
      retention: { type: 'boolean' },
      'keep-days': { type: 'string' },
      'keep-backups': { type: 'string' },
    },
  });
  const values = parsed.values;
  const used = new Set(parsed.tokens.filter((token) => token.kind === 'option').map((token) => token.name));
  const repoRoot = values['repo-root'] || env.REPO_ROOT;
  if (!repoRoot || !path.isAbsolute(repoRoot)) usage('--repo-root or REPO_ROOT must be an absolute path');
  const dryRun = values['dry-run'] === true;

  if (values.retention) {
    for (const foreign of ['target', 'url', 'claude-bin', 'private-archive', 'finish-retirements', 'timeout-ms']) {
      if (used.has(foreign)) usage(`--${foreign} is not valid with --retention`);
    }
    return {
      repoRoot,
      retention: true,
      dryRun,
      keepDays: boundedInteger(values['keep-days'], '--keep-days', 0, 3650, DEFAULT_KEEP_DAYS),
      keepBackups: boundedInteger(values['keep-backups'], '--keep-backups', 0, 1000, DEFAULT_KEEP_BACKUPS),
    };
  }
  for (const foreign of ['keep-days', 'keep-backups']) {
    if (used.has(foreign)) usage(`--${foreign} is only valid with --retention`);
  }
  const target = values.target || 'all';
  if (!['codex', 'claude', 'all'].includes(target)) usage('--target must be codex, claude, or all');
  if (target !== 'all') {
    const allowed = ADAPTERS[target].descriptor.options;
    for (const flag of RECONCILE_FLAGS) {
      if (used.has(flag) && !allowed.has(flag)) usage(`--${flag} is not valid for --target ${target}`);
    }
  }
  const timeoutMs = boundedInteger(values['timeout-ms'], '--timeout-ms', 100, 600_000, undefined);
  let url;
  if (target !== 'claude') {
    try {
      url = validateUrl(runtimeUrl(values, env));
    } catch (error) { usage(error.message); }
  }
  const claudeBin = target === 'codex' ? undefined : (values['claude-bin'] || env.CLAUDE_BIN);
  if (claudeBin && !path.isAbsolute(claudeBin)) usage('--claude-bin or CLAUDE_BIN must be an absolute path');
  return {
    repoRoot,
    retention: false,
    target,
    url,
    claudeBin,
    timeoutMs,
    dryRun,
    ...(values['private-archive'] === true ? { privateArchive: true } : {}),
    ...(values['finish-retirements'] === true ? { finishRetirements: true } : {}),
  };
}


// Run one provider's exact-owned reconcile, or explain why it did not run.
// Never throws: a reconcile failure is folded into the returned summary so
// one provider's trouble cannot take down the whole maintenance pass.
async function reconcileProvider(target, doctorEntry, options, env, dependencies) {
  if (!doctorEntry.requested) {
    return { available: null, reconciled: false, results: 0, notOk: 0, skipped: 'not-requested' };
  }
  if (doctorEntry.available !== true) {
    return { available: doctorEntry.available, reconciled: false, results: 0, notOk: 0, skipped: 'provider-unavailable' };
  }
  if (options.dryRun) {
    return { available: true, reconciled: false, results: 0, notOk: 0, skipped: 'dry-run' };
  }
  const reconcile = target === 'codex'
    ? dependencies.codexReconcile || codexAdapter.reconcile
    : dependencies.claudeReconcile || claudeAdapter.reconcile;
  const reconcileOptions = {
    repoRoot: options.repoRoot,
    url: options.url,
    claudeBin: options.claudeBin,
    timeoutMs: options.timeoutMs,
    ...(options.privateArchive !== undefined ? { privateArchive: options.privateArchive } : {}),
    ...(options.finishRetirements !== undefined ? { finishRetirements: options.finishRetirements } : {}),
  };
  try {
    const result = await reconcile(reconcileOptions, env);
    const entries = Array.isArray(result?.results) ? result.results : [];
    return {
      available: true,
      reconciled: result?.ok === true,
      results: entries.length,
      notOk: entries.filter((entry) => !reconcileEntryOk(entry)).length,
      skipped: null,
    };
  } catch (error) {
    // The provider's own message never reaches output; its stable code does.
    return { available: true, reconciled: false, results: 0, notOk: 0, skipped: null, code: error?.code || 'OPERATOR_ERROR' };
  }
}

// Aggregate registry counts, read fresh after reconciliation. Every count is
// a total across both backends; nothing here names a lane, a provider id, or
// a path.
function ownershipCounts(repoRoot, env) {
  const operationsById = new Map(listOperations(repoRoot, env).map((operation) => [operation.operationId, operation]));
  let ownedActive = 0;
  let ownedStopped = 0;
  let pendingOperations = 0;
  let pendingRetirements = 0;
  let cleanupBlocked = 0;
  for (const lane of listLanes(repoRoot, env)) {
    if (OWNED_ACTIVE_STATES.has(lane.state)) ownedActive += 1;
    if (lane.state === 'stopped') ownedStopped += 1;
    if (!lane.pendingOperationId) continue;
    pendingOperations += 1;
    const pending = operationsById.get(lane.pendingOperationId);
    if (pending?.type !== 'retire') continue;
    pendingRetirements += 1;
    if (pending.details?.cleanupBlocked === true) cleanupBlocked += 1;
  }
  const unattendedChildren = listParentContexts(env)
    .reduce((sum, context) => sum + countEvents(context, {}, env), 0);
  return { ownedActive, ownedStopped, pendingOperations, pendingRetirements, cleanupBlocked, unattendedChildren };
}

// Run the doctor for the selected targets, reconcile every provider it
// reports available, and report aggregate registry counts afterward.
async function maintain(options, env = process.env, dependencies = {}) {
  const runDoctor = dependencies.doctor || doctor;
  const doctorResult = await runDoctor({
    repoRoot: options.repoRoot,
    target: options.target,
    url: options.url,
    claudeBin: options.claudeBin,
    timeoutMs: options.timeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS,
  }, env, {});
  const providers = {
    codex: await reconcileProvider('codex', doctorResult.providers.codex, options, env, dependencies),
    claude: await reconcileProvider('claude', doctorResult.providers.claude, options, env, dependencies),
  };
  const counts = ownershipCounts(options.repoRoot, env);
  const ok = options.dryRun || ['codex', 'claude'].every((target) =>
    providers[target].available !== true || providers[target].reconciled === true);
  return {
    version: 1,
    ok,
    operation: 'maintain',
    dryRun: options.dryRun === true,
    providers,
    counts,
    setup: doctorResult.setup,
  };
}

async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const options = parseMaintainArgs(argv, env);
  if (options.help) return options;
  if (options.retention) {
    const retention = (dependencies.retention || runRetention)(options, env);
    return { version: 1, ok: true, operation: 'maintain', retention };
  }
  return maintain(options, env, dependencies);
}

if (require.main === module) {
  main().then((result) => {
    if (result?.help) {
      console.log(result.help);
      return;
    }
    console.log(JSON.stringify(publicResult(result), null, 2));
    if (!result.ok) process.exitCode = EXIT.failed;
  }).catch((error) => {
    const body = failureBody(error);
    console.error(JSON.stringify(body, null, 2));
    process.exitCode = exitCodeForError(body.code);
  });
}

module.exports = {
  main,
  maintain,
  parseMaintainArgs,
};
