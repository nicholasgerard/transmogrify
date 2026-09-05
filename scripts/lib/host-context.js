'use strict';

// Host context is deliberately narrow: environment markers, process ancestry,
// and read-only bundle metadata. It never consults windows, application state,
// or GUI APIs.

const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { hostedByDesktop } = require('./desktop-attach');
const { walkProcessAncestry } = require('./process-ancestry');

const APPS = Object.freeze([
  'claude-desktop', 'claude-code-terminal', 'codex-desktop', 'codex-tui',
  'cursor', 'vscode', 'shell',
]);
const SURFACES = Object.freeze(['desktop', 'terminal', 'ide']);
const DESKTOP_APP_DEFINITIONS = Object.freeze([
  Object.freeze({
    app: 'claude-desktop',
    bundleName: 'Claude.app',
    bundleIdentifiers: Object.freeze(['com.anthropic.claudefordesktop']),
    bundledCliRelativePaths: Object.freeze([]),
  }),
  Object.freeze({
    app: 'codex-desktop',
    bundleName: 'ChatGPT.app',
    bundleIdentifiers: Object.freeze(['com.openai.codex', 'com.openai.chat']),
    bundledCliRelativePaths: Object.freeze(['Contents/Resources/codex']),
  }),
  Object.freeze({
    app: 'codex-desktop',
    bundleName: 'Codex.app',
    bundleIdentifiers: Object.freeze(['com.openai.codex', 'com.openai.chat']),
    bundledCliRelativePaths: Object.freeze(['Contents/Resources/codex']),
  }),
]);

function commandOf(row) {
  return typeof row === 'string' ? row : String(row?.command || row?.comm || '');
}

function hasAppAncestor(ancestry, appName) {
  const segment = `/${appName.toLowerCase()}.app/`;
  return ancestry.some((row) => commandOf(row).toLowerCase().includes(segment));
}

function definitionForBundlePath(bundlePath) {
  const bundleName = path.basename(bundlePath);
  return DESKTOP_APP_DEFINITIONS.find((definition) => definition.bundleName === bundleName) || null;
}

// Process paths may come from a relocated or per-user app. Match only the
// native executable suffixes. A lowercase claude.app is Claude Code's own CLI
// bundle and intentionally cannot match the Claude Desktop suffix.
function desktopBundleForProcess(row) {
  const command = commandOf(row);
  const matches = [
    /^(.*\/Claude\.app)\/Contents\/MacOS\/Claude$/,
    /^(.*\/Claude\.app)\/Contents\/Helpers\/.+$/,
    /^(.*\/ChatGPT\.app)\/Contents\/MacOS\/ChatGPT$/,
    /^(.*\/Codex\.app)\/Contents\/MacOS\/Codex$/,
  ];
  for (const pattern of matches) {
    const match = pattern.exec(command);
    if (match && path.isAbsolute(match[1])) return match[1];
  }
  return null;
}

function bundleIdentifierFrom(value) {
  if (Buffer.isBuffer(value)) return bundleIdentifierFrom(value.toString('utf8'));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return typeof value.CFBundleIdentifier === 'string' ? value.CFBundleIdentifier.trim() : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return typeof parsed.CFBundleIdentifier === 'string'
        ? parsed.CFBundleIdentifier.trim()
        : null;
    }
  } catch {}
  return trimmed || null;
}

function defaultReadInfoPlist(plistPath, dependencies = {}) {
  const run = dependencies.execFileSync || execFileSync;
  return run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024,
    timeout: 5000,
  });
}

function defaultDesktopBundlePaths(home) {
  const roots = ['/Applications'];
  if (typeof home === 'string' && path.isAbsolute(home)) roots.push(path.join(home, 'Applications'));
  return roots.flatMap((root) => DESKTOP_APP_DEFINITIONS.map(
    (definition) => path.join(root, definition.bundleName),
  ));
}

// Inventory only bundles whose on-disk identifier matches the supported app.
// Callers may provide process paths, discovered bundle paths, or neither (the
// standard and per-user Applications folders). Reading Info.plist is injected
// so tests and later consumers can keep discovery at their own process boundary.
function installedDesktopApps(options = {}, dependencies = {}) {
  const suppliedPaths = options.paths || options.bundlePaths;
  const candidates = suppliedPaths === undefined
    ? defaultDesktopBundlePaths(options.home || os.homedir())
    : suppliedPaths;
  if (!Array.isArray(candidates)) return [];
  const readInfoPlist = dependencies.readInfoPlist || options.readInfoPlist ||
    ((plistPath) => defaultReadInfoPlist(plistPath, dependencies));
  const bundles = new Map();
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const bundlePath = candidate.endsWith('.app') ? candidate : desktopBundleForProcess(candidate);
    if (!bundlePath || !path.isAbsolute(bundlePath) || bundles.has(bundlePath)) continue;
    const definition = definitionForBundlePath(bundlePath);
    if (!definition) continue;
    let bundleIdentifier;
    try {
      bundleIdentifier = bundleIdentifierFrom(
        readInfoPlist(path.join(bundlePath, 'Contents', 'Info.plist')),
      );
    } catch {
      continue;
    }
    if (!definition.bundleIdentifiers.includes(bundleIdentifier)) continue;
    bundles.set(bundlePath, {
      app: definition.app,
      bundleName: definition.bundleName,
      bundlePath,
      bundleIdentifier,
      bundledCliPaths: definition.bundledCliRelativePaths.map(
        (relativePath) => path.join(bundlePath, relativePath),
      ),
    });
  }
  return [...bundles.values()];
}

function verifiedDesktopAppForProcess(row, apps) {
  const bundlePath = desktopBundleForProcess(row);
  return apps.find((app) => app.bundlePath === bundlePath) || null;
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
  const desktopApps = installedDesktopApps({
    paths: ancestry.map(commandOf),
  }, {
    execFileSync: dependencies.execFileSync,
    readInfoPlist: dependencies.readInfoPlist,
  });
  const cursorMarker = String(env.TERM_PROGRAM || '').toLowerCase() === 'cursor' ||
    Object.keys(env).some((key) => key.startsWith('CURSOR_')) || hasAppAncestor(ancestry, 'Cursor');
  const vscodeMarker = ['vscode', 'visual studio code'].includes(String(env.TERM_PROGRAM || '').toLowerCase()) ||
    hasAppAncestor(ancestry, 'Code') || hasAppAncestor(ancestry, 'Visual Studio Code');
  const claudeDesktop = claudeMarker && ancestry.some((row) =>
    verifiedDesktopAppForProcess(row, desktopApps)?.app === 'claude-desktop');
  const terminalAncestor = hasNamedAncestor(ancestry, ['terminal', 'iterm2', 'iterm', 'tmux', 'sshd', 'ssh']);
  const identifiedAncestry = ancestry.map((row, index) => ({
    row, pid: Number.isInteger(row?.pid) ? row.pid : index + 2,
  }));
  const ancestorPids = identifiedAncestry.map((entry) => entry.pid);
  const codexDesktopPids = identifiedAncestry.filter(({ row }) =>
    verifiedDesktopAppForProcess(row, desktopApps)?.app === 'codex-desktop').map((entry) => entry.pid);
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
  DESKTOP_APP_DEFINITIONS,
  SURFACES,
  detectHostContext,
  installedDesktopApps,
};
