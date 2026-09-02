#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { parseArgs } = require('node:util');
const { AppServerClient, validateTimeout, validateUrl } = require('./lib/app-server');
const {
  PINNED_CLI_SHA256,
  PINNED_CLI_VERSION,
  createClaudeSurface,
  parseAgents,
} = require('./lib/claude-surface');
const { check: desktopAttachCheck } = require('./lib/desktop-attach');
const { ensureRegistry, readRegistry } = require('./lib/state');
const { VERSION } = require('./lib/version');

const CODEX_BACKEND = 'codex-app-server';
const CLAUDE_BACKEND = 'claude-code';
const VERIFIED_DATE = '2026-09-01';
const DEFAULT_TIMEOUT_MS = 20_000;
const HELP = `usage: doctor.js --repo-root <absolute-path> [options]

options:
  --target codex|claude|all   providers to inspect (default: all)
  --url <loopback-ws-url>     Codex app-server endpoint
  --claude-bin <absolute>     exact Claude CLI executable
  --timeout <milliseconds>    bounded provider probe timeout`;

function usage(message) {
  const error = new Error(message);
  error.code = 'USAGE_ERROR';
  throw error;
}

function parseDoctorArgs(argv, env = process.env) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    return { help: HELP };
  }
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      'repo-root': { type: 'string' },
      target: { type: 'string' },
      url: { type: 'string' },
      'claude-bin': { type: 'string' },
      timeout: { type: 'string' },
    },
  });
  const repoRoot = parsed.values['repo-root'] || env.REPO_ROOT;
  if (!repoRoot || !path.isAbsolute(repoRoot)) {
    usage('--repo-root or REPO_ROOT must be an absolute path');
  }
  const target = parsed.values.target || 'all';
  if (!['codex', 'claude', 'all'].includes(target)) {
    usage('--target must be codex, claude, or all');
  }
  if (target === 'codex' && parsed.values['claude-bin'] !== undefined) {
    usage('--claude-bin is not valid with --target codex');
  }
  if (target === 'claude' && parsed.values.url !== undefined) {
    usage('--url is not valid with --target claude');
  }
  const timeoutRaw = parsed.values.timeout || String(DEFAULT_TIMEOUT_MS);
  if (!/^[1-9][0-9]*$/.test(timeoutRaw)) {
    usage('--timeout must be a canonical positive integer');
  }
  let timeoutMs;
  try {
    timeoutMs = validateTimeout(Number(timeoutRaw));
  } catch (error) {
    usage(error.message);
  }
  let url;
  if (target !== 'claude') {
    try {
      url = validateUrl(parsed.values.url || env.TRANSMOGRIFY_URL ||
        `ws://127.0.0.1:${env.TRANSMOGRIFY_PORT || '8843'}`);
    } catch (error) {
      usage(error.message);
    }
  }
  const claudeBin = target === 'codex'
    ? undefined
    : parsed.values['claude-bin'] || env.CLAUDE_BIN;
  if (claudeBin && !path.isAbsolute(claudeBin)) {
    usage('--claude-bin or CLAUDE_BIN must be an absolute path');
  }
  return { repoRoot, target, url, claudeBin, timeoutMs };
}

function ownershipSummary(registry) {
  const counts = {
    [CODEX_BACKEND]: { ownedLanes: 0, pendingOperations: 0 },
    [CLAUDE_BACKEND]: { ownedLanes: 0, pendingOperations: 0 },
    other: { ownedLanes: 0, pendingOperations: 0 },
  };
  for (const lane of Object.values(registry.lanes)) {
    const bucket = counts[lane.backend] || counts.other;
    bucket.ownedLanes += 1;
    if (lane.pendingOperationId) bucket.pendingOperations += 1;
  }
  return counts;
}

function publicFailureCode(error) {
  const allowed = new Set([
    'PROTOCOL_ERROR',
    'RUNTIME_MISMATCH',
    'TRANSPORT_ERROR',
    'TRANSPORT_UNKNOWN',
    'UNSUPPORTED_ENVIRONMENT',
    'USAGE_ERROR',
  ]);
  return allowed.has(error?.code) ? error.code : 'PROVIDER_UNAVAILABLE';
}

function notRequested(provider, pinned, probe) {
  return {
    provider,
    requested: false,
    available: null,
    reusable: null,
    reuse: 'not-requested',
    probe,
    pinned,
  };
}

// Read-only Desktop attachment receipt: the app process's established
// loopback connection to the selected runtime. Never launches or quits.
async function inspectDesktopAttachment(options, env, dependencies) {
  const inspect = dependencies.desktopAttachment || desktopAttachCheck;
  try {
    return await inspect({ url: options.url }, env);
  } catch (error) {
    return {
      attachment: {
        state: 'toolUnavailable',
        evidence: error?.code === 'USAGE_ERROR' ? 'invalid-runtime-url' : 'desktop-attachment-check-failed',
      },
      desktop: null,
      nextAction: 'restore-system-tools-or-use-allow-protocol-only',
    };
  }
}

function nativeVisibilityFor(receipt) {
  const attachment = receipt?.attachment || { state: 'unknown' };
  if (attachment.state === 'attached') {
    const buildTested = receipt.desktop?.buildTested === true;
    return {
      verified: true,
      nativeDispatchReady: true,
      evidence: 'codex-desktop-attached-to-selected-runtime',
      receipt: {
        clientPid: attachment.clientPid,
        connection: attachment.connection,
        observedAt: attachment.observedAt,
        bundleId: receipt.desktop?.bundleId ?? null,
        desktopVersion: receipt.desktop?.version ?? null,
        desktopBuild: receipt.desktop?.build ?? null,
        buildTested,
        hostedByDesktop: receipt.desktop?.hostedByDesktop === true,
      },
      nextAction: buildTested
        ? 'none'
        : 'run-disposable-exact-owned-app-visibility-check-on-this-untested-desktop-build',
    };
  }
  return {
    verified: false,
    nativeDispatchReady: false,
    evidence: `desktop-attachment:${attachment.state}`,
    nextAction: receipt?.nextAction || 'run-desktop-attach-ensure',
  };
}

async function probeCodex(options, env, dependencies) {
  let client;
  try {
    client = dependencies.createAppServerClient
      ? dependencies.createAppServerClient(options)
      : new (dependencies.AppServerClient || AppServerClient)({
        url: options.url,
        timeoutMs: options.timeoutMs,
        clientInfo: {
          name: 'transmogrify-doctor',
          title: 'transmogrify doctor',
          version: VERSION,
        },
      });
    const initialized = await client.connect();
    // AppServerClient emits the required `initialized` notification before
    // connect resolves. Yield once so the WebSocket can flush that final
    // handshake frame before this short-lived read-only client closes.
    await new Promise((resolve) => setImmediate(resolve));
    const userAgent = initialized.userAgent.match(
      /^(codex_cli_rs|Codex Desktop)\/(\d+(?:\.\d+){2})/,
    );
    if (!userAgent) {
      const error = new Error('unparseable Codex app-server version');
      error.code = 'RUNTIME_MISMATCH';
      throw error;
    }
    const reusable = client.verifiedRuntime === true;
    const attachment = await inspectDesktopAttachment(options, env, dependencies);
    return {
      provider: 'codex',
      requested: true,
      available: true,
      reusable,
      reuse: reusable ? 'existing-compatible-protocol-runtime' : 'blocked-unverified-runtime',
      probe: 'initialize-handshake-and-desktop-attachment-read',
      nativeVisibility: nativeVisibilityFor(attachment),
      pinned: {
        userAgentVersionLine: '0.151.x',
        verifiedDate: VERIFIED_DATE,
      },
      observed: {
        userAgentFamily: userAgent[1],
        version: userAgent[2],
        pinnedVersionLine: reusable,
      },
    };
  } catch (error) {
    const sandboxDenied = error?.cause?.code === 'EPERM' || error?.code === 'EPERM';
    return {
      provider: 'codex',
      requested: true,
      available: false,
      reusable: false,
      reuse: 'unavailable',
      probe: 'initialize-handshake-only',
      nativeVisibility: {
        verified: false,
        nativeDispatchReady: false,
        evidence: 'provider-unavailable',
        nextAction: 'restore-compatible-protocol-runtime-before-visibility-check',
      },
      pinned: {
        userAgentVersionLine: '0.151.x',
        verifiedDate: VERIFIED_DATE,
      },
      error: {
        code: publicFailureCode(error),
        ...(sandboxDenied ? {
          boundary: 'sandbox-loopback-denied',
          nextAction: 'obtain-scoped-host-authorization-or-use-a-full-lifecycle-native-channel',
        } : {}),
      },
    };
  } finally {
    client?.close?.();
  }
}

async function probeClaude(options, env, dependencies) {
  const surface = dependencies.claudeSurface ||
    (dependencies.createClaudeSurface || createClaudeSurface)();
  try {
    const runtime = surface.preflight({ claudeBin: options.claudeBin }, env);
    const listed = await surface.run(runtime, ['agents', '--json', '--all'], {
      timeoutMs: options.timeoutMs,
    });
    parseAgents(listed.stdout);
    return {
      provider: 'claude',
      requested: true,
      available: true,
      reusable: true,
      reuse: 'installed-cli-session-surface',
      probe: 'public-preflight-and-agent-list-only',
      pinned: {
        cliVersion: PINNED_CLI_VERSION,
        cliSha256: PINNED_CLI_SHA256,
        platform: 'darwin-arm64',
        verifiedDate: VERIFIED_DATE,
      },
      observed: {
        cliVersion: runtime.cliVersion,
        cliSha256: runtime.cliSha256,
        agentListReadable: true,
      },
    };
  } catch (error) {
    return {
      provider: 'claude',
      requested: true,
      available: false,
      reusable: false,
      reuse: 'unavailable',
      probe: 'public-preflight-and-agent-list-only',
      pinned: {
        cliVersion: PINNED_CLI_VERSION,
        cliSha256: PINNED_CLI_SHA256,
        platform: 'darwin-arm64',
        verifiedDate: VERIFIED_DATE,
      },
      error: { code: publicFailureCode(error) },
    };
  }
}

function maintenanceCommands(options, ownership, providers) {
  const commands = [];
  if (options.target !== 'claude' && providers.codex.reusable === true &&
      ownership[CODEX_BACKEND].ownedLanes > 0) {
    commands.push({
      provider: 'codex',
      purpose: 'reconcile exact owned Codex lanes',
      command: `node "$SKILL_ROOT/scripts/lane.js" reconcile --repo-root "$REPO_ROOT" --target codex --url ${JSON.stringify(options.url)}`,
      requiredHostBindings: ['SKILL_ROOT', 'REPO_ROOT'],
    });
  }
  if (options.target !== 'codex' && providers.claude.reusable === true &&
      ownership[CLAUDE_BACKEND].ownedLanes > 0) {
    const explicitClaudeBin = options.claudeBin ? ' --claude-bin "$CLAUDE_BIN"' : '';
    commands.push({
      provider: 'claude',
      purpose: 'reconcile exact owned Claude lanes without private retirement',
      command: `node "$SKILL_ROOT/scripts/lane.js" reconcile --repo-root "$REPO_ROOT" --target claude${explicitClaudeBin}`,
      requiredHostBindings: [
        'SKILL_ROOT',
        'REPO_ROOT',
        ...(options.claudeBin ? ['CLAUDE_BIN'] : []),
      ],
    });
  }
  return commands;
}

async function doctor(options, env = process.env, dependencies = {}) {
  const ensure = dependencies.ensureRegistry || ensureRegistry;
  const read = dependencies.readRegistry || readRegistry;
  ensure(options.repoRoot, env);
  const { registry } = read(options.repoRoot, env);
  const ownership = ownershipSummary(registry);
  const codexPinned = {
    userAgentVersionLine: '0.151.x',
    verifiedDate: VERIFIED_DATE,
  };
  const claudePinned = {
    cliVersion: PINNED_CLI_VERSION,
    cliSha256: PINNED_CLI_SHA256,
    platform: 'darwin-arm64',
    verifiedDate: VERIFIED_DATE,
  };
  const providers = {
    codex: options.target === 'claude'
      ? notRequested('codex', codexPinned, 'initialize-handshake-only')
      : await probeCodex(options, env, dependencies),
    claude: options.target === 'codex'
      ? notRequested('claude', claudePinned, 'public-preflight-and-agent-list-only')
      : await probeClaude(options, env, dependencies),
  };
  const requested = Object.values(providers).filter((provider) => provider.requested);
  return {
    version: 1,
    ok: requested.every((provider) => provider.reusable === true),
    mode: 'read-only-provider-probe',
    providerMutationsAttempted: false,
    registry: {
      state: 'ready',
      outsideRepository: true,
      ownership,
    },
    providers,
    nextSafeMaintenanceCommands: maintenanceCommands(options, ownership, providers),
  };
}

async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const options = parseDoctorArgs(argv, env);
  return options.help ? options : doctor(options, env, dependencies);
}

if (require.main === module) {
  main().then((result) => {
    if (result?.help) {
      console.log(result.help);
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 3;
  }).catch((error) => {
    console.log(JSON.stringify({
      version: 1,
      ok: false,
      mode: 'read-only-provider-probe',
      providerMutationsAttempted: false,
      code: publicFailureCode(error),
    }, null, 2));
    process.exitCode = error?.code === 'USAGE_ERROR' ||
      String(error?.code || '').startsWith('ERR_PARSE_ARGS_') ? 2 : 3;
  });
}

module.exports = {
  CLAUDE_BACKEND,
  CODEX_BACKEND,
  doctor,
  main,
  ownershipSummary,
  parseDoctorArgs,
  publicFailureCode,
};
