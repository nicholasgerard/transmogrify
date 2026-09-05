#!/usr/bin/env node
'use strict';

// Read-only startup diagnostics. It reports the ownership registry, one Codex
// initialize handshake, cached method compatibility, discovered Codex CLI
// versions, the Codex Desktop attachment receipt as
// nativeVisibility, and a Claude preflight plus agent listing. It attempts no
// provider mutation, launches and quits nothing, and reports only redacted
// failure codes. It exits 2 on a usage error and 3 when a requested provider is
// not reusable.

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { AppServerClient, validateTimeout } = require('./lib/app-server');
const {
  MINIMUM_CLI_VERSION,
  PINNED_CLI_SHA256,
  PINNED_CLI_VERSION,
  createClaudeSurface,
  parseAgents,
} = require('./lib/claude-surface');
const { measureCodexCompatibility, supportedRuntimeVersion } = require('./lib/codex-compat');
const {
  check: desktopAttachCheck,
  resolveRuntimeUrl: resolveDesktopRuntimeUrl,
} = require('./lib/desktop-attach');
const { detectHostContext } = require('./lib/host-context');
const { computeSetupPlan, setupReadiness } = require('./lib/setup-plan');
const { ensureRegistry, readRegistry } = require('./lib/state');
const { VERSION } = require('./lib/version');
const { EXIT, isUsageCode, publicErrorMessage } = require('./lib/public-error');

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
  ['cli-unsupported', 'Upgrade Claude Code through its own installer with \`claude install\`, then rerun the doctor.'],
  ['cli-not-found', 'Install Claude Code and sign in with \`claude auth login\`, or point CLAUDE_BIN at the installed binary.'],
  ['cli-not-executable', 'Make the Claude CLI executable, or point CLAUDE_BIN at an executable installation.'],
  ['unsupported-platform', 'Claude lanes run only on Apple Silicon macOS; use \`--target codex\` on this host.'],
  ['custom-config-dir', 'Unset CLAUDE_CONFIG_DIR for Transmogrify commands; only the default config directory is measured.'],
]);
const CLAUDE_SETUP_FALLBACK = 'Run \`claude --version\` and \`claude auth status\`, fix what they report, then rerun the doctor.';
// Blocking actions stop every lane on that provider; advisory ones only
// withhold native visibility, because a Codex lane can still be spawned
// protocol-only with --allow-protocol-only.
const CODEX_SETUP_ACTIONS = new Map([
  ['cli-not-found', { blocking: true, ownerAction: 'Install a supported Codex command-line tool, then rerun the doctor.' }],
  ['codex-not-logged-in', { blocking: true, ownerAction: 'Sign in to Codex, then rerun the doctor.' }],
  ['runtime-unavailable', { blocking: true, ownerAction: 'Reuse an existing Codex app-server runtime through TRANSMOGRIFY_URL, or authorize this installation to start one with \`runtime-up.sh\`, then rerun the doctor.' }],
  ['sandbox-loopback-denied', { blocking: true, ownerAction: 'Grant the doctor and lane commands loopback access on this host, then rerun the doctor.' }],
  ['desktop-unattached', { blocking: false, ownerAction: 'Allow Transmogrify to relaunch Codex Desktop attached to the runtime (\`desktop-attach.js ensure --relaunch-desktop\`), or set TRANSMOGRIFY_DESKTOP_RELAUNCH=auto. Attachment makes Codex lanes appear and stream live in Desktop; declining leaves them protocol-only and not live-visible there.' }],
  ['desktop-not-running', { blocking: false, ownerAction: 'Run \`desktop-attach.js ensure\` to launch Codex Desktop attached to the runtime. Attachment makes Codex lanes appear and stream live in Desktop; declining leaves them protocol-only and not live-visible there.' }],
  ['desktop-not-installed', { blocking: false, ownerAction: 'Install Codex Desktop if Codex lanes should appear and stream live there. Declining means using \`--allow-protocol-only\`; those lanes will not be live-visible in Desktop.' }],
  ['desktop-attached-elsewhere', { blocking: false, ownerAction: 'Point TRANSMOGRIFY_URL at the runtime Codex Desktop already uses (see nativeVisibility.nextAction) so lanes appear and stream live there. Declining leaves lanes on the selected runtime protocol-only and not live-visible in Desktop.' }],
  ['desktop-unsupported-platform', { blocking: false, ownerAction: 'Codex Desktop attachment is macOS-only. Attachment would make lanes appear and stream live in Desktop; on this host use \`--allow-protocol-only\`, where they will not be live-visible there.' }],
  ['desktop-attach-disabled', { blocking: false, ownerAction: 'Unset TRANSMOGRIFY_DESKTOP_ATTACH=off if Codex lanes should appear and stream live in Desktop. Leaving it disabled requires \`--allow-protocol-only\`, and those lanes will not be live-visible there.' }],
  ['desktop-tool-unavailable', { blocking: false, ownerAction: 'Restore lsof, ps, and osascript so attachment can be measured and Codex lanes can be proved live-visible in Desktop. Until then use \`--allow-protocol-only\`; those lanes will not be live-visible there.' }],
]);

function claudeSetup(error) {
  const reason = typeof error?.details?.reason === 'string' ? error.details.reason : 'unavailable';
  if (reason === 'cli-unmeasured-failed') {
    const probe = typeof error?.details?.probe === 'string' ? error.details.probe : 'unknown';
    return {
      reason,
      blocking: true,
      ownerAction: `Claude Code failed the ${probe} compatibility probe. Upgrade it with \`claude install\`, then rerun the doctor.`,
      failingProbe: probe,
    };
  }
  return { reason, blocking: true, ownerAction: CLAUDE_SETUP_ACTIONS.get(reason) || CLAUDE_SETUP_FALLBACK };
}
function codexSetup(reason, details = {}) {
  if (reason === 'runtime-unsupported') {
    return {
      reason,
      blocking: true,
      ownerAction: `Use a Codex app-server that supports ${details.failingMethod || 'the required lifecycle methods'}, then rerun the doctor.`,
      failingMethod: details.failingMethod || 'unknown',
    };
  }
  const entry = CODEX_SETUP_ACTIONS.get(reason);
  return entry ? { reason, blocking: entry.blocking, ownerAction: entry.ownerAction } : null;
}

function parseCodexCliVersion(raw) {
  const match = String(raw).match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/);
  return match ? match[1] : null;
}

// Inventory each distinct executable from the three discovery surfaces.
// Discovery never starts an app-server; unavailable runtimes add one
// read-only login-status call against the selected supported executable.
function codexCliBinaries(env = process.env, dependencies = {}) {
  const candidates = dependencies.codexCliCandidates || (() => {
    const discovered = [];
    for (const directory of String(env.PATH || '').split(path.delimiter)) {
      if (directory && path.isAbsolute(directory)) discovered.push({ path: path.join(directory, 'codex'), source: 'PATH' });
    }
    discovered.push({
      path: '/Applications/ChatGPT.app/Contents/Resources/codex',
      source: 'codex-desktop',
    });
    if (env.TRANSMOGRIFY_BIN && path.isAbsolute(env.TRANSMOGRIFY_BIN)) {
      discovered.push({ path: env.TRANSMOGRIFY_BIN, source: 'TRANSMOGRIFY_BIN' });
    }
    return discovered;
  })();
  const binaries = new Map();
  for (const candidate of candidates) {
    let resolved;
    try {
      resolved = fs.realpathSync(candidate.path);
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
    } catch {
      continue;
    }
    const existing = binaries.get(resolved);
    if (existing) {
      if (!existing.sources.includes(candidate.source)) existing.sources.push(candidate.source);
      continue;
    }
    let version = null;
    try {
      const run = dependencies.execFileSync || execFileSync;
      version = parseCodexCliVersion(run(resolved, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: env.PATH || '/usr/bin:/bin' },
        maxBuffer: 4096,
        timeout: 5000,
      }));
    } catch {}
    binaries.set(resolved, {
      path: resolved,
      sources: [candidate.source],
      version,
      supported: version === null ? null : supportedRuntimeVersion(version),
    });
  }
  return [...binaries.values()];
}

function codexLoginStatus(cliBinaries, env = process.env, dependencies = {}) {
  const binary = cliBinaries.find((candidate) => candidate.supported === true);
  if (!binary) return { binary: null, signedIn: null };
  const run = dependencies.execFileSync || execFileSync;
  try {
    const output = run(binary.path, ['login', 'status'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: env.PATH || '/usr/bin:/bin' },
      maxBuffer: 4096,
      timeout: 5000,
    });
    return { binary: binary.path, signedIn: !/\b(?:not logged in|signed out)\b/i.test(String(output)) };
  } catch (error) {
    const output = `${String(error?.stdout || '')}\n${String(error?.stderr || '')}`;
    return {
      binary: binary.path,
      signedIn: /\b(?:not logged in|signed out)\b/i.test(output) ? false : null,
    };
  }
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
function setupSummary(providers, hostContext) {
  const ownerActions = [];
  for (const provider of ['codex', 'claude']) {
    const setup = providers[provider]?.setup;
    if (setup) {
      ownerActions.push({
        provider, reason: setup.reason, blocking: setup.blocking === true, ownerAction: setup.ownerAction,
      });
    }
  }
  return { ...setupReadiness(providers, hostContext), ownerActions };
}
const HELP = `usage: doctor.js --repo-root <absolute-path> [options]

options:
  --target codex|claude|all   providers to inspect (default: all)
  --url <loopback-ws-url>     Codex app-server endpoint
  --claude-bin <absolute>     exact Claude CLI executable
  --timeout-ms <milliseconds> bounded provider probe timeout
  --explain                    add an ordered plain-language setup plan
  --json                       print JSON even when --explain runs on a terminal`;

function usage(message) {
  const error = new Error(message);
  error.code = 'USAGE_ERROR';
  throw error;
}

// Strict option parsing with per-target grammar: --url is Codex-only and
// --claude-bin is Claude-only, so a flag is never silently ignored. Every
// failure is USAGE_ERROR.
function parseDoctorArgs(argv, env = process.env, dependencies = {}) {
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
      'timeout-ms': { type: 'string' },
      explain: { type: 'boolean' },
      json: { type: 'boolean' },
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
  const timeoutRaw = parsed.values['timeout-ms'] || String(DEFAULT_TIMEOUT_MS);
  if (!/^[1-9][0-9]*$/.test(timeoutRaw)) {
    usage('--timeout-ms must be a canonical positive integer');
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
      url = resolveDesktopRuntimeUrl({ url: parsed.values.url }, env, dependencies);
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
  return {
    repoRoot, target, url, claudeBin, timeoutMs,
    explain: parsed.values.explain === true,
    json: parsed.values.json === true,
  };
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
    return await inspect({ url: options.url }, env,
      dependencies.desktopAttachmentDependencies || dependencies);
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
      persisted: receipt?.persisted === true,
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
    persisted: receipt?.persisted === true,
    evidence: `desktop-attachment:${attachment.state}`,
    nextAction: receipt?.nextAction || 'run-desktop-attach-ensure',
  };
}

function claudeBuildMeasurement(measurement) {
  if (!measurement || typeof measurement !== 'object') return null;
  return {
    result: measurement.result,
    source: measurement.source,
    measuredAt: measurement.measuredAt,
  };
}

function unavailableRuntime(cliBinaries, env, dependencies) {
  const login = codexLoginStatus(cliBinaries, env, dependencies);
  return {
    state: 'unavailable',
    supportedBinaryAvailable: login.binary !== null,
    accountSignedIn: login.signedIn,
    ...(login.binary ? { binary: login.binary } : {}),
  };
}

function unavailableCodexSetup(runtime) {
  if (!runtime.supportedBinaryAvailable) return codexSetup('cli-not-found');
  if (runtime.accountSignedIn === false) return codexSetup('codex-not-logged-in');
  return codexSetup('runtime-unavailable');
}

// One initialize handshake plus the Desktop attachment read, then close.
// Reusable means the runtime is at the minimum version and passed the cached
// method probe. Mutation-shaped probes address only the nil thread id.
async function probeCodex(options, env, dependencies) {
  let client;
  const cliBinaries = codexCliBinaries(env, dependencies);
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
    // The canonical user agent is "<product>/<version>"; the product is
    // codex_cli_rs, Codex Desktop, or, for the managed daemon, the name of
    // whichever client connected first. Only the version decides support.
    const userAgent = initialized.userAgent.match(/^(.+)\/(\d+(?:\.\d+){2})$/);
    if (!userAgent) {
      const error = new Error('unparseable Codex app-server version');
      error.code = 'RUNTIME_MISMATCH';
      throw error;
    }
    const compatibility = await (dependencies.measureCodexCompatibility || measureCodexCompatibility)(
      client,
      userAgent[2],
      { env, timeoutMs: options.timeoutMs },
    );
    const reusable = client.verifiedRuntime === true && compatibility.result === 'good';
    const attachment = await inspectDesktopAttachment(options, env, dependencies);
    const compatibilitySetup = reusable ? null : codexSetup('runtime-unsupported', {
      failingMethod: compatibility.failingMethod || 'minimum-version',
    });
    const attachmentSetup = compatibilitySetup || (attachment?.attachment?.state === 'attached'
      ? null : codexSetup(attachmentSetupReason(attachment?.attachment)));
    return {
      provider: 'codex',
      requested: true,
      available: true,
      reusable,
      reuse: reusable ? 'existing-compatible-protocol-runtime' : 'blocked-unverified-runtime',
      probe: 'initialize-handshake-method-compatibility-and-desktop-attachment-read',
      cliBinaries,
      runtime: reusable
        ? { state: 'reusable' }
        : { state: 'unsupported', failingMethod: compatibility.failingMethod || 'minimum-version' },
      nativeVisibility: nativeVisibilityFor(attachment),
      ...(attachmentSetup ? { setup: attachmentSetup } : {}),
      pinned: {
        userAgentVersionLine: '>=0.151.0',
        verifiedDate: VERIFIED_DATE,
      },
      observed: {
        userAgentFamily: userAgent[1],
        version: userAgent[2],
        pinnedVersionLine: client.verifiedRuntime === true,
        compatibility: compatibility.result,
        ...(compatibility.failingMethod ? { failingMethod: compatibility.failingMethod } : {}),
      },
    };
  } catch (error) {
    const sandboxDenied = error?.cause?.code === 'EPERM' || error?.code === 'EPERM';
    const runtime = sandboxDenied
      ? { state: 'sandbox-denied' }
      : unavailableRuntime(cliBinaries, env, dependencies);
    return {
      provider: 'codex',
      requested: true,
      available: false,
      reusable: false,
      reuse: 'unavailable',
      probe: 'initialize-handshake-only',
      cliBinaries,
      runtime,
      nativeVisibility: {
        verified: false,
        nativeDispatchReady: false,
        persisted: false,
        evidence: 'provider-unavailable',
        nextAction: 'restore-compatible-protocol-runtime-before-visibility-check',
      },
      pinned: {
        userAgentVersionLine: '>=0.151.0',
        verifiedDate: VERIFIED_DATE,
      },
      error: {
        code: publicFailureCode(error),
        ...(sandboxDenied ? {
          boundary: 'sandbox-loopback-denied',
          nextAction: 'obtain-scoped-host-authorization-or-use-a-full-lifecycle-native-channel',
        } : {}),
      },
      setup: sandboxDenied ? codexSetup('sandbox-loopback-denied') : unavailableCodexSetup(runtime),
    };
  } finally {
    client?.close?.();
  }
}

// Claude preflight plus one agent listing. It proves the supported CLI build,
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
      probe: 'public-build-measurement-and-agent-list-only',
      pinned: {
        minimumCliVersion: MINIMUM_CLI_VERSION,
        cliVersion: PINNED_CLI_VERSION,
        cliSha256: PINNED_CLI_SHA256,
        platform: 'darwin-arm64',
        verifiedDate: VERIFIED_DATE,
      },
      observed: {
        cliVersion: runtime.cliVersion,
        cliSha256: runtime.cliSha256,
        buildMeasurement: claudeBuildMeasurement(runtime.cliMeasurement),
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
      probe: 'public-build-measurement-and-agent-list-only',
      pinned: {
        minimumCliVersion: MINIMUM_CLI_VERSION,
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

// Run the requested probes and assemble the report. Unsupported providers do
// not make a supported ready provider fail; providerMutationsAttempted is
// always false.
async function doctor(options, env = process.env, dependencies = {}) {
  const ensure = dependencies.ensureRegistry || ensureRegistry;
  const read = dependencies.readRegistry || readRegistry;
  ensure(options.repoRoot, env);
  const { registry } = read(options.repoRoot, env);
  const ownership = ownershipSummary(registry);
  const codexPinned = {
    userAgentVersionLine: '>=0.151.0',
    verifiedDate: VERIFIED_DATE,
  };
  const claudePinned = {
    minimumCliVersion: MINIMUM_CLI_VERSION,
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
      ? notRequested('claude', claudePinned, 'public-build-measurement-and-agent-list-only')
      : await probeClaude(options, env, dependencies),
  };
  const inspectHost = dependencies.detectHostContext || detectHostContext;
  const hostContext = inspectHost(env, dependencies.hostContextDependencies || dependencies);
  const setup = setupSummary(providers, hostContext);
  if (options.explain) {
    setup.plan = computeSetupPlan({ providers, setup }, hostContext);
  }
  return {
    version: 1,
    ok: setup.ready,
    mode: 'read-only-provider-probe',
    providerMutationsAttempted: false,
    registry: {
      state: 'ready',
      outsideRepository: true,
      ownership,
    },
    providers,
    setup,
    nextSafeMaintenanceCommands: maintenanceCommands(options, ownership, providers),
  };
}

function renderSetupSummary(result) {
  const plan = result?.setup?.plan;
  if (!plan) return '';
  const found = Object.entries(result.providers || {})
    .filter(([, provider]) => provider.requested && provider.available)
    .map(([provider]) => provider === 'codex' ? 'a Codex runtime' : 'Claude Code');
  const ready = Object.entries(result.providers || {})
    .filter(([, provider]) => provider.requested && provider.reusable)
    .map(([provider]) => provider === 'codex' ? 'the Codex runtime' : 'Claude Code');
  const readyText = ready.length > 0 ? `${ready.join(' and ')} ${ready.length === 1 ? 'is' : 'are'} ready.` : 'No lane host is ready yet.';
  const unsupported = Object.entries(result.setup?.providers || {})
    .filter(([, status]) => status === 'unsupported')
    .map(([provider]) => provider === 'claude' ? 'Claude lanes' : 'Codex lanes');
  const supportedCount = Object.values(result.setup?.providers || {})
    .filter((status) => !['unsupported', 'not-requested'].includes(status)).length;
  const neededText = plan.steps.length === 0
    ? (unsupported.length > 0
      ? `${unsupported.join(' and ')} are unavailable on this machine; ${supportedCount > 0 ? 'no setup changes are needed for the supported provider.' : 'no requested provider can run here.'}`
      : 'No setup changes are needed.')
    : plan.steps.map((entry) => entry.what).join(' ');
  const nextAction = plan.steps[0]?.what || 'You can start lanes now.';
  const nextText = plan.context ? `${plan.context} ${nextAction}` : nextAction;
  return [
    `Found: ${found.length > 0 ? `${found.join(' and ')}.` : 'No lane host was found.'}`,
    `Ready: ${readyText}`,
    `Needed: ${neededText}`,
    `Next: ${nextText}`,
  ].join('\n');
}

function renderDoctorOutput(result, options, isTTY = process.stdout.isTTY === true) {
  if (isTTY && options.explain && !options.json) return renderSetupSummary(result);
  return JSON.stringify(result, null, 2);
}

async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const options = parseDoctorArgs(argv, env, dependencies);
  return options.help ? options : doctor(options, env, dependencies);
}

if (require.main === module) {
  main().then((result) => {
    if (result?.help) {
      console.log(result.help);
      return;
    }
    console.log(renderDoctorOutput(result, {
      explain: process.argv.includes('--explain'),
      json: process.argv.includes('--json'),
    }));
    if (!result.ok) process.exitCode = 3;
  }).catch((error) => {
    const code = publicFailureCode(error);
    console.log(JSON.stringify({
      version: 1,
      ok: false,
      mode: 'read-only-provider-probe',
      providerMutationsAttempted: false,
      code,
      message: publicErrorMessage(code),
    }, null, 2));
    process.exitCode = isUsageCode(error?.code) ? EXIT.refused : EXIT.failed;
  });
}

module.exports = {
  CLAUDE_BACKEND,
  CODEX_BACKEND,
  codexCliBinaries,
  codexLoginStatus,
  doctor,
  main,
  ownershipSummary,
  parseDoctorArgs,
  publicFailureCode,
  renderSetupSummary,
  renderDoctorOutput,
};
