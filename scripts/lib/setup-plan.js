'use strict';

// Convert the doctor's measured provider records into one ordered,
// user-facing plan. Commands are display data; setup.js dispatches only on
// the typed action and passes the selected Codex binary separately.

const TERMINAL_CONTEXT = 'This is built for the desktop apps; live streaming shows there, everything else works here.';
const IDE_CONTEXT = 'Install both hosts, then open Claude Desktop or the ChatGPT app; Cursor support is not available yet.';
const UNSUPPORTED_CONTEXT = 'Claude lanes require Apple Silicon macOS; Codex lanes still work here in protocol-only mode.';

const ACTIONS = Object.freeze([
  'install-claude',
  'install-codex',
  'sign-in-claude',
  'sign-in-codex',
  'start-runtime',
  'open-app',
  'relaunch-app',
  'persist-attach',
]);

const COMMANDS = Object.freeze({
  installClaude: 'node "$SKILL_ROOT/scripts/setup.js" --repo-root "$REPO_ROOT" --install-claude-cli',
  signInClaude: 'claude auth login',
  installCodex: 'node "$SKILL_ROOT/scripts/setup.js" --repo-root "$REPO_ROOT" --install-codex-cli',
  signInCodex: 'codex login',
  startRuntime: 'node "$SKILL_ROOT/scripts/setup.js" --repo-root "$REPO_ROOT" --start-runtime',
  openApp: 'node "$SKILL_ROOT/scripts/desktop-attach.js" ensure --launch-only',
  relaunchApp: 'node "$SKILL_ROOT/scripts/desktop-attach.js" ensure --relaunch-desktop',
  persistAttach: 'node "$SKILL_ROOT/scripts/desktop-attach.js" persist --authorize',
});

function step(order, action, what, why, consent, command, extra = {}) {
  return { order, action, what, why, consent, command, ...extra };
}

function contextSentence(hostContext) {
  if (hostContext?.platform?.claudeLanesSupported === false) return UNSUPPORTED_CONTEXT;
  if (hostContext?.surface === 'ide') return IDE_CONTEXT;
  if (hostContext?.app === 'claude-code-terminal' || hostContext?.app === 'codex-tui') {
    return TERMINAL_CONTEXT;
  }
  if (hostContext?.app === 'shell') {
    return 'This setup is built for Claude Desktop and the ChatGPT app; open either app when setup is complete.';
  }
  if (hostContext?.app === 'codex-desktop') {
    return 'This app cannot relaunch itself; use its own collaboration for Codex children, or attach a shared runtime from outside it.';
  }
  return null;
}

function providerStatus(provider, observation, hostContext) {
  if (observation?.requested === false) return 'not-requested';
  if (provider === 'claude' && (observation?.setup?.reason === 'unsupported-platform' ||
      hostContext?.platform?.claudeLanesSupported === false)) return 'unsupported';
  if (observation?.reusable !== true) return 'needs-action';
  if (provider === 'codex' && observation?.nativeVisibility?.verified !== true) {
    return 'ready-with-limitations';
  }
  return 'ready';
}

function setupReadiness(providers, hostContext) {
  const statuses = Object.fromEntries(['claude', 'codex'].map((provider) => [
    provider,
    providerStatus(provider, providers?.[provider], hostContext),
  ]));
  const requested = Object.values(statuses).filter((status) => status !== 'not-requested');
  const supported = requested.filter((status) => status !== 'unsupported');
  let outcome;
  if (requested.length > 0 && supported.length === 0) outcome = 'unsupported';
  else if (supported.includes('needs-action')) outcome = 'needs-action';
  else if (requested.includes('unsupported') || supported.includes('ready-with-limitations') || hostContext?.surface === 'ide') {
    outcome = 'ready-with-limitations';
  } else outcome = 'ready';
  return {
    ready: outcome === 'ready' || outcome === 'ready-with-limitations',
    outcome,
    providers: statuses,
  };
}

function supportedCodexBinary(doctorResult) {
  return doctorResult?.providers?.codex?.cliBinaries?.find((candidate) =>
    candidate && candidate.supported === true && typeof candidate.path === 'string') || null;
}

function claudeSteps(reason) {
  if (reason === 'cli-not-found') {
    return [
      step(10, 'install-claude', 'Install Claude Code.',
        'This gives you Claude lanes; declining leaves Codex lanes available.', 'install', COMMANDS.installClaude),
      step(20, 'sign-in-claude', 'Sign in to Claude Code.',
        'This connects Claude lanes to your account; declining leaves Codex lanes available.', 'sign-in', COMMANDS.signInClaude),
    ];
  }
  if (['not-logged-in', 'account-not-first-party', 'auth-status-unreadable'].includes(reason)) {
    return [step(20, 'sign-in-claude', 'Sign in to Claude Code.',
      'This connects Claude lanes to a verified account; declining leaves Codex lanes available.', 'sign-in', COMMANDS.signInClaude)];
  }
  if (['cli-unpinned', 'cli-unsupported', 'cli-below-minimum', 'cli-outdated', 'cli-not-executable'].includes(reason)) {
    return [step(10, 'install-claude', 'Install a supported Claude Code release.',
      'This gives Claude lanes a compatible host; declining leaves Codex lanes available.', 'install', COMMANDS.installClaude)];
  }
  return [];
}

function codexSteps(action, doctorResult, hostContext) {
  const runtime = doctorResult?.providers?.codex?.runtime;
  const binary = supportedCodexBinary(doctorResult);
  if (action.reason === 'cli-not-found') {
    return [
      step(30, 'install-codex', 'Install the Codex command-line tool.',
        'This gives Codex lanes a compatible runtime host; declining leaves Claude lanes available.', 'install', COMMANDS.installCodex),
      step(40, 'sign-in-codex', 'Sign in to Codex.',
        'This connects the Codex runtime to your account; declining leaves Claude lanes available.', 'sign-in', COMMANDS.signInCodex),
    ];
  }
  if (['not-logged-in', 'codex-not-logged-in'].includes(action.reason)) {
    return [step(40, 'sign-in-codex', 'Sign in to Codex.',
      'This connects the Codex runtime to your account; declining leaves Claude lanes available.', 'sign-in', COMMANDS.signInCodex)];
  }
  if (action.reason === 'runtime-unavailable' && runtime?.state === 'unavailable' && binary) {
    const bundled = binary.sources.includes('codex-desktop');
    const what = bundled
      ? 'Start a shared Codex runtime with the compatible tool bundled in the Codex app.'
      : 'Start a compatible shared Codex runtime.';
    return [step(50, 'start-runtime', what,
      'This gives Codex lanes a measured local runtime; declining leaves Claude lanes available.',
      'start-runtime', COMMANDS.startRuntime, { binary: binary.path })];
  }
  if (action.reason === 'desktop-unattached' && hostContext?.app !== 'codex-desktop') {
    return [step(70, 'relaunch-app', 'Reconnect the Codex app to the shared runtime by relaunching it.',
      'This makes live lane updates appear in the app; declining leaves Codex lanes available in protocol-only mode.',
      'relaunch-desktop', COMMANDS.relaunchApp)];
  }
  if (action.reason === 'desktop-not-running' && runtime?.state === 'reusable') {
    return [step(60, 'open-app', 'Open the Codex app on the shared runtime.',
      'This shows live lane updates in the app; declining leaves Codex lanes available in protocol-only mode.',
      'none', COMMANDS.openApp)];
  }
  return [];
}

function attachmentAction(doctorResult) {
  const evidence = doctorResult?.providers?.codex?.nativeVisibility?.evidence;
  const state = typeof evidence === 'string' && evidence.startsWith('desktop-attachment:')
    ? evidence.slice('desktop-attachment:'.length) : null;
  const reasons = new Map([
    ['unattached', 'desktop-unattached'],
    ['notRunning', 'desktop-not-running'],
    ['notInstalled', 'desktop-not-installed'],
    ['attachedElsewhere', 'desktop-attached-elsewhere'],
    ['unsupportedPlatform', 'desktop-unsupported-platform'],
    ['disabled', 'desktop-attach-disabled'],
    ['toolUnavailable', 'desktop-tool-unavailable'],
  ]);
  return reasons.has(state)
    ? { provider: 'codex', reason: reasons.get(state), ownerAction: doctorResult.providers.codex.nativeVisibility.nextAction }
    : null;
}

function computeSetupPlan(doctorResult, hostContext) {
  const actions = [...(doctorResult?.setup?.ownerActions || [])];
  const measuredAttachment = attachmentAction(doctorResult);
  if (measuredAttachment && !actions.some((action) =>
    action.provider === measuredAttachment.provider && action.reason === measuredAttachment.reason)) {
    actions.push(measuredAttachment);
  }
  const hostAllowsDesktopActions = hostContext?.surface !== 'ide';
  const steps = actions.flatMap((action) => {
    if (action.provider === 'claude') {
      if (hostContext?.platform?.claudeLanesSupported === false) return [];
      return claudeSteps(action.reason);
    }
    if (action.provider === 'codex') return codexSteps(action, doctorResult, hostContext);
    return [];
  });
  const visibility = doctorResult?.providers?.codex?.nativeVisibility;
  if (hostAllowsDesktopActions && visibility?.verified === true && visibility.persisted === false) {
    steps.push(step(80, 'persist-attach', 'Keep the Codex app connected to the shared runtime after login.',
      'This makes future app sessions reuse the shared runtime; declining leaves the current attachment and protocol-only lanes available.',
      'persist-attach', COMMANDS.persistAttach));
  }
  const seen = new Set();
  const ordered = steps
    .filter((entry) => hostAllowsDesktopActions || !['open-app', 'relaunch-app', 'persist-attach'].includes(entry.action))
    .sort((left, right) => left.order - right.order)
    .filter((entry) => {
      const key = `${entry.action}\0${entry.binary || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ order, ...entry }) => entry);
  return { context: contextSentence(hostContext), steps: ordered };
}

module.exports = {
  ACTIONS,
  COMMANDS,
  IDE_CONTEXT,
  TERMINAL_CONTEXT,
  UNSUPPORTED_CONTEXT,
  computeSetupPlan,
  contextSentence,
  setupReadiness,
};
