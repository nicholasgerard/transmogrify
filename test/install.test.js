'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { REPO_ROOT } = require('./helpers/run-cli');
const { install, resolveWsRoot } = require('../scripts/install');

function runInstaller(env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [path.join(REPO_ROOT, 'install.sh'), ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('installer refuses Node.js older than 20 before changing destinations', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-old-node-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const fakeNode = path.join(bin, 'node');
  fs.writeFileSync(fakeNode, [
    '#!/bin/sh',
    'if [ "$1" = "-p" ]; then echo 18; else echo v18.20.0; fi',
    '',
  ].join('\n'), { mode: 0o755 });

  const result = await runInstaller({
    HOME: path.join(root, 'home'),
    PATH: `${bin}:/usr/bin:/bin`,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /node 20 or newer is required \(found v18\.20\.0\)/);
  assert.equal(fs.existsSync(path.join(root, 'home')), false);
});

test('installer stages complete fresh installs for Claude and Codex', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);

  const result = await runInstaller({ HOME: home });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Claude Desktop and the ChatGPT app are ready to load Transmogrify/);
  assert.match(result.stdout, /new session in the other app picks it up/);

  for (const target of [
    path.join(home, '.claude', 'skills', 'transmogrify'),
    path.join(home, '.agents', 'skills', 'transmogrify'),
  ]) {
    assert.equal(fs.existsSync(path.join(target, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(target, '.transmogrify-install.json')), true);
    assert.equal(fs.existsSync(path.join(target, 'LICENSE')), true);
    assert.equal(fs.existsSync(path.join(target, 'CODE_OF_CONDUCT.md')), true);
    assert.equal(fs.existsSync(path.join(target, 'scripts', 'runtime-probe.js')), true);
    const installedRequire = require('node:module').createRequire(path.join(target, 'package.json'));
    assert.equal(typeof installedRequire('ws').WebSocket, 'function');
  }
});

test('installer replaces rather than overlays and preserves a backup', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-reinstall-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const claudeTarget = path.join(home, '.claude', 'skills', 'transmogrify');
  fs.mkdirSync(home);
  const first = await runInstaller({ HOME: home });
  assert.equal(first.code, 0, first.stderr);
  fs.writeFileSync(path.join(claudeTarget, 'stale-file'), 'old');

  const result = await runInstaller({ HOME: home });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(claudeTarget, 'stale-file')), false);

  const backupRoot = path.join(home, '.claude', 'transmogrify-backups');
  const backups = fs.readdirSync(backupRoot)
    .filter((entry) => entry.startsWith('transmogrify.backup-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(backupRoot, backups[0], 'stale-file'), 'utf8'), 'old');
  assert.deepEqual(
    fs.readdirSync(path.join(home, '.claude', 'skills')),
    ['transmogrify'],
  );
});

test('installer help and dry-run never create destinations or claim installation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-install-help-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);

  const help = await runInstaller({ HOME: home }, ['--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /--target all\|codex\|claude/);
  assert.doesNotMatch(help.stdout, /open a new host session/);

  const dryRun = await runInstaller(
    { HOME: home },
    ['--target', 'claude', '--dry-run'],
  );
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /would install claude skill/);
  assert.doesNotMatch(dryRun.stdout, /open a new host session/);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills')), false);
  assert.equal(fs.existsSync(path.join(home, '.agents')), false);
});

test('installer refuses an unrelated occupied skill target', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-install-collision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const target = path.join(home, '.claude', 'skills', 'transmogrify');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: something-else\n---\n');

  const result = await runInstaller({ HOME: home });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /occupied by an unrecognized installation/);
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8').includes('something-else'), true);
});

test('installer refuses a symlinked destination without changing its target', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  const claudeSkills = path.join(home, '.claude', 'skills');
  fs.mkdirSync(claudeSkills, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'safe');
  fs.symlinkSync(outside, path.join(claudeSkills, 'transmogrify'));

  const result = await runInstaller({ HOME: home });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /symlinked skill target/);
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'safe');
});

test('installer refuses a symlinked ancestor before creating through it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-install-ancestor-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(home);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(home, '.claude'));

  const dryRun = await runInstaller({ HOME: home }, ['--target', 'claude', '--dry-run']);
  assert.equal(dryRun.code, 1);
  assert.match(dryRun.stderr, /symlinked path component/);
  assert.equal(fs.existsSync(path.join(outside, 'skills')), false);

  const install = await runInstaller({ HOME: home }, ['--target', 'claude']);
  assert.equal(install.code, 1);
  assert.match(install.stderr, /symlinked path component/);
  assert.equal(fs.existsSync(path.join(outside, 'skills')), false);
});

test('installer refuses a group/world-writable skill parent', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-install-public-parent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const skills = path.join(home, '.agents', 'skills');
  fs.mkdirSync(skills, { recursive: true });
  fs.chmodSync(skills, 0o777);
  const result = await runInstaller({ HOME: home }, ['--target', 'codex']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /non-owner-controlled install path/);
  assert.equal(fs.existsSync(path.join(skills, 'transmogrify')), false);
});

test('installer revalidates every target immediately before swap', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-install-swap-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const claudeTarget = path.join(home, '.claude', 'skills', 'transmogrify');
  const codexTarget = path.join(home, '.agents', 'skills', 'transmogrify');
  fs.mkdirSync(home);

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.throws(
      () => install({ target: 'all', dryRun: false }, {
        beforeSwap() {
          fs.mkdirSync(codexTarget, { recursive: true });
          fs.writeFileSync(path.join(codexTarget, 'sentinel'), 'unrelated\n');
        },
      }),
      /occupied by an unrecognized installation/,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }

  assert.equal(fs.existsSync(claudeTarget), false);
  assert.equal(fs.readFileSync(path.join(codexTarget, 'sentinel'), 'utf8'), 'unrelated\n');
});

test('installer refuses a replaced staging directory and does not delete the replacement', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-install-stage-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  let replacement;
  try {
    assert.throws(() => install({ target: 'claude', dryRun: false }, {
      beforeSwap(stages) {
        const [entry] = stages;
        fs.renameSync(entry.stage, `${entry.stage}.moved`);
        fs.mkdirSync(entry.stage, { mode: 0o700 });
        replacement = path.join(entry.stage, 'sentinel');
        fs.writeFileSync(replacement, 'replacement\n');
      },
    }), /staged skill directory identity changed/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  assert.equal(fs.readFileSync(replacement, 'utf8'), 'replacement\n');
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'transmogrify')), false);
});

test('installer refuses an ancestor ws package when the locked local copy is absent', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-ws-resolution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const ancestorWs = path.join(root, 'node_modules', 'ws');
  fs.mkdirSync(source);
  fs.mkdirSync(ancestorWs, { recursive: true });
  fs.writeFileSync(path.join(ancestorWs, 'package.json'), JSON.stringify({
    name: 'ws', version: '999.0.0', main: 'index.js',
  }));
  fs.writeFileSync(path.join(ancestorWs, 'index.js'), 'module.exports = {};\n');

  assert.throws(
    () => resolveWsRoot(source),
    /locked dependency ws is unavailable.*npm ci --ignore-scripts/,
  );
});

test('installer ignores unrelated CODEX_HOME and uses the documented Codex skill root', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-skill-roots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);

  const result = await runInstaller(
    { HOME: home, CODEX_HOME: 'relative-and-invalid' },
    [],
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'transmogrify')), true);
  assert.equal(fs.existsSync(path.join(home, '.agents', 'skills', 'transmogrify')), true);
});

test('dependency resolution rejects invalid lock metadata with a stable error', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-invalid-lock-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wsRoot = path.join(root, 'node_modules', 'ws');
  fs.mkdirSync(wsRoot, { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'package.json'), JSON.stringify({
    name: 'ws', version: '8.0.0', main: 'index.js',
  }));
  fs.writeFileSync(path.join(wsRoot, 'index.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{not-json');

  assert.throws(
    () => resolveWsRoot(root),
    /locked dependency metadata is missing or invalid/,
  );
});

test('dependency resolution refuses a symlinked local ws package', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-symlinked-ws-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nodeModules = path.join(root, 'node_modules');
  const outsideWs = path.join(root, 'outside-ws');
  fs.mkdirSync(nodeModules);
  fs.mkdirSync(outsideWs);
  fs.writeFileSync(path.join(outsideWs, 'package.json'), JSON.stringify({
    name: 'ws', version: '8.0.0', main: 'index.js',
  }));
  fs.writeFileSync(path.join(outsideWs, 'index.js'), 'module.exports = {};\n');
  fs.symlinkSync(outsideWs, path.join(nodeModules, 'ws'));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    packages: { 'node_modules/ws': { version: '8.0.0' } },
  }));

  assert.throws(
    () => resolveWsRoot(root),
    /locked dependency path is not a safe directory/,
  );
});

test('a failure during the swap restores the previous install and leaves no stage or failed tree', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = previousHome; });
  const quiet = t.mock.method(console, 'log', () => {});
  t.after(() => quiet.mock.restore());

  install({ target: 'claude' });
  const target = path.join(home, '.claude', 'skills', 'transmogrify');
  fs.writeFileSync(path.join(target, 'MARKER'), 'previous install');

  const originalRename = fs.renameSync;
  let failed = false;
  fs.renameSync = (from, to) => {
    const sameTarget = path.basename(to) === path.basename(target) &&
      fs.realpathSync(path.dirname(to)) === fs.realpathSync(path.dirname(target));
    if (!failed && sameTarget && path.basename(from) !== path.basename(target)) {
      failed = true;
      throw new Error('simulated swap failure');
    }
    return originalRename(from, to);
  };
  t.after(() => { fs.renameSync = originalRename; });
  assert.throws(() => install({ target: 'claude' }), /simulated swap failure/);
  fs.renameSync = originalRename;

  assert.equal(fs.readFileSync(path.join(target, 'MARKER'), 'utf8'), 'previous install');
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude', 'skills')), ['transmogrify']);
  const backups = fs.existsSync(path.join(home, '.claude', 'transmogrify-backups'))
    ? fs.readdirSync(path.join(home, '.claude', 'transmogrify-backups')) : [];
  assert.deepEqual(backups, []);
});
