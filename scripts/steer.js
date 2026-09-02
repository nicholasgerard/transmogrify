#!/usr/bin/env node
'use strict';

// Compatibility CLI for exact owned Codex lane control: mid-turn steer,
// boundary resume, and interrupt of the newest active turn. A repository root
// is required because the adapter verifies registry ownership and the newest
// turn before any provider mutation. Exit codes: 0 confirmed; 2 no active turn
// or not owned; 3 usage, transport, protocol, or delivery-unknown failure. It
// never creates, renames, or archives a lane.

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { interrupt: interruptLane, resume: resumeLane, steer: steerLane } = require('./lib/codex-adapter');
const { validateUrl } = require('./lib/app-server');

const MAX_INPUT_BYTES = 64 * 1024;

function usage(error) {
  if (error) console.error(`error: ${error}`);
  console.error('usage: steer.js [--resume|--interrupt] [--input-file <absolute|->] [--url ws://…] [--repo-root /absolute/repo] [--prefix "Tag:"|--no-prefix] [--] <threadId> [legacy-message]');
  process.exit(3);
}

const HELP = `usage: steer.js [--resume|--interrupt] [--input-file <absolute|->] [--url ws://…] [--repo-root /absolute/repo] [--prefix "Tag:"|--no-prefix] [--] <owned-thread-id> [legacy-message]

exit codes:
  0  the steer, resume, or interrupt was confirmed
  2  no active turn, or the thread is not owned by this installation
  3  usage, transport, protocol, or delivery-unknown failure`;

if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
  console.log(HELP);
  process.exit(0);
}

// Parses options up to the first positional or --, leaving the thread id and any
// legacy message for the caller. An unknown option is a usage failure rather
// than a positional, so a mistyped flag can never become steered input.
function parseArgs(argv) {
  const options = {
    interrupt: false,
    resume: false,
    noPrefix: false,
    prefix: null,
    inputFile: null,
    repoRoot: null,
    url: null,
  };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--') {
      index += 1;
      break;
    }
    if (!arg.startsWith('--')) break;
    if (arg === '--interrupt' || arg === '--resume' || arg === '--no-prefix') {
      options[arg.slice(2).replace('no-prefix', 'noPrefix')] = true;
      index += 1;
      continue;
    }
    if (arg === '--url' || arg === '--prefix' || arg === '--repo-root' || arg === '--input-file') {
      if (index + 1 >= argv.length) usage(`${arg} requires a value`);
      const key = arg === '--repo-root' ? 'repoRoot' : arg === '--input-file' ? 'inputFile' : arg.slice(2);
      options[key] = argv[index + 1];
      index += 2;
      continue;
    }
    usage(`unknown option ${arg}`);
  }
  return { options, positionals: argv.slice(index) };
}

// Reads at most MAX_INPUT_BYTES and requires strict UTF-8 with no NUL and no
// unpaired surrogate, so unbounded or unencodable text is refused before it can
// become a provider turn.
function readBounded(descriptor) {
  const chunks = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(16 * 1024, MAX_INPUT_BYTES + 1 - total));
    const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_INPUT_BYTES) usage(`input exceeds ${MAX_INPUT_BYTES} bytes`);
    chunks.push(chunk.subarray(0, count));
  }
  let value;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch {
    usage('input must be valid UTF-8');
  }
  if (!value || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) {
    usage('input must be non-empty UTF-8 without NUL or unpaired surrogates');
  }
  return value;
}

// Opens an absolute path without following a symlink and requires a
// caller-owned regular file that is not group or world writable, so another
// writer cannot substitute the text an owned lane will be steered with.
function readInputFile(inputFile) {
  if (inputFile === '-') return readBounded(0);
  if (!path.isAbsolute(inputFile)) usage('--input-file must be absolute or -');
  let descriptor;
  try {
    descriptor = fs.openSync(inputFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        (stat.mode & 0o022) !== 0) {
      usage('--input-file must be a safe bounded regular file');
    }
    return readBounded(descriptor);
  } catch (error) {
    if (error.code === 'USAGE_ERROR') throw error;
    usage('--input-file must be a safe bounded regular file');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

const { options, positionals } = parseArgs(process.argv.slice(2));
if (options.interrupt && options.resume) usage('--interrupt and --resume are mutually exclusive');
const url = options.url || process.env.TRANSMOGRIFY_URL ||
  `ws://127.0.0.1:${process.env.TRANSMOGRIFY_PORT || '8843'}`;
try { validateUrl(url); } catch (error) { usage(error.message); }
const [providerId, ...messageParts] = positionals;
if (options.inputFile !== null && messageParts.length > 0) {
  usage('use --input-file or a legacy positional message, not both');
}
if (options.interrupt && (options.inputFile !== null || messageParts.length > 0)) {
  usage('--interrupt does not accept input');
}
const rawMessage = options.inputFile === null ? messageParts.join(' ') : readInputFile(options.inputFile);
if (!providerId || (!options.interrupt && !rawMessage)) {
  usage('thread id and message are required (message is omitted only with --interrupt)');
}
const repoRoot = options.repoRoot || process.env.REPO_ROOT;
if (!repoRoot) usage('--repo-root or REPO_ROOT is required for ownership verification');
// Steered text is attributed to its orchestrator unless the caller supplies a
// different prefix or suppresses the prefix outright.
const prefixText = options.prefix === null ? 'Orchestrator:' : options.prefix;
const message = options.noPrefix ? rawMessage : `${prefixText} ${rawMessage}`;
const request = { repoRoot, providerId, url, message };

(async () => {
  try {
    if (options.interrupt) {
      await interruptLane(request);
      console.log('interrupted newest active turn on owned Codex lane');
      return;
    }
    if (options.resume) {
      const result = await resumeLane(request);
      console.log(`resumed owned Codex lane at turn boundary (ack=${result.receipt.acknowledgedBy})`);
      return;
    }
    await steerLane(request);
    console.log('steered newest active turn on owned Codex lane');
  } catch (error) {
    if (error.code === 'NO_ACTIVE_TURN' || /NOT_OWNED/.test(error.message)) {
      console.error(error.message.includes('NOT_OWNED')
        ? 'NOT_OWNED: requested Codex lane is not registered'
        : `${error.message} — use --resume to steer at the boundary`);
      process.exitCode = 2;
      return;
    }
    console.error(`error: Codex control operation failed (${error.code || 'OPERATOR_ERROR'})`);
    process.exitCode = 3;
  }
})();
