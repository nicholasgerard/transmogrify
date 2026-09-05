'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { detectHostContext, installedDesktopApps } = require('../scripts/lib/host-context');

function expectedBundleIdentifier(plistPath) {
  if (plistPath.includes('/Claude.app/')) return 'com.anthropic.claudefordesktop';
  if (plistPath.includes('/ChatGPT.app/')) return 'com.openai.chat';
  if (plistPath.includes('/Codex.app/')) return 'com.openai.codex';
  throw new Error('unexpected bundle fixture');
}

function detect(env, ancestry = [], platform = 'darwin', arch = 'arm64', identifiers = new Map()) {
  return detectHostContext(env, {
    ancestry,
    platform,
    arch,
    readInfoPlist(plistPath) {
      return {
        CFBundleIdentifier: identifiers.get(path.dirname(path.dirname(plistPath))) ||
          expectedBundleIdentifier(plistPath),
      };
    },
  });
}

test('detects Claude Code hosted by the real Claude Desktop ancestry', () => {
  const context = detect({ CLAUDECODE: '1', CLAUDE_CODE_EXECPATH: '/opt/claude' }, [
    { pid: 50, ppid: 40, command: '/bin/zsh' },
    { pid: 40, ppid: 30, command: '/Users/test/Library/Application Support/Claude/claude-code/2.1.255/claude.app/Contents/MacOS/claude' },
    { pid: 30, ppid: 20, command: '/Applications/Claude.app/Contents/Helpers/disclaimer' },
    { pid: 20, ppid: 1, command: '/Applications/Claude.app/Contents/MacOS/Claude' },
  ]);
  assert.deepEqual(context, {
    app: 'claude-desktop',
    surface: 'desktop',
    platform: { os: 'darwin', arch: 'arm64', claudeLanesSupported: true },
    tools: {
      claudeCode: true, codex: false, terminalAncestor: false,
      processAncestry: true, hostedByDesktop: false,
    },
    cliBinaries: { claude: '/opt/claude', codex: null },
  });
});

test('detects a relocated Claude Desktop bundle by verified bundle identity', () => {
  const context = detect({ CLAUDECODE: '1' }, [
    { pid: 40, ppid: 1, command: '/Volumes/Developer Tools/Claude.app/Contents/MacOS/Claude' },
  ]);
  assert.equal(context.app, 'claude-desktop');
  assert.equal(context.surface, 'desktop');
});

test('detects Claude Desktop from a per-user Applications folder', () => {
  const context = detect({ CLAUDECODE: '1' }, [
    { pid: 40, ppid: 1, command: '/Users/example/Applications/Claude.app/Contents/MacOS/Claude' },
  ]);
  assert.equal(context.app, 'claude-desktop');
});

test('detects a nested Claude Desktop helper ancestry', () => {
  const context = detect({ CLAUDECODE: '1' }, [
    {
      pid: 40,
      ppid: 1,
      command: '/Volumes/Apps/Claude.app/Contents/Helpers/Claude Helper.app/Contents/MacOS/Claude Helper',
    },
  ]);
  assert.equal(context.app, 'claude-desktop');
});

test('detects Claude Code in a terminal', () => {
  const context = detect({ CLAUDECODE: '1' }, [
    { pid: 40, ppid: 30, command: '/Users/test/Library/Application Support/Claude/claude-code/2.1.255/claude.app/Contents/MacOS/claude' },
    { pid: 30, ppid: 1, command: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' },
  ]);
  assert.equal(context.app, 'claude-code-terminal');
  assert.equal(context.surface, 'terminal');
  assert.equal(context.tools.terminalAncestor, true);
});

test('detects Codex Desktop through the shared hostedByDesktop decision', () => {
  const context = detect({ CODEX_THREAD_ID: 'thread_12345678' }, [
    { pid: 40, ppid: 1, command: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' },
  ]);
  assert.equal(context.app, 'codex-desktop');
  assert.equal(context.surface, 'desktop');
  assert.equal(context.tools.hostedByDesktop, true);
});

test('detects both verified Codex Desktop bundle names wherever they are installed', () => {
  for (const command of [
    '/Volumes/Apps/ChatGPT.app/Contents/MacOS/ChatGPT',
    '/Users/example/Applications/Codex.app/Contents/MacOS/Codex',
  ]) {
    const context = detect({ CODEX_THREAD_ID: 'thread_12345678' }, [
      { pid: 40, ppid: 1, command },
    ]);
    assert.equal(context.app, 'codex-desktop', command);
    assert.equal(context.tools.hostedByDesktop, true, command);
  }
});

test('rejects a Desktop lookalike whose bundle identifier is wrong', () => {
  const bundle = '/Volumes/Lookalikes/Claude.app';
  const context = detect({ CLAUDECODE: '1' }, [
    { pid: 40, ppid: 1, command: `${bundle}/Contents/MacOS/Claude` },
  ], 'darwin', 'arm64', new Map([[bundle, 'example.lookalike']]));
  assert.equal(context.app, 'claude-code-terminal');
  assert.equal(context.surface, 'terminal');
});

test('detects the Codex TUI without Desktop ancestry', () => {
  const context = detect({ CODEX_THREAD_ID: 'thread_12345678' }, [
    { pid: 30, ppid: 20, command: '/usr/local/bin/tmux' },
  ]);
  assert.equal(context.app, 'codex-tui');
  assert.equal(context.surface, 'terminal');
});

test('does not mistake the ChatGPT-bundled Codex CLI for Codex Desktop', () => {
  const context = detect({ CODEX_THREAD_ID: 'thread_12345678' }, [
    { pid: 40, ppid: 30, command: '/Applications/ChatGPT.app/Contents/Resources/codex' },
    { pid: 30, ppid: 1, command: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' },
  ]);
  assert.equal(context.app, 'codex-tui');
  assert.equal(context.surface, 'terminal');
  assert.equal(context.tools.hostedByDesktop, false);
});

test('does not mistake the Claude Code CLI bundle for Claude Desktop', () => {
  const context = detect({ CLAUDECODE: '1' }, [
    {
      pid: 40,
      ppid: 1,
      command: '/Users/example/Library/Application Support/Claude/claude-code/2.1.258/claude.app/Contents/MacOS/claude',
    },
  ]);
  assert.equal(context.app, 'claude-code-terminal');
  assert.equal(context.surface, 'terminal');
});

test('installedDesktopApps returns only verified bundle and bundled CLI paths', () => {
  const claudeBundle = '/Volumes/Apps/Claude.app';
  const chatGptBundle = '/Users/example/Applications/ChatGPT.app';
  const lookalikeBundle = '/Volumes/Lookalikes/Codex.app';
  const identifiers = new Map([
    [claudeBundle, 'com.anthropic.claudefordesktop'],
    [chatGptBundle, 'com.openai.codex'],
    [lookalikeBundle, 'example.lookalike'],
  ]);
  const apps = installedDesktopApps({
    paths: [claudeBundle, chatGptBundle, lookalikeBundle],
  }, {
    readInfoPlist(plistPath) {
      return { CFBundleIdentifier: identifiers.get(path.dirname(path.dirname(plistPath))) };
    },
  });

  assert.deepEqual(apps, [
    {
      app: 'claude-desktop',
      bundleName: 'Claude.app',
      bundlePath: claudeBundle,
      bundleIdentifier: 'com.anthropic.claudefordesktop',
      bundledCliPaths: [],
    },
    {
      app: 'codex-desktop',
      bundleName: 'ChatGPT.app',
      bundlePath: chatGptBundle,
      bundleIdentifier: 'com.openai.codex',
      bundledCliPaths: [`${chatGptBundle}/Contents/Resources/codex`],
    },
  ]);
});

test('detects Cursor before terminal provider markers', () => {
  const context = detect({ CLAUDECODE: '1', TERM_PROGRAM: 'cursor', CURSOR_TRACE_ID: 'x' });
  assert.equal(context.app, 'cursor');
  assert.equal(context.surface, 'ide');
});

test('detects VS Code from process ancestry', () => {
  const context = detect({}, [
    { pid: 30, ppid: 20, command: '/Applications/Code.app/Contents/MacOS/Electron' },
  ]);
  assert.equal(context.app, 'vscode');
  assert.equal(context.surface, 'ide');
});

test('falls back to a plain shell', () => {
  const context = detect({}, [{ pid: 30, ppid: 20, command: '/bin/zsh' }]);
  assert.equal(context.app, 'shell');
  assert.equal(context.surface, 'terminal');
});

test('reports an unsupported machine without changing its shell context', () => {
  const context = detect({}, [{ pid: 30, ppid: 20, command: '/bin/bash' }], 'linux', 'x64');
  assert.equal(context.app, 'shell');
  assert.deepEqual(context.platform, { os: 'linux', arch: 'x64', claudeLanesSupported: false });
});
