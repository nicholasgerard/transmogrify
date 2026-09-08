'use strict';

const APP = '/Applications/ChatGPT.app';
const DESKTOP_PID = 96049;
const SELF_PID = 4242;

function scenario(overrides = {}) {
  const state = {
    installed: true,
    launchServices: true,
    diskInstalled: false,
    running: true,
    attached: false,
    attachOnLaunch: true,
    runtimeListening: true,
    runtimePort: 8843,
    relayRecord: null,
    elsewherePort: null,
    hostedByDesktop: false,
    quitRequested: false,
    quitIgnoredPolls: 0,
    launches: [],
    ...overrides,
  };
  const calls = [];
  const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
  const fail = (stderr = '', code = 1) => ({ code, stdout: '', stderr });
  async function run(executable, args) {
    calls.push([executable, ...args]);
    if (executable === 'osascript' && args[1].startsWith('POSIX path')) {
      return state.installed && state.launchServices && args[1].includes('com.openai.codex')
        ? ok(`${APP}\n`) : fail('not found');
    }
    if (executable === 'osascript' && args[1].endsWith('to quit')) {
      state.quitRequested = true;
      return ok('');
    }
    if (executable === 'defaults') {
      return ok(args[2] === 'CFBundleShortVersionString' ? (state.version || '26.901.20858') : (state.build || '7658'));
    }
    if (executable === 'plutil') {
      if (args[1] === 'CFBundleIdentifier') return ok('com.openai.codex\n');
      return ok(args[1] === 'CFBundleShortVersionString' ? '26.901.22334\n' : '7746\n');
    }
    if (executable === 'ps' && args[0] === '-axo') {
      if (state.quitRequested) {
        if (state.quitIgnoredPolls > 0) state.quitIgnoredPolls -= 1;
        else state.running = false;
      }
      return ok(state.running
        ? `${DESKTOP_PID} ${APP}/Contents/MacOS/ChatGPT\n    1 /sbin/launchd\n 500 ${APP}/Contents/Frameworks/Helper.app/Contents/MacOS/Helper\n`
        : '    1 /sbin/launchd\n');
    }
    if (executable === 'ps' && args[0] === '-o') {
      const pid = Number(args[3]);
      if (pid === SELF_PID) return ok(`${state.hostedByDesktop ? DESKTOP_PID : 1}\n`);
      return ok('1\n');
    }
    if (executable === 'open') {
      state.launches.push(args);
      state.running = true;
      state.quitRequested = false;
      state.attached = state.attachOnLaunch;
      return ok('');
    }
    if (executable === 'lsof') {
      if (args.includes('-a')) {
        return state.elsewherePort
          ? ok(`p${DESKTOP_PID}\ncChatGPT\nn127.0.0.1:50001->127.0.0.1:${state.elsewherePort}\n`)
          : fail();
      }
      if (args.includes('-iTCP') && args.includes('-sTCP:LISTEN')) {
        return ok(`p777\nccodex\nn127.0.0.1:${state.elsewherePort}\np778\ncnode\nn127.0.0.1:3000\n`);
      }
      const portOption = args.find((argument) => argument.startsWith('-iTCP:'));
      const selectedPort = Number(portOption?.slice('-iTCP:'.length));
      if (selectedPort && args.includes('-sTCP:LISTEN')) {
        return state.runtimeListening && selectedPort === state.runtimePort
          ? ok(`p83538\nccodex\nn127.0.0.1:${selectedPort}\n`) : fail();
      }
      if (selectedPort && args.includes('-sTCP:ESTABLISHED')) {
        return state.attached && selectedPort === state.runtimePort
          ? ok(`p${DESKTOP_PID}\ncChatGPT\nn127.0.0.1:53519->127.0.0.1:${selectedPort}\np83538\nccodex\nn127.0.0.1:${selectedPort}->127.0.0.1:53519\n`)
          : fail();
      }
    }
    throw new Error(`unexpected ${executable} ${args.join(' ')}`);
  }
  let clock = 1_000_000;
  const dependencies = {
    execFileResult: run,
    platform: 'darwin',
    persistenceStateRoot: '/tmp/transmogrify-no-attachment-fixture-state',
    // A prior owner verification is filesystem-boundary input, never a check receipt.
    attachmentRecordReader: (name) => name === 'verification' ? {
      desktop: state.launchServices ? { version: '26.901.20858', build: '7658' }
        : { version: '26.901.22334', build: '7746' },
      attachStatus: 'verified',
    } : null,
    pid: SELF_PID,
    now: () => '2026-09-02T22:00:00.000Z',
    sleep: async (milliseconds) => { clock += milliseconds; },
    clock: () => clock,
    existsSync: () => state.diskInstalled,
    runningRelay: () => state.relayRecord,
    launchctlGetenv: async () => state.persistedUrl || '',
    plistExists: () => state.plistExists === true,
    runtimeUp: async () => {
      calls.push(['runtime-up']);
      state.runtimeListening = true;
      state.runtimePort = 8844;
      state.relayRecord = {
        url: 'ws://127.0.0.1:8844/',
        socketPath: '/private/tmp/codex-daemon.sock',
      };
      return { runtime: 'managed-daemon', url: state.relayRecord.url };
    },
  };
  return { state, calls, dependencies };
}

module.exports = { scenario, APP, DESKTOP_PID, SELF_PID };
