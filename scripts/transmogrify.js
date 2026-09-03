#!/usr/bin/env node
'use strict';

// One entry point for every Transmogrify command. Each subcommand runs the
// tool it names as a child process with the same arguments and inherited
// stdio, so the tools keep their own option grammars while the operator learns
// one command shape and one exit table.

const { spawn } = require('node:child_process');
const path = require('node:path');
const { EXIT } = require('./lib/public-error');
const { VERSION } = require('./lib/version');

const COMMANDS = new Map([
  ['doctor', { file: 'doctor.js', summary: 'read-only provider discovery and setup check' }],
  ['attach', { file: 'desktop-attach.js', summary: 'measure or ensure Codex Desktop attachment (macOS)' }],
  ['runtime', { file: 'runtime-up.sh', shell: true, summary: 'reuse or launch the detached Codex app-server' }],
  ['probe', { file: 'runtime-probe.js', summary: 'verify the app-server handshake and version line' }],
  ['lane', { file: 'lane.js', summary: 'spawn, steer, observe, recover, retire, reconcile, abandon' }],
  ['rpc', { file: 'rpc.js', summary: 'read-only Codex JSON-RPC diagnostics' }],
  ['listen', { file: 'lane-status-listen.js', summary: 'wait for a status transition on owned Codex lanes' }],
]);

const HELP = `usage: transmogrify.js <command> [options]

commands:
${[...COMMANDS].map(([name, command]) => `  ${name.padEnd(8)} ${command.summary}`).join('\n')}

Run transmogrify.js <command> --help for that command's options.

exit codes (shared by every command):
  0  confirmed result
  2  usage error or safe refusal; nothing was attempted
  3  failure or uncertain outcome after an attempt; observe before retrying
  1  unexpected internal error

Transmogrify ${VERSION}`;

// Resolve the first positional to a command. Returns { help } or { version }
// for the umbrella's own flags, or { command, args } for a dispatch.
function resolveCommand(argv) {
  if (argv.length === 0) return { error: 'a command is required' };
  const [name, ...args] = argv;
  if (['--help', '-h', 'help'].includes(name)) return { help: HELP };
  if (['--version', '-v', 'version'].includes(name)) return { version: VERSION };
  const command = COMMANDS.get(name);
  if (!command) return { error: `unknown command ${name}; expected one of ${[...COMMANDS.keys()].join(', ')}` };
  return { command: { name, ...command }, args };
}

// Run one command as a child with inherited stdio and resolve to its exit
// status. A child that cannot be started or that dies by signal is an
// internal error.
function run(argv, env = process.env, dependencies = {}) {
  const resolved = resolveCommand(argv);
  const stdout = dependencies.stdout || ((text) => process.stdout.write(`${text}\n`));
  const stderr = dependencies.stderr || ((text) => process.stderr.write(`${text}\n`));
  if (resolved.help) { stdout(resolved.help); return Promise.resolve(EXIT.ok); }
  if (resolved.version) { stdout(resolved.version); return Promise.resolve(EXIT.ok); }
  if (resolved.error) {
    stderr(`ERROR ${resolved.error}`);
    stderr(HELP);
    return Promise.resolve(EXIT.refused);
  }
  const { command, args } = resolved;
  const file = path.join(__dirname, command.file);
  const child = command.shell
    ? spawn(file, args, { env, stdio: 'inherit' })
    : spawn(process.execPath, [file, ...args], { env, stdio: 'inherit' });
  return new Promise((resolve) => {
    child.once('error', (error) => {
      stderr(`ERROR could not start ${command.name}: ${error.code || error.message}`);
      resolve(EXIT.internal);
    });
    child.once('exit', (code, signal) => {
      if (signal) {
        stderr(`ERROR ${command.name} ended by signal ${signal}`);
        resolve(EXIT.internal);
        return;
      }
      resolve(code ?? EXIT.internal);
    });
  });
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { COMMANDS, HELP, resolveCommand, run };
