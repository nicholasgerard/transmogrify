'use strict';

// Host context is deliberately narrow: environment markers and process
// ancestry only. It never consults windows, application state, or GUI APIs.

const path = require('node:path');
const { hostedByDesktop } = require('./desktop-attach');
const { walkProcessAncestry } = require('./process-ancestry');

const APPS = Object.freeze([
  'claude-desktop', 'claude-code-terminal', 'codex-desktop', 'codex-tui',
  'cursor', 'vscode', 'shell',
]);
const SURFACES = Object.freeze(['desktop', 'terminal', 'ide']);

function commandOf(row) {
  return typeof row === 'string' ? row : String(row?.command || row?.comm || '');
}

function hasAppAncestor(ancestry, appName) {
  const segment = `/${appName.toLowerCase()}.app/`;
  return ancestry.some((row) => commandOf(row).toLowerCase().includes(segment));
}

// Claude Code ships its CLI in a lowercase claude.app bundle. Only the actual
// /Applications/Claude.app process and its helpers establish Desktop ancestry.
function isClaudeDesktopProcess(row) {
  const command = commandOf(row);
  if (path.basename(command) === 'claude') return false;
  return command === '/Applications/Claude.app/Contents/MacOS/Claude' ||
    command.startsWith('/Applications/Claude.app/Contents/Helpers/');
}

// The ChatGPT app also bundles a Resources/codex CLI. Match only the native
// application executables so a terminal launched from that CLI remains a TUI.
function isCodexDesktopProcess(row) {
  const command = commandOf(row);
  return command === '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' ||
    command === '/Applications/Codex.app/Contents/MacOS/Codex';
}

function hasNamedAncestor(ancestry, names) {
  return ancestry.some((row) => {
    const command = commandOf(row);
    const basename = path.basename(command).toLowerCase();
    return names.some((name) => basename === name || command.toLowerCase().includes(`/${name}.app/`));
  });
}

function configuredBinary(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function detectHostContext(env = process.env, dependencies = {}) {
  const suppliedAncestry = dependencies.ancestry || dependencies.processAncestry;
  const ancestry = typeof suppliedAncestry === 'function'
    ? suppliedAncestry()
    : suppliedAncestry || (dependencies.walkProcessAncestry || walkProcessAncestry)({
      run: dependencies.run,
      startPid: dependencies.startPid ?? process.ppid,
    });
  const platformName = dependencies.platform || process.platform;
  const arch = dependencies.arch || process.arch;
  const claudeMarker = Boolean(env.CLAUDECODE);
  const codexMarker = Boolean(env.CODEX_THREAD_ID);
  const cursorMarker = String(env.TERM_PROGRAM || '').toLowerCase() === 'cursor' ||
    Object.keys(env).some((key) => key.startsWith('CURSOR_')) || hasAppAncestor(ancestry, 'Cursor');
  const vscodeMarker = ['vscode', 'visual studio code'].includes(String(env.TERM_PROGRAM || '').toLowerCase()) ||
    hasAppAncestor(ancestry, 'Code') || hasAppAncestor(ancestry, 'Visual Studio Code');
  const claudeDesktop = claudeMarker && ancestry.some(isClaudeDesktopProcess);
  const terminalAncestor = hasNamedAncestor(ancestry, ['terminal', 'iterm2', 'iterm', 'tmux', 'sshd', 'ssh']);
  const identifiedAncestry = ancestry.map((row, index) => ({
    row, pid: Number.isInteger(row?.pid) ? row.pid : index + 2,
  }));
  const ancestorPids = identifiedAncestry.map((entry) => entry.pid);
  const codexDesktopPids = identifiedAncestry.filter(({ row }) =>
    isCodexDesktopProcess(row)).map((entry) => entry.pid);
  const desktopHostCheck = typeof dependencies.hostedByDesktop === 'function'
    ? dependencies.hostedByDesktop : hostedByDesktop;
  const desktopHosted = codexMarker && (dependencies.hostedByDesktop === true || desktopHostCheck(
    ancestorPids, codexDesktopPids,
  ));

  let app = 'shell';
  let surface = 'terminal';
  if (claudeDesktop) {
    app = 'claude-desktop';
    surface = 'desktop';
  } else if (desktopHosted) {
    app = 'codex-desktop';
    surface = 'desktop';
  } else if (cursorMarker) {
    app = 'cursor';
    surface = 'ide';
  } else if (vscodeMarker) {
    app = 'vscode';
    surface = 'ide';
  } else if (codexMarker) {
    app = 'codex-tui';
  } else if (claudeMarker) {
    app = 'claude-code-terminal';
  }

  return {
    app,
    surface,
    platform: {
      os: platformName,
      arch,
      claudeLanesSupported: platformName === 'darwin' && arch === 'arm64',
    },
    tools: {
      claudeCode: claudeMarker,
      codex: codexMarker,
      terminalAncestor,
      processAncestry: ancestry.length > 0,
      hostedByDesktop: desktopHosted,
    },
    cliBinaries: {
      claude: configuredBinary(env.CLAUDE_BIN || env.CLAUDE_CODE_EXECPATH),
      codex: configuredBinary(env.TRANSMOGRIFY_BIN),
    },
  };
}

module.exports = {
  APPS,
  SURFACES,
  detectHostContext,
};
