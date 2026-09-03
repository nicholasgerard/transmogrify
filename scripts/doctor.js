#!/usr/bin/env node
'use strict';

// Read-only startup diagnostics. It reports the ownership registry, one Codex
// initialize handshake, the Codex Desktop attachment receipt as
// nativeVisibility, and a Claude preflight plus agent listing. It attempts no
// provider mutation, launches and quits nothing, and reports only redacted
// failure codes. It exits 2 on a usage error and 3 when a requested provider is
// not reusable.

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
const VERIFIED_DATE = '2026-09-02';
const DEFAULT_TIMEOUT_MS = 20_000;

// Setup preconditions only the owner can satisfy, keyed by the reason the
// provider probe reports. The text names the exact command; it never carries
// the probe's raw message, account, or paths.
const CLAUDE_SETUP_ACTIONS = new Map([
  ['not-logged-in', 'Run \`claude auth login\`, then rerun the doctor.'],
  ['auth-status-unreadable', 'Run \`claude auth status\`; if it fails, reinstall Claude Code and sign in, then rerun the doctor.'],
  ['account-not-first-party', 'Sign in to Claude Code with a first-party claude.ai account (\`claude auth login\`), then rerun the doctor.'],
  ['cli-unpinned', 'Install the pinned Claude Code CLI with \`claude install 2.1.258\`, then rerun the doctor.'],
  ['cli-not-found', 'Install Claude Code and sign in with \`claude auth login\`, or point CLAUDE_BIN at the pinned binary.'],
  ['cli-not-executable', 'Make the Claude CLI executable, or point CLAUDE_BIN at the pinned binary.'],
  ['unsupported-platform', 'Claude lanes run only on Apple Silicon macOS; use \`--target codex\` on this host.'],
  ['custom-config-dir', 'Unset CLAUDE_CONFIG_DIR for Transmogrify commands; only the default config directory is measured.'],
]);
const CLAUDE_SETUP_FALLBACK = 'Run \`claude --version\` and \`claude auth status\`, fix what they report, then rerun the doctor.';
// Blocking actions stop every lane on that provider; advisory ones only
// withhold native visibility, because a Codex lane can still be spawned
// protocol-only with --allow-protocol-only.
const CODEX_SETUP_ACTIONS = new Map([
  ['runtime-unavailable', { blocking: true, ownerAction: 'Reuse an existing Codex app-server runtime through TRANSMOGRIFY_URL, or authorize this installation to start one with \`runtime-up.sh\`, then rerun the doctor.' }],
  ['sandbox-loopback-denied', { blocking: true, ownerAction: 'Grant the doctor and lane commands loopback access on this host, then rerun the doctor.' }],
  ['desktop-unattached', { blocking: false, ownerAction: 'Allow Transmogrify to relaunch Codex Desktop attached to the runtime (\`desktop-attach.js ensure --relaunch-desktop\`), or set TRANSMOGRIFY_DESKTOP_RELAUNCH=auto; otherwise Codex lanes are protocol-only.' }],
  ['desktop-not-running', { blocking: false, ownerAction: 'Run \`desktop-attach.js ensure\` to launch Codex Desktop attached to the runtime; otherwise Codex lanes are protocol-only.' }],
  ['desktop-not-installed', { blocking: false, ownerAction: 'Install Codex Desktop, or use \`--allow-protocol-only\` for lanes that need no native visibility.' }],
  ['desktop-attached-elsewhere', { blocking: false, ownerAction: 'Point TRANSMOGRIFY_URL at the runtime Codex Desktop is already attached to (see nativeVisibility.nextAction).' }],
  ['desktop-unsupported-platform', { blocking: false, ownerAction: 'Codex Desktop attachment is macOS-only; Codex lanes on this host need \`--allow-protocol-only\`.' }],
  ['desktop-attach-disabled', { blocking: false, ownerAction: 'Unset TRANSMOGRIFY_DESKTOP_ATTACH=off for live-visible Codex lanes; otherwise use \`--allow-protocol-only\`.' }],
  ['desktop-tool-unavailable', { blocking: false, ownerAction: 'Restore lsof, ps, and osascript on this host so the attachment can be measured; until then use \`--allow-protocol-only\`.' }],
]);

function claudeSetup(error) {
  const reason = typeof error?.details?.reason === 'string' ? error.details.reason : 'unavailable';
  return { reason, blocking: true, ownerAction: CLAUDE_SETUP_ACTIONS.get(reason) || CLAUDE_SETUP_FALLBACK };
}
function codexSetup(reason) {
  const entry = CODEX_SETUP_ACTIONS.get(reason);
  return entry ? { reason, blocking: entry.blocking, ownerAction: entry.ownerAction } : null;
}
function attachmentSetupReason(attachment) {
  return new Map([
    ['unattached', 'desktop-unattached'],
    ['notRunning', 'desktop-not-running'],
    ['notInstalled', 'desktop-not-installed'],
    ['attachedElsewhere', 'desktop-attached-elsewhere'],
    ['unsupportedPlatform', 'desktop-unsupported-platform'],
    ['disabled', 'desktop-attach-disabled'],
    ['toolUnavailable', 'desktop-tool-unavailable'],
  ]).get(attachment?.state) || null;
}
function setupSummary(providers) {
  const ownerActions = [];
  for (const provider of ['codex', 'claude']) {
    const setup = providers[provider]?.setup;
    if (setup) {
      ownerActions.push({
        provider, reason: setup.reason, blocking: setup.blocking === true, ownerAction: setup.ownerAction,
      });
    }
  }
  return { ready: !ownerActions.some((action) => action.blocking), ownerActions };
}
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

// Strict option parsing with per-target grammar: --url is Codex-only and
// --claude-bin is Claude-only, so a flag is never silently ignored. Every
// failure is USAGE_ERROR.
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

// Lane and pending-operation counts per backend. Counts only; no lane id,
// provider id, or seat path reaches the report.
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

// Only a small allowlist of codes is reported; everything else collapses to
// PROVIDER_UNAVAILABLE so no internal detail is published.
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

// The placeholder entry for a provider this run did not target. It reports null
// availability rather than implying a passing probe.
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

// Turn the attachment receipt into the doctor's nativeVisibility block. Verified
// only when Desktop holds a live connection to the selected runtime; an
// attached but untested Desktop build is still verified, with a next action to
// run a disposable app-visibility check.
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

// One initialize handshake plus the Desktop attachment read, then close.
// Reusable means the runtime is inside the pinned version line; a runtime
// outside it is reported honestly rather than used. No lifecycle method is sent.
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
    const attachmentSetup = attachment?.attachment?.state === 'attached'
      ? null : codexSetup(attachmentSetupReason(attachment?.attachment));
    return {
      provider: 'codex',
      requested: true,
      available: true,
      reusable,
      reuse: reusable ? 'existing-compatible-protocol-runtime' : 'blocked-unverified-runtime',
      probe: 'initialize-handshake-and-desktop-attachment-read',
      nativeVisibility: nativeVisibilityFor(attachment),
      ...(attachmentSetup ? { setup: attachmentSetup } : {}),
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
      setup: codexSetup(sandboxDenied ? 'sandbox-loopback-denied' : 'runtime-unavailable'),
    };
  } finally {
    client?.close?.();
  }
}

// Claude preflight plus one agent listing. It proves the pinned CLI build,
// first-party auth, and a parseable listing without touching any session.
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
      setup: claudeSetup(error),
    };
  }
}

// The next safe commands to suggest: reconciliation only, and only for a
// provider that is reusable and actually owns lanes. Host bindings are named
// rather than expanded, so no local path is printed.
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

// Run the requested probes and assemble the report. ok is true only when every
// requested provider is reusable; providerMutationsAttempted is always false.
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
    setup: setupSummary(providers),
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
