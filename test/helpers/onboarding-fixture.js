'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { doctor } = require('../../scripts/doctor');
const { PINNED_CLI_SHA256, PINNED_CLI_VERSION } = require('../../scripts/lib/claude-surface');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function host(app = 'shell', surface = 'terminal', supported = true, tools = {}) {
  return {
    app,
    surface,
    tools: { claudeCode: false, codex: false, ...tools },
    platform: {
      os: supported ? 'darwin' : 'linux',
      arch: supported ? 'arm64' : 'x64',
      claudeLanesSupported: supported,
    },
  };
}

function codexBinary(t, { version = '0.155.0', source = 'PATH', signedIn = true } = {}) {
  const directory = fs.mkdtempSync('/tmp/transmogrify-onboarding-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binaryPath = path.join(directory, 'codex');
  fs.writeFileSync(binaryPath, '#!/bin/sh\n', { mode: 0o700 });
  return { path: fs.realpathSync(binaryPath), version, source, signedIn };
}

function claudeSurface(reason, measurement = {}) {
  return {
    preflight() {
      if (reason) {
        const error = new Error('private Claude provider detail');
        error.code = 'UNSUPPORTED_ENVIRONMENT';
        error.details = { reason };
        throw error;
      }
      return {
        cliVersion: measurement.cliVersion || PINNED_CLI_VERSION,
        cliSha256: PINNED_CLI_SHA256,
        cliMeasurement: {
          result: 'good', source: 'live-probe', measuredAt: '2026-09-05T12:00:00.000Z',
          probes: [{ name: 'private-probe', ok: true }], private: 'hidden',
        },
      };
    },
    async run() { return { stdout: '[]', stderr: '' }; },
  };
}

async function attachment(state = 'attached', persisted = true, options = {}) {
  const { check } = require('../../scripts/lib/desktop-attach');
  const { scenario } = require('./desktop-attachment-fixture');
  const fake = scenario({
    attached: state === 'attached', running: state !== 'notRunning',
    installed: state !== 'notInstalled', ...options,
    runtimePort: 8844,
    relayRecord: { url: 'ws://127.0.0.1:8844/', socketPath: '/tmp/fixture-daemon.sock' },
    persistedUrl: persisted ? 'ws://127.0.0.1:8844/' : '', plistExists: persisted,
    elsewherePort: state === 'attachedElsewhere' ? 9999 : null,
  });
  if (state === 'unsupportedPlatform') fake.dependencies.platform = 'linux';
  if (state === 'toolUnavailable') fake.dependencies.execFileResult = async () => ({ code: null, failure: 'missing' });
  return check({}, state === 'disabled' ? { TRANSMOGRIFY_DESKTOP_ATTACH: 'off' } : {}, fake.dependencies);
}

async function doctorReport(t, scenario = {}) {
  const currentHost = scenario.host || host();
  const binaries = scenario.codexBinaries || [];
  const runtimeState = scenario.codexRuntime || 'reusable';
  const dependencies = {
    ensureRegistry() {},
    readRegistry: () => ({ registry: { lanes: {} } }),
    detectHostContext: () => currentHost,
    codexCliCandidates: binaries.map((binary) => ({ path: binary.path, source: binary.source })),
    execFileSync(executable, args) {
      const binary = binaries.find((entry) => fs.realpathSync(entry.path) === executable);
      if (!binary) throw new Error('unexpected Codex executable');
      if (args[0] === '--version') return `codex-cli ${binary.version}\n`;
      if (args.join(' ') === 'login status') {
        if (binary.signedIn === true) return 'Logged in\n';
        const error = new Error('status unavailable');
        if (binary.signedIn === false) error.stderr = 'Not logged in\n';
        throw error;
      }
      throw new Error(`unexpected Codex arguments: ${args.join(' ')}`);
    },
    createAppServerClient() {
      return {
        verifiedRuntime: runtimeState !== 'unsupported',
        async connect() {
          if (runtimeState === 'unavailable') throw new Error('runtime absent');
          if (runtimeState === 'sandbox-denied') {
            const error = new Error('sandbox denied');
            error.code = 'EPERM';
            throw error;
          }
          return { userAgent: runtimeState === 'unsupported' ? 'codex_cli_rs/0.148.0' : `codex_cli_rs/${scenario.codexVersion || '0.155.0'}` };
        },
        close() {},
      };
    },
    measureCodexCompatibility: async () => runtimeState === 'unsupported'
      ? { result: 'failed', failingMethod: 'minimum-version', private: 'hidden' }
      : { result: 'good', private: 'hidden' },
    desktopAttachment: scenario.desktopAttachment || (async () => attachment(scenario.desktopState, scenario.persisted ?? true, scenario.desktopOptions)),
    claudeSurface: claudeSurface(scenario.claudeReason, scenario.claudeMeasurement),
  };
  return doctor({
    repoRoot: REPO_ROOT,
    target: scenario.target || 'all',
    url: 'ws://127.0.0.1:8843',
    claudeBin: undefined,
    timeoutMs: 1000,
    explain: true,
    json: false,
  }, {}, dependencies);
}

module.exports = { REPO_ROOT, codexBinary, doctorReport, host };
