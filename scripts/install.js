#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const SOURCE_ROOT = path.resolve(__dirname, '..');
const INSTALL_MANIFEST = '.transmogrify-install.json';
const SKILL_SLUG = 'transmogrify';
const HELP = `usage: install.sh [--target all|codex|claude] [--dry-run]

Installs the Transmogrify skill. The default target is all. Existing recognized
installations are moved to timestamped backups outside scanned skill roots;
unrelated occupied targets are refused.`;
const REQUIRED_FILES = [
  'SKILL.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'LICENSE',
  'package.json',
  'package-lock.json',
];
const OPTIONAL_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'ROADMAP.md',
];
const REQUIRED_DIRS = ['scripts', 'docs', 'examples'];

function fail(message) {
  throw new Error(message);
}

function assertAbsolute(name, value) {
  if (!value || !path.isAbsolute(value)) fail(`${name} must be an absolute path`);
  const resolved = path.resolve(value);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

function assertNoSymlinks(targetPath, stopAt) {
  const stop = path.resolve(stopAt);
  let current = path.resolve(targetPath);
  const relative = path.relative(stop, current);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    fail(`path escapes its authorized root: ${targetPath}`);
  }
  while (true) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) fail(`refusing symlinked path component: ${current}`);
      if (stat.isDirectory() &&
          ((typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
            (stat.mode & 0o022) !== 0)) {
        fail(`refusing non-owner-controlled install path: ${current}`);
      }
    }
    if (current === stop) return;
    current = path.dirname(current);
  }
}

function assertSourceTreeSafe(sourcePath) {
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) fail(`packaged source entry is a symlink: ${sourcePath}`);
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(sourcePath)) {
    assertSourceTreeSafe(path.join(sourcePath, entry));
  }
}

function parseOptions(argv) {
  const options = { target: 'all', dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--target') {
      const value = argv[index + 1];
      if (!['all', 'codex', 'claude'].includes(value)) {
        fail('--target must be all, codex, or claude');
      }
      options.target = value;
      index += 1;
      continue;
    }
    fail(`unknown installer option: ${arg}`);
  }
  if (options.help && argv.some((arg) => !['--help', '-h'].includes(arg))) {
    fail('--help cannot be combined with installer options');
  }
  return options;
}

function readRegularFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function recognizedInstall(target) {
  const manifestRaw = readRegularFile(path.join(target, INSTALL_MANIFEST));
  if (manifestRaw !== null) {
    try {
      const manifest = JSON.parse(manifestRaw);
      return manifest.schemaVersion === 1 && manifest.product === 'transmogrify' &&
        manifest.skillSlug === SKILL_SLUG;
    } catch {
      return false;
    }
  }

  return false;
}

function validateExistingTarget(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) fail(`refusing to overwrite symlinked skill target: ${target}`);
  if (!stat.isDirectory()) fail(`skill target exists but is not a directory: ${target}`);
  if ((typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o022) !== 0) {
    fail(`skill target is not owner-controlled: ${target}`);
  }
  if (!recognizedInstall(target)) {
    fail(`skill target is occupied by an unrecognized installation: ${target}`);
  }
}

function validateInstallPath(target, authorizedRoot) {
  assertNoSymlinks(path.dirname(target), authorizedRoot);
  validateExistingTarget(target);
}

function resolveWsRoot(sourceRoot = SOURCE_ROOT) {
  const nodeModulesRoot = path.join(sourceRoot, 'node_modules');
  const wsRoot = path.join(nodeModulesRoot, 'ws');
  const packageJson = path.join(wsRoot, 'package.json');
  if (!fs.existsSync(packageJson)) {
    fail(`locked dependency ws is unavailable from ${wsRoot}; run npm ci --ignore-scripts`);
  }
  for (const directory of [nodeModulesRoot, wsRoot]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(`locked dependency path is not a safe directory: ${directory}`);
    }
  }
  assertSourceTreeSafe(wsRoot);
  let metadata;
  let lock;
  try {
    metadata = JSON.parse(fs.readFileSync(path.join(wsRoot, 'package.json'), 'utf8'));
    lock = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package-lock.json'), 'utf8'));
  } catch {
    fail(`locked dependency metadata is missing or invalid under ${sourceRoot}`);
  }
  const lockedVersion = lock.packages?.['node_modules/ws']?.version;
  if (metadata.name !== 'ws' || typeof metadata.version !== 'string' ||
      typeof lockedVersion !== 'string' || metadata.version !== lockedVersion) {
    fail(`resolved dependency is not a valid ws package: ${wsRoot}`);
  }
  return { wsRoot, version: metadata.version };
}

function copyEntry(relativePath, destination) {
  const source = path.join(SOURCE_ROOT, relativePath);
  assertSourceTreeSafe(source);
  fs.cpSync(source, path.join(destination, relativePath), {
    recursive: fs.statSync(source).isDirectory(),
    errorOnExist: true,
    force: false,
  });
}

function validateBackupRoot(backupRoot, authorizedRoot) {
  assertNoSymlinks(backupRoot, authorizedRoot);
  if (!fs.existsSync(backupRoot)) return;
  const stat = fs.lstatSync(backupRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o022) !== 0) {
    fail(`backup root is not a safe directory: ${backupRoot}`);
  }
}

function directoryIdentity(directory) {
  const stat = fs.lstatSync(directory);
  return { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 };
}

function validateStagedDirectory(entry) {
  const stat = fs.lstatSync(entry.stage);
  const current = { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 };
  if (!stat.isDirectory() || stat.isSymbolicLink() || current.uid !== entry.stageIdentity.uid ||
      current.device !== entry.stageIdentity.device || current.inode !== entry.stageIdentity.inode ||
      current.mode !== entry.stageIdentity.mode || (current.mode & 0o077) !== 0) {
    fail(`staged skill directory identity changed before install: ${entry.stage}`);
  }
}

function removeExactStage(entry) {
  if (!fs.existsSync(entry.stage)) return;
  try { validateStagedDirectory(entry); } catch { return; }
  fs.rmSync(entry.stage, { recursive: true, force: true });
}

function stageInstall(target, authorizedRoot, backupRoot, wsRoot, transactionId) {
  const parent = path.dirname(target);
  validateInstallPath(target, authorizedRoot);
  validateBackupRoot(backupRoot, authorizedRoot);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertNoSymlinks(parent, authorizedRoot);
  validateExistingTarget(target);

  const stage = path.join(parent, `.transmogrify.stage-${transactionId}`);
  if (fs.existsSync(stage)) fail(`staging path already exists: ${stage}`);
  fs.mkdirSync(stage, { mode: 0o700 });

  try {
    for (const relativePath of REQUIRED_FILES) copyEntry(relativePath, stage);
    for (const relativePath of OPTIONAL_FILES) {
      if (fs.existsSync(path.join(SOURCE_ROOT, relativePath))) copyEntry(relativePath, stage);
    }
    for (const relativePath of REQUIRED_DIRS) copyEntry(relativePath, stage);
    const sourcePackage = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(stage, INSTALL_MANIFEST), `${JSON.stringify({
      schemaVersion: 1,
      product: 'transmogrify',
      skillSlug: SKILL_SLUG,
      version: sourcePackage.version,
    }, null, 2)}\n`, { mode: 0o600 });
    fs.mkdirSync(path.join(stage, 'node_modules'), { mode: 0o700 });
    fs.cpSync(wsRoot, path.join(stage, 'node_modules', 'ws'), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });

    const stagedRequire = createRequire(path.join(stage, 'package.json'));
    const loaded = stagedRequire('ws');
    if (typeof loaded.WebSocket !== 'function') {
      fail(`staged ws dependency failed verification at ${stage}`);
    }
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }

  return {
    target,
    stage,
    backupRoot,
    backup: path.join(backupRoot, `${SKILL_SLUG}.backup-${transactionId}`),
    failed: path.join(backupRoot, `${SKILL_SLUG}.failed-${transactionId}`),
    authorizedRoot,
    stageIdentity: directoryIdentity(stage),
  };
}

function install(options, hooks = {}) {
  const home = assertAbsolute('HOME', process.env.HOME || os.homedir());
  const wantsCodex = options.target === 'all' || options.target === 'codex';
  if (!fs.existsSync(home) || !fs.statSync(home).isDirectory()) {
    fail(`HOME directory does not exist: ${home}`);
  }

  for (const relativePath of [...REQUIRED_FILES, ...REQUIRED_DIRS]) {
    const source = path.join(SOURCE_ROOT, relativePath);
    if (!fs.existsSync(source)) fail(`required packaged source is missing: ${source}`);
    assertSourceTreeSafe(source);
  }
  const { wsRoot, version: wsVersion } = resolveWsRoot();

  const candidates = [
    {
      provider: 'claude',
      target: path.join(home, '.claude', 'skills', SKILL_SLUG),
      backupRoot: path.join(home, '.claude', 'transmogrify-backups'),
      root: home,
    },
    ...(wantsCodex ? [{
      provider: 'codex',
      target: path.join(home, '.agents', 'skills', SKILL_SLUG),
      backupRoot: path.join(home, '.agents', 'transmogrify-backups'),
      root: home,
    }] : []),
  ];
  const selected = candidates.filter((entry) => options.target === 'all' || options.target === entry.provider);
  const targets = [...new Map(selected.map((entry) => [path.resolve(entry.target), entry])).values()];
  if (options.dryRun) {
    for (const entry of targets) {
      validateInstallPath(entry.target, entry.root);
      validateBackupRoot(entry.backupRoot, entry.root);
      console.log(`would install ${entry.provider} skill -> ${entry.target}`);
    }
    console.log(`would bundle dependency: ws ${wsVersion}`);
    return;
  }
  const transactionId = `${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-${crypto.randomUUID()}`;
  const stages = [];

  try {
    for (const { target, root, backupRoot } of targets) {
      if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      stages.push(stageInstall(target, root, backupRoot, wsRoot, transactionId));
    }
  } catch (error) {
    for (const entry of stages) removeExactStage(entry);
    throw error;
  }

  const swapped = [];
  try {
    for (const entry of stages) {
      fs.mkdirSync(entry.backupRoot, { recursive: true, mode: 0o700 });
      validateBackupRoot(entry.backupRoot, entry.authorizedRoot);
    }
    if (typeof hooks.beforeSwap === 'function') hooks.beforeSwap(stages);
    for (const entry of stages) {
      validateInstallPath(entry.target, entry.authorizedRoot);
      validateBackupRoot(entry.backupRoot, entry.authorizedRoot);
      validateStagedDirectory(entry);
      const existed = fs.existsSync(entry.target);
      if (existed) {
        if (fs.existsSync(entry.backup)) fail(`backup target already exists: ${entry.backup}`);
        fs.renameSync(entry.target, entry.backup);
      }
      try {
        fs.renameSync(entry.stage, entry.target);
      } catch (error) {
        if (existed && fs.existsSync(entry.backup) && !fs.existsSync(entry.target)) {
          fs.renameSync(entry.backup, entry.target);
        }
        throw error;
      }
      swapped.push({ ...entry, existed });
    }
  } catch (error) {
    for (const entry of swapped.reverse()) {
      if (fs.existsSync(entry.failed)) fail(`failed-install target already exists: ${entry.failed}`);
      if (fs.existsSync(entry.target)) fs.renameSync(entry.target, entry.failed);
      if (entry.existed && fs.existsSync(entry.backup)) fs.renameSync(entry.backup, entry.target);
    }
    for (const entry of stages) {
      removeExactStage(entry);
    }
    throw error;
  }

  for (const entry of swapped) {
    if (entry.existed) console.log(`backed up existing install -> ${entry.backup}`);
    console.log(`installed skill + tools -> ${entry.target}`);
  }
  console.log(`verified dependency: ws ${wsVersion}`);
  console.log('open a new host session, then run Transmogrify bootstrap/doctor');
}

if (require.main === module) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      console.log(HELP);
    } else {
      install(options);
    }
  } catch (error) {
    console.error(`install failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { install, parseOptions, recognizedInstall, resolveWsRoot };
