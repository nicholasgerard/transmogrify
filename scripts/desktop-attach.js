#!/usr/bin/env node
'use strict';

// Detect, launch, or relaunch Codex Desktop as a client of the selected shared
// app-server runtime so lanes render and stream live in the app. This file is
// only the CLI surface over scripts/lib/desktop-attach.js: it parses arguments,
// prints one JSON result, and maps outcomes to exit codes. It never touches the
// runtime, and it quits a running Desktop only through the app's own
// application quit after explicit or standing owner authorization.

const { parseArgs } = require('node:util');
const {
  DEFAULT_ATTACH_TIMEOUT_MS,
  DISABLE_ENV,
  DesktopAttachError,
  RELAUNCH_ENV,
  check,
  ensure,
} = require('./lib/desktop-attach');

const HELP = `usage: desktop-attach.js <check|ensure> [options]

operations:
  check     read-only: report whether Codex Desktop holds a live connection to
            the runtime (exit 0 attached, 3 otherwise)
  ensure    reuse an existing attachment; launch Desktop attached when it is
            not running; relaunch it only with authorization

options:
  --url <loopback-ws-url>   runtime endpoint (default: TRANSMOGRIFY_URL or
                            ws://127.0.0.1:\${TRANSMOGRIFY_PORT:-8843})
  --relaunch-desktop        authorize quitting a running unattached Desktop
                            for this run (or set ${RELAUNCH_ENV}=auto)
  --timeout-ms <ms>         attachment wait after a launch
                            (default ${DEFAULT_ATTACH_TIMEOUT_MS})

environment:
  ${DISABLE_ENV}=off   report the check as disabled without probing
  ${RELAUNCH_ENV}=auto standing owner authorization to relaunch

exit codes:
  0  attached (check) or attachment ensured (ensure)
  1  ensure failed; the JSON result carries the code, for example
     DESKTOP_RELAUNCH_REQUIRED, DESKTOP_HOST_SESSION, ATTACHED_ELSEWHERE,
     RUNTIME_UNAVAILABLE, ATTACH_TIMEOUT, DESKTOP_QUIT_TIMEOUT
  2  usage error
  3  check found no attachment`;

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
      'timeout-ms': { type: 'string' },
    },
  });
  if (parsed.positionals.length !== 1 || !['check', 'ensure'].includes(parsed.positionals[0])) {
    usage('the operation must be check or ensure');
  }
  const operation = parsed.positionals[0];
  if (operation === 'check' &&
      (parsed.values['relaunch-desktop'] !== undefined || parsed.values['timeout-ms'] !== undefined)) {
    usage('--relaunch-desktop and --timeout-ms apply to ensure only');
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
    timeoutMs,
  };
}

// Dispatches to the library check or ensure. Neither throws for an unattached
// Desktop: that is a measured observation and returns as an ok:false receipt.
async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const options = parseCli(argv);
  if (options.help) return options;
  if (options.operation === 'check') return check(options, env, dependencies);
  return ensure(options, env, dependencies);
}

// An unattached observation is a result, not an exception: it prints as JSON and
// exits 3, while a usage error exits 2 and every other failure exits 1.
if (require.main === module) {
  main().then((result) => {
    if (result?.help) {
      console.log(result.help);
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 3;
  }).catch((error) => {
    const usageError = error?.code === 'USAGE_ERROR' ||
      String(error?.code || '').startsWith('ERR_PARSE_ARGS_');
    console.log(JSON.stringify({
      version: 1,
      ok: false,
      code: usageError ? 'USAGE_ERROR' : (error?.code || 'DESKTOP_ATTACH_FAILED'),
      message: error?.message || String(error),
      ...(error?.details ? { details: error.details } : {}),
    }, null, 2));
    process.exitCode = usageError ? 2 : 1;
  });
}

module.exports = { HELP, main, parseCli };
