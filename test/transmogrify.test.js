'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { COMMANDS, HELP, resolveCommand, run } = require('../scripts/transmogrify');
const { runNodeScript } = require('./helpers/run-cli');

test('every umbrella command names an existing tool and appears in help', () => {
  for (const [name, command] of COMMANDS) {
    const file = path.join(__dirname, '..', 'scripts', command.file);
    assert.ok(fs.existsSync(file), `${name} -> ${command.file}`);
    assert.match(HELP, new RegExp(`^  ${name} `, 'm'));
  }
  assert.match(HELP, /exit codes \(shared by every command\)/);
});

test('umbrella resolves its own flags and refuses unknown commands', () => {
  assert.equal(resolveCommand(['--help']).help, HELP);
  assert.equal(typeof resolveCommand(['--version']).version, 'string');
  assert.match(resolveCommand([]).error, /command is required/);
  assert.match(resolveCommand(['steer']).error, /unknown command steer/);
  const lane = resolveCommand(['lane', 'status', '--lane', 'x']);
  assert.equal(lane.command.name, 'lane');
  assert.deepEqual(lane.args, ['status', '--lane', 'x']);
});

test('umbrella exits 2 for an unknown command without starting a tool', async () => {
  const out = [];
  const err = [];
  const code = await run(['bogus'], process.env, { stdout: (t) => out.push(t), stderr: (t) => err.push(t) });
  assert.equal(code, 2);
  assert.equal(out.length, 0);
  assert.match(err.join('\n'), /unknown command bogus/);
});

test('umbrella forwards arguments and propagates the tool exit status', async () => {
  const help = await runNodeScript('scripts/transmogrify.js', ['doctor', '--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /^usage: doctor\.js/);
  const usage = await runNodeScript('scripts/transmogrify.js', ['lane', 'status', '--bogus']);
  assert.equal(usage.code, 2);
  assert.equal(JSON.parse(usage.stderr).code, 'USAGE_ERROR');
  const version = await runNodeScript('scripts/transmogrify.js', ['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});
