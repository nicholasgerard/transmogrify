'use strict';

// Convert the doctor's measured reasons into one ordered, user-facing plan.
// This module describes actions only; setup.js is the later execution gate.

const TERMINAL_CONTEXT = 'This is built for the desktop apps; live streaming shows there, everything else works here.';
const IDE_CONTEXT = 'Install both hosts, then open Claude Desktop or the ChatGPT app; Cursor support is not available yet.';
const UNSUPPORTED_CONTEXT = 'Claude lanes require Apple Silicon macOS; Codex lanes still work here in protocol-only mode.';

const COMMANDS = Object.freeze({
  installClaude: 'node "$SKILL_ROOT/scripts/setup.js" --repo-root "$REPO_ROOT" --install-claude-cli',
  signInClaude: 'claude auth login',
  installCodex: 'node "$SKILL_ROOT/scripts/setup.js" --repo-root "$REPO_ROOT" --install-codex-cli',
  signInCodex: 'codex login',
  startRuntime: '"$SKILL_ROOT/scripts/runtime-up.sh"',
  attachDesktop: 'node "$SKILL_ROOT/scripts/desktop-attach.js" ensure',
  relaunchDesktop: 'node "$SKILL_ROOT/scripts/desktop-attach.js" ensure --relaunch-desktop',
});

function step(order, what, why, consent, command) {
  return { order, what, why, consent, command };
}

function compatibleBundledCodexBinary(doctorResult, hostContext) {
  const sources = [
    doctorResult?.providers?.codex?.cliBinaries,
    doctorResult?.providers?.codex?.observed?.cliBinaries,
    doctorResult?.cliBinaries,
    hostContext?.cliBinaries?.codex,
  ];
  const candidates = sources.flatMap((source) => {
    if (Array.isArray(source)) return source;
    if (source && typeof source === 'object') return Object.values(source);
    return [];
  });
  return candidates.some((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const source = String(candidate.source || candidate.kind || '').toLowerCase();
    const supported = candidate.supported === true || candidate.compatible === true || candidate.reusable === true;
    return supported && (source.includes('bundled') || source.includes('desktop'));
  });
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

function stepsForAction(action, doctorResult, hostContext) {
  const { provider, reason } = action;
  if (provider === 'claude') {
    if (reason === 'cli-not-found') {
      return [
        step(10, 'Install Claude Code.', 'Claude lanes need the Claude Code command-line tool.', 'install', COMMANDS.installClaude),
        step(20, 'Sign in to Claude Code.', 'Claude lanes run through your Claude account.', 'sign-in', COMMANDS.signInClaude),
      ];
    }
    if (['not-logged-in', 'account-not-first-party'].includes(reason)) {
      return [step(20, 'Sign in to Claude Code.', 'Claude lanes need a signed-in claude.ai account.', 'sign-in', COMMANDS.signInClaude)];
    }
    if (['cli-unpinned', 'cli-unsupported', 'cli-below-minimum', 'cli-outdated', 'cli-not-executable'].includes(reason)) {
      return [step(10, 'Install a supported Claude Code release.', 'The installed Claude Code tool cannot pass the required checks.', 'install', COMMANDS.installClaude)];
    }
    if (reason === 'auth-status-unreadable') {
      return [step(20, 'Repair the Claude Code sign-in.', 'Claude Code cannot confirm which account is signed in.', 'sign-in', COMMANDS.signInClaude)];
    }
    if (reason === 'custom-config-dir') {
      return [step(5, 'Use the default Claude Code configuration for Transmogrify.', 'Only the default configuration can be verified safely.', 'none', 'unset CLAUDE_CONFIG_DIR')];
    }
    if (reason === 'unsupported-platform') return [];
  }

  if (provider === 'codex') {
    if (reason === 'cli-not-found') {
      return [
        step(30, 'Install the Codex command-line tool.', 'Codex lanes need a compatible tool to host their shared runtime.', 'install', COMMANDS.installCodex),
        step(40, 'Sign in to Codex.', 'The Codex runtime needs your signed-in Codex account.', 'sign-in', COMMANDS.signInCodex),
      ];
    }
    if (['not-logged-in', 'codex-not-logged-in'].includes(reason)) {
      return [step(40, 'Sign in to Codex.', 'The Codex runtime needs your signed-in Codex account.', 'sign-in', COMMANDS.signInCodex)];
    }
    if (['runtime-unavailable', 'runtime-unsupported'].includes(reason)) {
      const what = compatibleBundledCodexBinary(doctorResult, hostContext)
        ? 'Start a shared Codex runtime with the compatible tool bundled in the Codex app.'
        : 'Start a compatible shared Codex runtime.';
      return [step(50, what, 'Codex lanes need a measured local runtime for reliable control.', 'start-runtime', COMMANDS.startRuntime)];
    }
    if (reason === 'desktop-unattached') {
      if (hostContext?.app === 'codex-desktop') return [];
      return [step(
        70,
        'Reconnect the Codex app to the shared runtime by relaunching it.',
        'Live lane updates appear in the app only after it reconnects, and relaunching ends what the app is doing now.',
        'relaunch-desktop',
        COMMANDS.relaunchDesktop,
      )];
    }
    if (reason === 'desktop-not-running') {
      return [step(60, 'Open the Codex app on the shared runtime.', 'Live lane updates appear in the app only while it is connected.', 'none', COMMANDS.attachDesktop)];
    }
    if (reason === 'desktop-not-installed') {
      return [step(30, 'Install the ChatGPT app for live Codex lane updates.', 'Codex lanes still work without the app, but they cannot stream into a desktop interface.', 'install', action.ownerAction)];
    }
    if (reason === 'desktop-attached-elsewhere') {
      const nextAction = doctorResult?.providers?.codex?.nativeVisibility?.nextAction;
      return [step(55, 'Use the shared runtime that the Codex app already uses.', 'Keeping one runtime avoids splitting lanes between connections.', 'none', nextAction || action.ownerAction)];
    }
    if (reason === 'desktop-attach-disabled') {
      return [step(55, 'Enable live Codex app attachment.', 'Live lane updates cannot appear in the app while attachment is disabled.', 'none', 'unset TRANSMOGRIFY_DESKTOP_ATTACH')];
    }
    if (reason === 'desktop-unsupported-platform') return [];
    if (reason === 'sandbox-loopback-denied') {
      return [step(45, 'Allow this session to connect to local services.', 'The doctor cannot verify the Codex runtime until local connections are allowed.', 'none', action.ownerAction)];
    }
    if (reason === 'desktop-tool-unavailable') {
      return [step(55, 'Restore the system tools used to verify the Codex app connection.', 'The app connection cannot be trusted until it can be measured.', 'none', action.ownerAction)];
    }
  }

  return [step(
    90,
    `Resolve the remaining ${provider === 'claude' ? 'Claude' : 'Codex'} setup requirement.`,
    `The ${provider === 'claude' ? 'Claude' : 'Codex'} host cannot be made ready until this check passes.`,
    'none',
    action.ownerAction,
  )];
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
  const seen = new Set();
  const steps = actions.flatMap((action) => stepsForAction(action, doctorResult, hostContext))
    .sort((left, right) => left.order - right.order)
    .filter((entry) => {
      const key = `${entry.what}\0${entry.command}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ order, ...entry }) => entry);
  return { context: contextSentence(hostContext), steps };
}

module.exports = {
  COMMANDS,
  IDE_CONTEXT,
  TERMINAL_CONTEXT,
  UNSUPPORTED_CONTEXT,
  computeSetupPlan,
  contextSentence,
};
