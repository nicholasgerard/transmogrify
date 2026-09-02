'use strict';

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

function sanitizedGitEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (!GIT_ENV_KEYS.has(key) || typeof value !== 'string' || value.includes('\0')) continue;
    clean[key] = value;
  }
  return {
    ...clean,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
  };
}

module.exports = { sanitizedGitEnv };
