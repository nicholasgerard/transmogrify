'use strict';

const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const {
  VERIFIED_CLI_BUILDS,
  canonicalCseId,
} = require('./claude-surface');

const API_ORIGIN = 'https://api.anthropic.com';
const DESKTOP_BUILD = '1.40609.1';
const DESKTOP_BUNDLE_ID = 'com.anthropic.claudefordesktop';
const DESKTOP_APP_ASAR = '/Applications/Claude.app/Contents/Resources/app.asar';
const DESKTOP_APP_ASAR_SHA256 = '0fcf5499f5eee77bb769362a3603a4278b5ba9a8ae2620395146afc60c13861f';
const DESKTOP_BUNDLE_VERSION = '1.40609.1';
const DESKTOP_INFO_PLIST = '/Applications/Claude.app/Contents/Info.plist';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const MAX_PRIVATE_RESPONSE_BYTES = 64 * 1024;
const READABLE_SESSION_STATUSES = new Set(['active', 'connected', 'disconnected', 'archived']);
const VERIFIED_PRIVATE_CLI_VERSIONS = new Set(['2.1.257', '2.1.258']);
const CCR_HEADERS = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'ccr-byoc-2025-07-29',
  'anthropic-client-feature': 'ccr',
};

class ClaudePrivateApiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ClaudePrivateApiError';
    this.code = code;
    this.details = details;
  }
}

function parseCredential(raw) {
  let credential;
  try { credential = JSON.parse(raw); } catch {
    throw new ClaudePrivateApiError('PRIVATE_AUTH_UNAVAILABLE', 'Claude Keychain credential is not valid JSON');
  }
  const token = credential?.claudeAiOauth?.accessToken;
  if (typeof token !== 'string' || token.length < 20) {
    throw new ClaudePrivateApiError('PRIVATE_AUTH_UNAVAILABLE', 'Claude Keychain credential has no OAuth access token');
  }
  return token;
}

function sha256File(file) {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertPinnedDesktopFile(file, expectedSha256, dependencies) {
  let before;
  try { before = dependencies.lstatSync(file); } catch {
    throw new ClaudePrivateApiError('UNVERIFIED_PRIVATE_VERSION', 'cannot inspect the pinned Claude Desktop bundle');
  }
  if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o022) !== 0 ||
      dependencies.sha256File(file) !== expectedSha256) {
    throw new ClaudePrivateApiError('UNVERIFIED_PRIVATE_VERSION', 'Claude Desktop app.asar is not the pinned bundle');
  }
  let after;
  try { after = dependencies.lstatSync(file); } catch {
    throw new ClaudePrivateApiError('UNVERIFIED_PRIVATE_VERSION', 'Claude Desktop bundle changed while hashing');
  }
  for (const key of ['dev', 'ino', 'size', 'mtimeMs']) {
    if (before[key] !== undefined && after[key] !== before[key]) {
      throw new ClaudePrivateApiError('UNVERIFIED_PRIVATE_VERSION', 'Claude Desktop bundle changed while hashing');
    }
  }
}

async function boundedJson(response, label) {
  let raw;
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        bytes += chunk.length;
        if (bytes > MAX_PRIVATE_RESPONSE_BYTES) {
          try { await reader.cancel(); } catch {}
          throw new ClaudePrivateApiError(
            'REMOTE_ARCHIVE_UNCERTAIN',
            `${label} exceeded its response bound`,
          );
        }
        chunks.push(chunk);
      }
      raw = Buffer.concat(chunks, bytes).toString('utf8');
    } catch (error) {
      if (error instanceof ClaudePrivateApiError) throw error;
      throw new ClaudePrivateApiError('REMOTE_ARCHIVE_UNCERTAIN', `${label} could not be read`);
    }
  } else if (typeof response.text === 'function') {
    try { raw = await response.text(); } catch {
      throw new ClaudePrivateApiError('REMOTE_ARCHIVE_UNCERTAIN', `${label} could not be read`);
    }
    if (Buffer.byteLength(raw) > MAX_PRIVATE_RESPONSE_BYTES) {
      throw new ClaudePrivateApiError('REMOTE_ARCHIVE_UNCERTAIN', `${label} exceeded its response bound`);
    }
  } else {
    throw new ClaudePrivateApiError('REMOTE_ARCHIVE_UNCERTAIN', `${label} could not be read`);
  }
  try { return JSON.parse(raw); } catch {
    throw new ClaudePrivateApiError('REMOTE_ARCHIVE_UNCERTAIN', `${label} returned invalid JSON`);
  }
}

function privateAuthReason(body) {
  for (const value of [
    body?.error?.details?.error_code,
    body?.error?.resource,
    body?.resource,
  ]) {
    if (value === 'untrusted_device' || value === 'session_stale_relogin') return value;
  }
  return null;
}

function createClaudePrivateApi(dependencies = {}) {
  const deps = {
    execFileSync: dependencies.execFileSync || execFileSync,
    fetch: dependencies.fetch || globalThis.fetch,
    lstatSync: dependencies.lstatSync || fs.lstatSync,
    sha256File: dependencies.sha256File || sha256File,
    username: dependencies.username || os.userInfo().username,
  };

  function desktopPlistValue(key) {
    try {
      return deps.execFileSync('/usr/bin/plutil', [
        '-extract', key, 'raw', '-o', '-', DESKTOP_INFO_PLIST,
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 4096,
        timeout: 10_000,
      }).trim();
    } catch {
      throw new ClaudePrivateApiError('UNVERIFIED_PRIVATE_VERSION', 'cannot verify the Claude Desktop bundle');
    }
  }

  function desktopBundle() {
    const build = desktopPlistValue('CFBundleShortVersionString');
    const bundleVersion = desktopPlistValue('CFBundleVersion');
    const bundleId = desktopPlistValue('CFBundleIdentifier');
    assertPinnedDesktopFile(DESKTOP_APP_ASAR, DESKTOP_APP_ASAR_SHA256, deps);
    return { build, bundleId, bundleVersion };
  }

  function accessToken() {
    let raw;
    try {
      raw = deps.execFileSync('/usr/bin/security', [
        'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', deps.username, '-w',
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: MAX_PRIVATE_RESPONSE_BYTES,
        timeout: 10_000,
      });
    } catch {
      throw new ClaudePrivateApiError(
        'PRIVATE_AUTH_UNAVAILABLE',
        'cannot read the exact Claude Code credential from macOS Keychain',
      );
    }
    return parseCredential(raw);
  }

  function preflight(runtime) {
    const desktop = desktopBundle();
    if (runtime.platform !== 'darwin' || runtime.arch !== 'arm64' ||
        !VERIFIED_PRIVATE_CLI_VERSIONS.has(runtime.cliVersion) ||
        VERIFIED_CLI_BUILDS.get(runtime.cliVersion) !== runtime.cliSha256 ||
        desktop.build !== DESKTOP_BUILD || desktop.bundleVersion !== DESKTOP_BUNDLE_VERSION ||
        desktop.bundleId !== DESKTOP_BUNDLE_ID ||
        typeof runtime.orgId !== 'string' || !runtime.orgId) {
      throw new ClaudePrivateApiError(
        'UNVERIFIED_PRIVATE_VERSION',
        'private Claude archival is not verified for this CLI/Desktop/account tuple',
      );
    }
  }

  async function request(path, options, runtime, token) {
    let response;
    try {
      response = await deps.fetch(`${API_ORIGIN}${path}`, {
        method: options.method,
        headers: {
          ...CCR_HEADERS,
          'Content-Type': 'application/json',
          'x-organization-uuid': runtime.orgId,
          'x-environment-runner-version': DESKTOP_BUILD,
          Authorization: `Bearer ${token}`,
        },
        ...(options.method === 'POST' ? { body: '{}' } : {}),
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      throw new ClaudePrivateApiError('REMOTE_ARCHIVE_UNCERTAIN', 'Claude private archive request outcome is unknown');
    }
    return response;
  }

  async function failClosedHttp(response, label) {
    if (response.status === 401) {
      throw new ClaudePrivateApiError('PRIVATE_AUTH_REJECTED', `${label} rejected Claude OAuth authentication`);
    }
    if (response.status === 403) {
      let body = null;
      try { body = await boundedJson(response, label); } catch {}
      const reason = privateAuthReason(body);
      if (reason === 'untrusted_device') {
        throw new ClaudePrivateApiError(
          'PRIVATE_TRUST_REQUIRED',
          `${label} requires trusted-device enrollment; automatic enrollment is disabled`,
        );
      }
      if (reason === 'session_stale_relogin') {
        throw new ClaudePrivateApiError('PRIVATE_AUTH_REJECTED', `${label} requires Claude sign-in again`);
      }
    }
    throw new ClaudePrivateApiError(
      'REMOTE_ARCHIVE_UNCERTAIN',
      `${label} returned HTTP ${response.status}`,
    );
  }

  async function readStatus(cseId, runtime, token, timeoutMs) {
    const response = await request(
      `/v1/code/sessions/${cseId}`,
      { method: 'GET', timeoutMs },
      runtime,
      token,
    );
    if (!response.ok) {
      await failClosedHttp(response, 'Claude private archive status');
    }
    const body = await boundedJson(response, 'Claude private archive status');
    const records = [body?.session, body?.response_shape]
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
    if (records.length === 0) {
      throw new ClaudePrivateApiError(
        'REMOTE_ARCHIVE_UNCERTAIN',
        'Claude private archive status omitted its record id',
      );
    }
    let responseId;
    let status;
    for (const record of records) {
      let canonical;
      try { canonical = canonicalCseId(record.id); } catch {
        throw new ClaudePrivateApiError(
          'REMOTE_ARCHIVE_UNCERTAIN',
          'Claude private archive status omitted its record id',
        );
      }
      if (canonical !== cseId || (responseId !== undefined && responseId !== canonical)) {
        throw new ClaudePrivateApiError('OWNERSHIP_MISMATCH', 'Claude private archive status returned another session');
      }
      if (status !== undefined && status !== record.status) {
        throw new ClaudePrivateApiError('REMOTE_ARCHIVE_UNCERTAIN', 'Claude private archive status records disagree');
      }
      responseId = canonical;
      status = record.status;
    }
    if (typeof status !== 'string' || !READABLE_SESSION_STATUSES.has(status)) {
      throw new ClaudePrivateApiError('REMOTE_ARCHIVE_UNCERTAIN', 'Claude private archive status is unrecognized');
    }
    return status;
  }

  async function ensureArchived(options) {
    const { bridgeId, runtime } = options;
    let cseId;
    try { cseId = canonicalCseId(bridgeId); } catch {
      throw new ClaudePrivateApiError('OWNERSHIP_MISMATCH', 'invalid owned Claude bridge id');
    }
    preflight(runtime);
    const token = accessToken();
    const timeoutMs = options.timeoutMs ?? 10_000;
    const attempts = options.attempts ?? 5;
    const delayMs = options.delayMs ?? 250;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000 ||
        !Number.isInteger(attempts) || attempts < 1 || attempts > 100 ||
        !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
      throw new ClaudePrivateApiError('USAGE_ERROR', 'invalid Claude private archive retry bounds');
    }
    let archiveDispatched = false;
    try {
      if (await readStatus(cseId, runtime, token, timeoutMs) === 'archived') {
        return { archived: true, alreadyArchived: true, desktopBuild: DESKTOP_BUILD };
      }
      archiveDispatched = true;
      const response = await request(
        `/v1/code/sessions/${cseId}/archive`,
        { method: 'POST', timeoutMs },
        runtime,
        token,
      );
      if (!response.ok && response.status !== 409) {
        await failClosedHttp(response, 'Claude private archive');
      }
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (await readStatus(cseId, runtime, token, timeoutMs) === 'archived') {
          return { archived: true, alreadyArchived: false, desktopBuild: DESKTOP_BUILD };
        }
        if (attempt < attempts && delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      throw new ClaudePrivateApiError(
        'REMOTE_ARCHIVE_UNCERTAIN',
        'Claude private archive was not verified after acknowledgment',
      );
    } catch (error) {
      if (!archiveDispatched) throw error;
      throw new ClaudePrivateApiError(
        'REMOTE_ARCHIVE_UNCERTAIN',
        'Claude private archive outcome is unknown after dispatch',
        {
          archiveDispatched: true,
          ...(typeof error?.code === 'string' ? { causeCode: error.code } : {}),
        },
      );
    }
  }

  async function verifyArchived(options) {
    const { bridgeId, runtime } = options;
    let cseId;
    try { cseId = canonicalCseId(bridgeId); } catch {
      throw new ClaudePrivateApiError('OWNERSHIP_MISMATCH', 'invalid owned Claude bridge id');
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    const attempts = options.attempts ?? 5;
    const delayMs = options.delayMs ?? 250;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000 ||
        !Number.isInteger(attempts) || attempts < 1 || attempts > 100 ||
        !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
      throw new ClaudePrivateApiError('USAGE_ERROR', 'invalid Claude private archive retry bounds');
    }
    try {
      preflight(runtime);
      const token = accessToken();
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (await readStatus(cseId, runtime, token, timeoutMs) === 'archived') {
          return { archived: true, alreadyArchived: true, desktopBuild: DESKTOP_BUILD };
        }
        if (attempt < attempts && delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      throw new ClaudePrivateApiError(
        'REMOTE_ARCHIVE_UNCERTAIN',
        'prior Claude private archive dispatch is not yet verified',
      );
    } catch (error) {
      throw new ClaudePrivateApiError(
        'REMOTE_ARCHIVE_UNCERTAIN',
        'prior Claude private archive dispatch remains unresolved',
        {
          archiveDispatched: true,
          ...(typeof error?.code === 'string' ? { causeCode: error.code } : {}),
        },
      );
    }
  }

  return { ensureArchived, preflight, verifyArchived };
}

module.exports = {
  API_ORIGIN,
  CCR_HEADERS,
  ClaudePrivateApiError,
  DESKTOP_APP_ASAR,
  DESKTOP_APP_ASAR_SHA256,
  DESKTOP_BUILD,
  DESKTOP_BUNDLE_ID,
  DESKTOP_BUNDLE_VERSION,
  KEYCHAIN_SERVICE,
  VERIFIED_PRIVATE_CLI_VERSIONS,
  createClaudePrivateApi,
  parseCredential,
};
