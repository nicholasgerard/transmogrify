'use strict';

// Environment for every Git subprocess this installation runs. System, global,
// and hook configuration are disabled so repository reads and mutations behave
// identically regardless of the operator's ambient setup. It must never forward
// a caller's GIT_*, credential, or proxy variables into a managed seat.

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
