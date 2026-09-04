'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  ACTIONS, INSTALL_COMMANDS, actionForStep, parseSetupArgs, runSetup,
} = require('../scripts/setup');
const { runNodeScript } = require('./helpers/run-cli');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOST = {
  app: 'shell',
  surface: 'terminal',
  tools: { claudeCode: false, codex: false },
};

function step(what, consent, command) {
  return { what, why: `${what} is needed.`, consent, command };
}

function report(steps, ready = steps.length === 0) {
  return {
    setup: { ready, ownerActions: [], plan: { context: 'Test host.', steps } },
    providers: {
      claude: { reusable: ready },
      codex: { reusable: ready, nativeVisibility: { verified: ready } },
    },
  };
}

function options(overrides = {}) {
  return {
    repoRoot: REPO_ROOT,
    dryRun: false,
    installClaudeCli: false,
    installCodexCli: false,
    signIn: false,
    startRuntime: false,
    relaunchDesktop: false,
    persistAttach: false,
    ...overrides,
  };
}

test('setup dry-run prints the measured plan without invoking any action', async () => {
  const planned = step('Install Claude Code.', 'install', '--install-claude-cli');
  let actions = 0;
  const result = await runSetup(options({ dryRun: true }), {}, {
    runDoctor: async () => report([planned]),
    hostContext: HOST,
    installers: { claude: async () => { actions += 1; } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.ready, false);
  assert.deepEqual(result.plan.steps, [planned]);
  assert.deepEqual(result.completed, []);
  assert.equal(actions, 0);
});

test('setup executes every recognized action through injected runners and rechecks after each', async () => {
  const plans = [
    step('Install Claude Code.', 'install', '--install-claude-cli'),
    step('Sign in to Claude Code.', 'sign-in', 'claude auth login'),
    step('Install Codex.', 'install', '--install-codex-cli'),
    step('Sign in to Codex.', 'sign-in', 'codex login'),
    step('Start runtime.', 'start-runtime', 'runtime-up'),
    step('Open Desktop.', 'none', 'desktop-attach.js ensure'),
    step('Relaunch Desktop.', 'relaunch-desktop', 'desktop-attach.js ensure --relaunch-desktop'),
    step('Keep Desktop attached.', 'persist-attach', 'desktop-attach.js persist'),
  ];
  const reports = plans.map((entry) => report([entry]));
  reports.push(report([]));
  const calls = [];
  let doctorCalls = 0;
  const result = await runSetup(options({
    installClaudeCli: true,
    installCodexCli: true,
    signIn: true,
    startRuntime: true,
    relaunchDesktop: true,
    persistAttach: true,
  }), {}, {
    runDoctor: async () => reports[doctorCalls++],
    hostContext: HOST,
    narrate: (line) => calls.push(['narrate', line]),
    installers: {
      claude: async ({ command }) => calls.push(['install', 'claude', command]),
      codex: async ({ command }) => calls.push(['install', 'codex', command]),
    },
    signIn: {
      claude: async () => calls.push(['sign-in', 'claude']),
      codex: async () => calls.push(['sign-in', 'codex']),
    },
    ensureRuntime: async () => {
      calls.push(['runtime']);
      return { runtime: 'managed-daemon', state: 'started' };
    },
    desktopAttach: async ({ operation, args }) => calls.push(['desktop', operation, args]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(result.completed.length, plans.length);
  assert.equal(doctorCalls, plans.length + 1);
  assert.deepEqual(calls.filter(([kind]) => kind === 'install'), [
    ['install', 'claude', INSTALL_COMMANDS.claude],
    ['install', 'codex', INSTALL_COMMANDS.codex],
  ]);
  assert.deepEqual(calls.filter(([kind]) => kind === 'sign-in'), [
    ['sign-in', 'claude'],
    ['sign-in', 'codex'],
  ]);
  assert.deepEqual(calls.filter(([kind]) => kind === 'desktop'), [
    ['desktop', ACTIONS.attachDesktop, ['ensure']],
    ['desktop', ACTIONS.relaunchDesktop, ['ensure', '--relaunch-desktop']],
    ['desktop', ACTIONS.persistAttach, ['persist']],
  ]);
});

test('a fake TTY grants one interactive step only after the reason is printed', async () => {
  const planned = step('Sign in to Claude Code.', 'sign-in', 'claude auth login');
  const lines = [];
  const events = [];
  let doctorCalls = 0;
  const result = await runSetup(options(), {}, {
    runDoctor: async () => doctorCalls++ === 0 ? report([planned]) : report([]),
    hostContext: HOST,
    stdin: { isTTY: true },
    narrate: (line) => {
      lines.push(line);
      events.push('narrate');
    },
    confirm: async (received) => {
      assert.equal(received, planned);
      events.push('confirm');
      return true;
    },
    signIn: { claude: async () => events.push('sign-in') },
  });
  assert.equal(result.ok, true);
  assert.match(lines.join('\n'), /Why: Sign in to Claude Code\. is needed\./);
  assert.ok(events.indexOf('narrate') < events.indexOf('confirm'));
  assert.ok(events.indexOf('confirm') < events.indexOf('sign-in'));
});

test('setup refuses a consented step on a non-TTY without its exact flag', async () => {
  const planned = step('Install Codex.', 'install', '--install-codex-cli');
  let installed = false;
  const result = await runSetup(options(), {}, {
    runDoctor: async () => report([planned]),
    hostContext: HOST,
    stdin: { isTTY: false },
    narrate: () => {},
    installers: { codex: async () => { installed = true; } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'POLICY_REFUSAL');
  assert.equal(result.refusal.reason, 'consent-required');
  assert.equal(installed, false);
});

test('setup never replaces the CLI hosting the current session', async () => {
  for (const scenario of [
    { command: '--install-claude-cli', option: 'installClaudeCli', tool: 'claudeCode', provider: 'claude' },
    { command: '--install-codex-cli', option: 'installCodexCli', tool: 'codex', provider: 'codex' },
  ]) {
    const planned = step(`Install ${scenario.provider}.`, 'install', scenario.command);
    let installed = false;
    const result = await runSetup(options({ [scenario.option]: true }), {}, {
      runDoctor: async () => report([planned]),
      hostContext: { ...HOST, tools: { ...HOST.tools, [scenario.tool]: true } },
      narrate: () => {},
      installers: { [scenario.provider]: async () => { installed = true; } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.refusal.reason, 'hosting-cli-protected');
    assert.equal(installed, false);
  }
});

test('setup refuses a foreign runtime returned by the runtime ensure boundary', async () => {
  const planned = step('Start runtime.', 'start-runtime', 'runtime-up');
  const result = await runSetup(options({ startRuntime: true }), {}, {
    runDoctor: async () => report([planned]),
    hostContext: HOST,
    narrate: () => {},
    ensureRuntime: async () => ({ runtime: 'standalone-fallback', state: 'reused' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUNTIME_MISMATCH');
  assert.equal(result.refusal.reason, 'foreign-runtime');
});

test('setup never evaluates an unknown doctor command', async () => {
  const planned = step('Change an environment setting.', 'none', 'run-whatever-the-doctor-said');
  const result = await runSetup(options(), {}, {
    runDoctor: async () => report([planned]),
    hostContext: HOST,
    narrate: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.refusal.reason, 'manual-action-required');
});

test('setup option parsing and action recognition expose the six consent flags', () => {
  const parsed = parseSetupArgs([
    '--repo-root', REPO_ROOT,
    '--install-claude-cli', '--install-codex-cli', '--sign-in',
    '--start-runtime', '--relaunch-desktop', '--persist-attach',
  ], {});
  assert.equal(parsed.installClaudeCli, true);
  assert.equal(parsed.installCodexCli, true);
  assert.equal(parsed.signIn, true);
  assert.equal(parsed.startRuntime, true);
  assert.equal(parsed.relaunchDesktop, true);
  assert.equal(parsed.persistAttach, true);
  assert.equal(actionForStep(step('Persist.', 'persist-attach', 'desktop-attach.js persist')), ACTIONS.persistAttach);
  assert.throws(() => parseSetupArgs(['--repo-root', 'relative'], {}), /normalized absolute path/);
});

test('setup CLI help is side-effect free and umbrella-dispatchable', async () => {
  const direct = await runNodeScript('scripts/setup.js', ['--help']);
  assert.equal(direct.code, 0, direct.stderr);
  assert.match(direct.stdout, /^usage: setup\.js/);
  const umbrella = await runNodeScript('scripts/transmogrify.js', ['setup', '--help']);
  assert.equal(umbrella.code, 0, umbrella.stderr);
  assert.equal(umbrella.stdout, direct.stdout);
});
