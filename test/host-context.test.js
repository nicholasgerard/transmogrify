'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { detectHostContext } = require('../scripts/lib/host-context');

function detect(env, ancestry = [], platform = 'darwin', arch = 'arm64') {
  return detectHostContext(env, { ancestry, platform, arch });
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
