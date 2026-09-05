'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTIONS, parseSetupArgs, runSetup } = require('../scripts/setup');
const { ACTIONS: PLAN_ACTIONS } = require('../scripts/lib/setup-plan');
const { parseCli } = require('../scripts/desktop-attach');
const { runNodeScript } = require('./helpers/run-cli');
const { REPO_ROOT, codexBinary, doctorReport, host } = require('./helpers/onboarding-fixture');

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

function doctorSequence(reports) {
  let index = 0;
  return async () => reports[Math.min(index++, reports.length - 1)];
}

test('setup dry-run returns the real doctor plan without invoking an action', async (t) => {
  const measured = await doctorReport(t, { claudeReason: 'cli-not-found' });
  let actions = 0;
  const result = await runSetup(options({ dryRun: true }), {}, {
    runDoctor: doctorSequence([measured]),
    hostContext: host(),
    installers: { claude: async () => { actions += 1; } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.outcome, 'needs-action');
  assert.deepEqual(result.plan, measured.setup.plan);
  assert.deepEqual(result.completed, []);
  assert.equal(actions, 0);
});

test('two provider sign-ins require two non-interactive setup invocations', async (t) => {
  const binary = codexBinary(t, { signedIn: false });
  const both = await doctorReport(t, {
    claudeReason: 'not-logged-in', codexRuntime: 'unavailable', codexBinaries: [binary],
  });
  const codexOnly = await doctorReport(t, {
    codexRuntime: 'unavailable', codexBinaries: [binary],
  });
  const ready = await doctorReport(t);
  const calls = [];
  const dependencies = {
    hostContext: host(), stdin: { isTTY: false }, narrate: () => {},
    signIn: {
      claude: async () => calls.push('claude'),
      codex: async () => calls.push('codex'),
    },
  };
  const first = await runSetup(options({ signIn: true }), {}, {
    ...dependencies, runDoctor: doctorSequence([both, codexOnly]),
  });
  assert.deepEqual(calls, ['claude']);
  assert.equal(first.completed.length, 1);
  assert.equal(first.plan.steps[0].action, 'sign-in-codex');

  const second = await runSetup(options({ signIn: true }), {}, {
    ...dependencies, runDoctor: doctorSequence([codexOnly, ready]),
  });
  assert.deepEqual(calls, ['claude', 'codex']);
  assert.equal(second.completed.length, 1);
});

test('a non-interactive invocation performs only the first matching action', async (t) => {
  const before = await doctorReport(t, { claudeReason: 'cli-not-found' });
  const afterInstall = await doctorReport(t, { claudeReason: 'not-logged-in' });
  const calls = [];
  const result = await runSetup(options({ installClaudeCli: true, signIn: true }), {}, {
    runDoctor: doctorSequence([before, afterInstall]),
    hostContext: host(), stdin: { isTTY: false }, narrate: () => {},
    installers: { claude: async () => calls.push('install') },
    signIn: { claude: async () => calls.push('sign-in') },
  });
  assert.deepEqual(calls, ['install']);
  assert.equal(result.completed.length, 1);
  assert.equal(result.plan.steps[0].action, 'sign-in-claude');
});

test('an interactive terminal asks separately before consecutive actions', async (t) => {
  const before = await doctorReport(t, { claudeReason: 'cli-not-found' });
  const afterInstall = await doctorReport(t, { claudeReason: 'not-logged-in' });
  const ready = await doctorReport(t);
  const confirmations = [];
  const calls = [];
  const result = await runSetup(options(), {}, {
    runDoctor: doctorSequence([before, afterInstall, ready]),
    hostContext: host(), stdin: { isTTY: true }, narrate: () => {},
    confirm: async (step) => { confirmations.push(step.action); return true; },
    installers: { claude: async () => calls.push('install') },
    signIn: { claude: async () => calls.push('sign-in') },
  });
  assert.deepEqual(confirmations, ['install-claude', 'sign-in-claude']);
  assert.deepEqual(calls, ['install', 'sign-in']);
  assert.equal(result.completed.length, 2);
});

test('setup dispatches on action and never evaluates the display command', async (t) => {
  const measured = await doctorReport(t, { claudeReason: 'not-logged-in' });
  measured.setup.plan.steps[0].command = 'do-not-run-this';
  let signedIn = false;
  await runSetup(options({ signIn: true }), {}, {
    runDoctor: doctorSequence([measured, await doctorReport(t)]),
    hostContext: host(), stdin: { isTTY: false }, narrate: () => {},
    signIn: { claude: async () => { signedIn = true; } },
  });
  assert.equal(signedIn, true);

  const unknown = structuredClone(measured);
  unknown.setup.plan.steps[0].action = 'unknown-action';
  const refused = await runSetup(options({ signIn: true }), {}, {
    runDoctor: doctorSequence([unknown]), hostContext: host(), stdin: { isTTY: false }, narrate: () => {},
  });
  assert.equal(refused.refusal.reason, 'manual-action-required');
});

test('start-runtime receives the doctor-selected binary and accepts a compatible race winner', async (t) => {
  const binary = codexBinary(t);
  const absent = await doctorReport(t, { codexRuntime: 'unavailable', codexBinaries: [binary] });
  const reusable = await doctorReport(t);
  let received;
  const result = await runSetup(options({ startRuntime: true }), {}, {
    runDoctor: doctorSequence([absent, reusable]),
    hostContext: host(), stdin: { isTTY: false }, narrate: () => {},
    runtimeUrlDependencies: { activeRelayUrl: () => null },
    ensureRuntime: async (runtimeOptions) => {
      received = runtimeOptions;
      return { runtime: 'standalone-fallback', state: 'race-reused' };
    },
  });
  assert.equal(received.bin, binary.path);
  assert.equal(received.url, 'ws://127.0.0.1:8843');
  assert.equal(result.ok, true);
  assert.equal(result.providers.codex, 'ready');
});

test('Desktop actions use CLI arguments accepted by the real parser', async (t) => {
  const cases = [
    {
      before: await doctorReport(t, { desktopState: 'notRunning', host: host('shell') }),
      option: {}, action: ACTIONS.openApp, expected: { operation: 'ensure', launchOnly: true, relaunch: false },
    },
    {
      before: await doctorReport(t, { desktopState: 'unattached', host: host('claude-desktop', 'desktop') }),
      option: { relaunchDesktop: true }, action: ACTIONS.relaunchApp,
      expected: { operation: 'ensure', launchOnly: false, relaunch: true },
    },
    {
      before: await doctorReport(t, { persisted: false, host: host('claude-desktop', 'desktop') }),
      option: { persistAttach: true }, action: ACTIONS.persistAttach,
      expected: { operation: 'persist', authorize: true },
    },
  ];
  for (const scenario of cases) {
    let parsed;
    const result = await runSetup(options(scenario.option), {}, {
      runDoctor: doctorSequence([scenario.before, await doctorReport(t)]),
      hostContext: host('claude-desktop', 'desktop'), stdin: { isTTY: false }, narrate: () => {},
      desktopAttach: async ({ operation, args }) => {
        assert.equal(operation, scenario.action);
        parsed = parseCli(args);
      },
    });
    assert.equal(result.ok, true);
    for (const [key, value] of Object.entries(scenario.expected)) assert.equal(parsed[key], value);
  }
});

test('setup refuses to replace the CLI hosting the current session', async (t) => {
  const measured = await doctorReport(t, {
    claudeReason: 'cli-unsupported', host: host('claude-code-terminal', 'terminal', true, { claudeCode: true }),
  });
  let installed = false;
  const result = await runSetup(options({ installClaudeCli: true }), {}, {
    runDoctor: doctorSequence([measured]),
    hostContext: host('claude-code-terminal', 'terminal', true, { claudeCode: true }),
    stdin: { isTTY: false }, narrate: () => {},
    installers: { claude: async () => { installed = true; } },
  });
  assert.equal(result.refusal.reason, 'hosting-cli-protected');
  assert.equal(installed, false);
});

test('setup outcome and provider statuses mirror the doctor summary state', async (t) => {
  const measured = await doctorReport(t, {
    claudeReason: 'unsupported-platform', host: host('shell', 'terminal', false),
  });
  const result = await runSetup(options({ dryRun: true }), {}, {
    runDoctor: doctorSequence([measured]), hostContext: host('shell', 'terminal', false),
  });
  assert.equal(result.ready, measured.setup.ready);
  assert.equal(result.outcome, measured.setup.outcome);
  assert.deepEqual(result.providers, measured.setup.providers);
});

test('setup option parsing exposes the six consent flags', () => {
  assert.deepEqual(new Set(Object.values(ACTIONS)), new Set(PLAN_ACTIONS));
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
