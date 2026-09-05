'use strict';

// Environment for every Git subprocess this installation runs. System, global,
// and hook configuration are disabled so repository reads and mutations behave
// identically regardless of the operator's ambient setup. It must never forward
// a caller's GIT_*, credential, or proxy variables into a managed seat.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let hooksDirectory;
let hooksIdentity;

// Use a host-created empty directory instead of a path from repository config.
// Recheck it before use so a replaced or populated path is never trusted.
function emptyHooksDirectory() {
  if (!hooksDirectory) {
    hooksDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transmogrify-empty-hooks-')));
    hooksIdentity = fs.lstatSync(hooksDirectory);
    process.once('exit', () => {
      try {
        const current = fs.lstatSync(hooksDirectory);
        if (current.dev === hooksIdentity.dev && current.ino === hooksIdentity.ino) fs.rmdirSync(hooksDirectory);
      } catch {}
    });
  }
  const current = fs.lstatSync(hooksDirectory);
  if (!current.isDirectory() || current.isSymbolicLink() ||
      current.dev !== hooksIdentity.dev || current.ino !== hooksIdentity.ino ||
      (current.mode & 0o077) !== 0 || fs.readdirSync(hooksDirectory).length !== 0) {
    throw new Error('operator Git hooks directory is no longer private and empty');
  }
  return hooksDirectory;
}

function safeGitConfig() {
  return [
    ['core.hooksPath', emptyHooksDirectory()],
    ['core.fsmonitor', 'false'],
    ['core.sshCommand', ''],
  ];
}

function safeGitConfigArgs() {
  return safeGitConfig().flatMap(([key, value]) => ['-c', `${key}=${value}`]);
}

const GIT_ENV_KEYS = new Set([
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
]);

// Builds that environment from the allowlist. A key outside GIT_ENV_KEYS, a
// non-string value, or an embedded NUL is dropped rather than repaired, and the
// pinned GIT_CONFIG_* overrides are applied last so no caller can preempt them.
function sanitizedGitEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (!GIT_ENV_KEYS.has(key) || typeof value !== 'string' || value.includes('\0')) continue;
    clean[key] = value;
  }
  const config = safeGitConfig();
  return {
    ...clean,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    // Environment overrides also reach verification reads and local upload-pack
    // children, which must not revive repository-level helpers.
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(config.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value],
    ])),
  };
}

module.exports = { sanitizedGitEnv, safeGitConfigArgs };
