#!/usr/bin/env node
'use strict';

// Detect, launch, or relaunch Codex Desktop as a client of the selected shared
// app-server runtime so lanes render and stream live in the app. This file is
// only the CLI surface over scripts/lib/desktop-attach.js: it parses arguments,
// prints one JSON result, and maps outcomes to exit codes. Runtime startup is
// delegated to runtime-up, and a running Desktop is quit only through the
// app's own quit after explicit or standing owner authorization.

const { parseArgs } = require('node:util');
const { exitCodeForError, failureBody, publicErrorMessage } = require('./lib/public-error');
const {
  DEFAULT_ATTACH_TIMEOUT_MS,
  DISABLE_ENV,
  DesktopAttachError,
  RELAUNCH_ENV,
  applyPersisted,
  check,
  ensure,
  persist,
  unpersist,
} = require('./lib/desktop-attach');

const HELP = `usage: desktop-attach.js <check|ensure|persist|unpersist> [options]

operations:
  check     read-only: report whether Codex Desktop holds a live connection to
            the runtime (exit 0 attached, 3 otherwise)
  ensure    reuse an existing attachment; launch Desktop attached when it is
            not running; relaunch it only with authorization
  persist   set the login-session runtime URL and write the per-user
            LaunchAgent that ensures the runtime before reapplying it at login
  unpersist remove the managed LaunchAgent and login-session runtime URL

options:
  --url <loopback-ws-url>   runtime endpoint (default: TRANSMOGRIFY_URL or
                            live relay record, then legacy port 8843)
  --relaunch-desktop        authorize quitting a running unattached Desktop
                            for this run (or set ${RELAUNCH_ENV}=auto)
  --launch-only             launch a stopped Desktop against an already-live
                            relay without starting a runtime or relay
  --timeout-ms <ms>         attachment wait after a launch
                            (default ${DEFAULT_ATTACH_TIMEOUT_MS})
  --dry-run                 show the exact persistence write and environment
                            change without performing either
  --authorize               confirm the owner approved a real persist or
                            unpersist operation

environment:
  ${DISABLE_ENV}=off   report the check as disabled without probing
  ${RELAUNCH_ENV}=auto standing owner authorization to relaunch

exit codes (shared by every Transmogrify command):
  0  attached (check) or attachment ensured (ensure)
  2  usage error, or ensure refused before acting (DESKTOP_RELAUNCH_REQUIRED,
     DESKTOP_HOST_SESSION, ATTACHED_ELSEWHERE, RUNTIME_UNAVAILABLE, ...)
  3  check found no attachment, or ensure acted and did not finish
     (ATTACH_TIMEOUT, DESKTOP_QUIT_TIMEOUT, DESKTOP_LAUNCH_FAILED, ...)`;

function usage(message) {
  throw new DesktopAttachError(message, 'USAGE_ERROR');
}

// Parses the operation and its options, refusing --relaunch-desktop and
// --timeout-ms on check so a read-only invocation can never authorize a quit.
// A bare invocation or a lone --help returns help text instead of an operation.
function parseCli(argv) {
  if (argv.length === 0 || (argv.length === 1 && ['--help', '-h'].includes(argv[0]))) {
    return { help: HELP };
  }
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      url: { type: 'string' },
      'relaunch-desktop': { type: 'boolean' },
      'launch-only': { type: 'boolean' },
      'timeout-ms': { type: 'string' },
      'dry-run': { type: 'boolean' },
      authorize: { type: 'boolean' },
    },
  });
  const operations = ['check', 'ensure', 'persist', 'unpersist', 'apply-persisted'];
  if (parsed.positionals.length !== 1 || !operations.includes(parsed.positionals[0])) {
    usage('the operation must be check, ensure, persist, or unpersist');
  }
  const operation = parsed.positionals[0];
  if (operation !== 'ensure' &&
      (parsed.values['relaunch-desktop'] !== undefined || parsed.values['launch-only'] !== undefined ||
        parsed.values['timeout-ms'] !== undefined)) {
    usage('--relaunch-desktop, --launch-only, and --timeout-ms apply to ensure only');
  }
  if (parsed.values['relaunch-desktop'] === true && parsed.values['launch-only'] === true) {
    usage('--launch-only cannot be combined with --relaunch-desktop');
  }
  if (!['persist', 'unpersist'].includes(operation) &&
      (parsed.values['dry-run'] !== undefined || parsed.values.authorize !== undefined)) {
    usage('--dry-run and --authorize apply to persist and unpersist only');
  }
  if (operation === 'unpersist' && parsed.values.url !== undefined) {
    usage('--url does not apply to unpersist');
  }
  let timeoutMs;
  if (parsed.values['timeout-ms'] !== undefined) {
    if (!/^[1-9][0-9]*$/.test(parsed.values['timeout-ms'])) {
      usage('--timeout-ms must be a canonical positive integer');
    }
    timeoutMs = Number(parsed.values['timeout-ms']);
  }
  return {
    operation,
    url: parsed.values.url,
    relaunch: parsed.values['relaunch-desktop'] === true,
    launchOnly: parsed.values['launch-only'] === true,
    timeoutMs,
    dryRun: parsed.values['dry-run'] === true,
    authorize: parsed.values.authorize === true,
  };
}

// Dispatches to the library check or ensure. Neither throws for an unattached
// Desktop: that is a measured observation and returns as an ok:false receipt.
async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const options = parseCli(argv);
  if (options.help) return options;
  if (options.operation === 'check') return check(options, env, dependencies);
  if (options.operation === 'ensure') return ensure(options, env, dependencies);
  if (options.operation === 'persist') return persist(options, env, dependencies);
  if (options.operation === 'unpersist') return unpersist(options, env, dependencies);
  return applyPersisted(options, env, dependencies);
}

function cliFailure(error) {
  const failure = failureBody(error);
  return {
    version: failure.version,
    ok: failure.ok,
    code: failure.code,
    message: publicErrorMessage(failure.code),
  };
}

// An unattached observation is a result, not an exception: it prints as JSON and
// exits 3. A refusal before acting exits 2 and a failure after acting exits 3.
if (require.main === module) {
  main().then((result) => {
    if (result?.help) {
      console.log(result.help);
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 3;
  }).catch((error) => {
    const failure = cliFailure(error);
    console.error(JSON.stringify(failure, null, 2));
    process.exitCode = exitCodeForError(failure.code);
  });
}

module.exports = { HELP, cliFailure, main, parseCli };
