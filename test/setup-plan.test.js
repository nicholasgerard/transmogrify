'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTIONS, IDE_CONTEXT, TERMINAL_CONTEXT, UNSUPPORTED_CONTEXT } = require('../scripts/lib/setup-plan');
const { renderSetupSummary } = require('../scripts/doctor');
const { runSetup } = require('../scripts/setup');
const { REPO_ROOT, codexBinary, doctorReport, host } = require('./helpers/onboarding-fixture');

function planFor(result) {
  return result.setup?.plan || result.plan;
}

function actionNames(result) {
  return planFor(result).steps.map((step) => step.action);
}

async function throughSetup(report) {
  return runSetup({
    repoRoot: REPO_ROOT, dryRun: true,
    installClaudeCli: false, installCodexCli: false, signIn: false,
    startRuntime: false, relaunchDesktop: false, persistAttach: false,
  }, {}, { runDoctor: async () => report });
}

test('acceptance: fresh machine plans both provider installations and sign-ins', async (t) => {
  const binary = codexBinary(t, { signedIn: false });
  const fresh = await doctorReport(t, {
    claudeReason: 'cli-not-found', codexRuntime: 'unavailable', codexBinaries: [],
  });
  const claudeInstalled = await doctorReport(t, {
    claudeReason: 'not-logged-in', codexRuntime: 'unavailable', codexBinaries: [],
  });
  const claudeSignedIn = await doctorReport(t, {
    codexRuntime: 'unavailable', codexBinaries: [],
  });
  const codexInstalled = await doctorReport(t, {
    codexRuntime: 'unavailable', codexBinaries: [binary],
  });
  const codexSignedIn = await doctorReport(t, {
    codexRuntime: 'unavailable', codexBinaries: [{ ...binary, signedIn: true }],
  });
  const ready = await doctorReport(t);
  const result = await throughSetup(fresh);
  assert.deepEqual(actionNames(result), [
    'install-claude', 'sign-in-claude', 'install-codex', 'sign-in-codex',
  ]);
  assert.equal(result.outcome, 'needs-action');
  assert.match(result.plan.context, /Claude Desktop and the ChatGPT app/);

  const calls = [];
  const runOne = (authorization, before, after) => runSetup({
    repoRoot: REPO_ROOT, dryRun: false,
    installClaudeCli: false, installCodexCli: false, signIn: false,
    startRuntime: false, relaunchDesktop: false, persistAttach: false,
    ...authorization,
  }, {}, {
    runDoctor: (() => { let count = 0; return async () => count++ === 0 ? before : after; })(),
    hostContext: host(), stdin: { isTTY: false }, narrate: () => {},
    runtimeUrlDependencies: { activeRelayUrl: () => null },
    installers: {
      claude: async () => calls.push('install-claude'),
      codex: async () => calls.push('install-codex'),
    },
    signIn: {
      claude: async () => calls.push('sign-in-claude'),
      codex: async () => calls.push('sign-in-codex'),
    },
    ensureRuntime: async (runtime) => { calls.push(`start-runtime:${runtime.bin}`); },
  });
  await runOne({ installClaudeCli: true }, fresh, claudeInstalled);
  await runOne({ signIn: true }, claudeInstalled, claudeSignedIn);
  await runOne({ installCodexCli: true }, claudeSignedIn, codexInstalled);
  await runOne({ signIn: true }, codexInstalled, codexSignedIn);
  await runOne({ startRuntime: true }, codexSignedIn, ready);
  assert.deepEqual(calls, [
    'install-claude', 'sign-in-claude', 'install-codex', 'sign-in-codex',
    `start-runtime:${binary.path}`,
  ]);
});

test('acceptance: a newer Claude CLI is measured without a version action', async (t) => {
  const report = await doctorReport(t, { claudeMeasurement: { cliVersion: '2.2.0' } });
  const result = await throughSetup(report);
  assert.deepEqual(report.providers.claude.observed.buildMeasurement, {
    result: 'good', source: 'live-probe', measuredAt: '2026-09-05T12:00:00.000Z',
  });
  assert.equal(actionNames(result).some((action) => action === 'install-claude'), false);
  assert.equal(JSON.stringify(result.plan).includes('2.2.0'), false);
});

test('acceptance: an older hosting Claude CLI requests an upgrade and never a downgrade', async (t) => {
  const report = await doctorReport(t, {
    claudeReason: 'cli-unsupported', host: host('claude-code-terminal', 'terminal', true, { claudeCode: true }),
  });
  const result = await throughSetup(report);
  assert.equal(result.plan.steps[0].action, 'install-claude');
  assert.equal(JSON.stringify(result.plan).toLowerCase().includes('downgrade'), false);
});

test('acceptance: a bundled supported Codex binary is selected over an older PATH binary', async (t) => {
  const older = codexBinary(t, { version: '0.148.0', source: 'PATH' });
  const bundled = codexBinary(t, { version: '0.155.0', source: 'codex-desktop' });
  const report = await doctorReport(t, {
    codexRuntime: 'unavailable', codexBinaries: [older, bundled],
  });
  const result = await throughSetup(report);
  const step = result.plan.steps.find((entry) => entry.action === 'start-runtime');
  assert.equal(step.binary, bundled.path);
  assert.match(step.what, /bundled in the Codex app/);
  assert.deepEqual(report.providers.codex.cliBinaries.map((entry) => entry.supported), [false, true]);
});

test('acceptance: an absent runtime distinguishes missing, signed-out, and startable states', async (t) => {
  const signedOut = codexBinary(t, { signedIn: false });
  const signedIn = codexBinary(t, { signedIn: true });
  const unreadableLogin = codexBinary(t, { signedIn: null });
  const unreadableVersion = codexBinary(t, { version: 'unreadable' });
  const missing = await doctorReport(t, { codexRuntime: 'unavailable', codexBinaries: [] });
  const loggedOut = await doctorReport(t, { codexRuntime: 'unavailable', codexBinaries: [signedOut] });
  const startable = await doctorReport(t, { codexRuntime: 'unavailable', codexBinaries: [signedIn] });
  const unknown = await doctorReport(t, { codexRuntime: 'unavailable', codexBinaries: [unreadableLogin] });
  const unknownVersion = await doctorReport(t, { codexRuntime: 'unavailable', codexBinaries: [unreadableVersion] });
  const [missingResult, loggedOutResult, startableResult, unknownResult] = await Promise.all([
    throughSetup(missing), throughSetup(loggedOut), throughSetup(startable), throughSetup(unknown),
  ]);
  assert.equal(missing.providers.codex.runtime.supportedBinaryAvailable, false);
  assert.deepEqual(actionNames(missingResult).filter((action) => action.startsWith('install-codex')), ['install-codex']);
  assert.equal(loggedOut.providers.codex.runtime.accountSignedIn, false);
  assert.equal(loggedOutResult.plan.steps.find((step) => step.action.startsWith('sign-in-codex')).action, 'sign-in-codex');
  assert.equal(startable.providers.codex.runtime.accountSignedIn, true);
  assert.equal(startableResult.plan.steps.find((step) => step.action === 'start-runtime').binary, signedIn.path);
  assert.equal(unknown.providers.codex.runtime.accountSignedIn, null);
  assert.ok(unknownResult.plan.steps.some((step) => step.action === 'start-runtime'));
  assert.equal(unknownVersion.providers.codex.cliBinaries[0].supported, null);
  assert.equal(unknownVersion.providers.codex.runtime.supportedBinaryAvailable, false);
});

test('acceptance: an unattached Desktop from a Claude host explains relaunch and fallback', async (t) => {
  const report = await doctorReport(t, {
    desktopState: 'unattached', host: host('claude-desktop', 'desktop'),
  });
  const result = await throughSetup(report);
  const step = result.plan.steps.find((entry) => entry.action === 'relaunch-app');
  assert.equal(step.consent, 'relaunch-desktop');
  assert.match(step.why, /live lane updates/i);
  assert.match(step.why, /protocol-only/);
});

test('acceptance: Codex Desktop is never offered a self-relaunch', async (t) => {
  const report = await doctorReport(t, {
    desktopState: 'unattached', host: host('codex-desktop', 'desktop'),
  });
  const result = await throughSetup(report);
  assert.equal(actionNames(result).includes('relaunch-app'), false);
  assert.match(result.plan.context, /own collaboration/);
});

test('acceptance: terminal hosts receive the terminal notice and full provider plan', async (t) => {
  const report = await doctorReport(t, {
    claudeReason: 'not-logged-in', codexRuntime: 'unavailable', codexBinaries: [],
    host: host('codex-tui'),
  });
  const result = await throughSetup(report);
  assert.equal(result.plan.context, TERMINAL_CONTEXT);
  assert.ok(actionNames(result).includes('sign-in-claude'));
  assert.ok(actionNames(result).includes('install-codex'));
});

test('acceptance: IDE hosts keep setup but never receive Desktop actions', async (t) => {
  const report = await doctorReport(t, {
    claudeReason: 'cli-not-found', desktopState: 'notRunning', persisted: false,
    host: host('cursor', 'ide'),
  });
  const result = await throughSetup(report);
  assert.equal(result.plan.context, IDE_CONTEXT);
  assert.ok(actionNames(result).includes('install-claude'));
  assert.equal(actionNames(result).some((action) => ['open-app', 'relaunch-app', 'persist-attach'].includes(action)), false);
});

test('acceptance: unsupported Claude platforms skip Claude actions and retain Codex', async (t) => {
  const report = await doctorReport(t, {
    claudeReason: 'unsupported-platform', host: host('shell', 'terminal', false),
  });
  const result = await throughSetup(report);
  assert.equal(result.plan.context, UNSUPPORTED_CONTEXT);
  assert.equal(actionNames(result).some((action) => action.includes('claude')), false);
  assert.equal(result.providers.claude, 'unsupported');
  assert.equal(result.providers.codex, 'ready');
  assert.equal(result.outcome, 'ready-with-limitations');
  assert.equal(result.ready, true);
});

test('typed plans use only the fixed action vocabulary and explain declining', async (t) => {
  const binary = codexBinary(t);
  const reports = [
    await doctorReport(t, { claudeReason: 'cli-not-found', codexRuntime: 'unavailable', codexBinaries: [binary] }),
    await doctorReport(t, { desktopState: 'unattached', persisted: false, host: host('claude-desktop', 'desktop') }),
  ];
  for (const step of reports.flatMap((report) => report.setup.plan.steps)) {
    assert.ok(ACTIONS.includes(step.action));
    assert.match(step.why, /declining/i);
  }
});

test('persistence uses the top-level receipt and is ordered after relaunch', async (t) => {
  const attached = await doctorReport(t, { persisted: false, host: host('claude-desktop', 'desktop') });
  assert.deepEqual(actionNames(attached), ['persist-attach']);
  assert.match(attached.setup.plan.steps[0].command, /persist --authorize$/);

  const unattached = await doctorReport(t, {
    desktopState: 'unattached', persisted: false, host: host('claude-desktop', 'desktop'),
  });
  assert.deepEqual(actionNames(unattached), ['relaunch-app']);
});

test('a stopped installed Desktop opens only after a reusable runtime', async (t) => {
  const report = await doctorReport(t, { desktopState: 'notRunning', host: host('shell') });
  assert.deepEqual(actionNames(report), ['open-app']);
  assert.match(report.setup.plan.steps[0].command, /ensure --launch-only$/);
  const binary = codexBinary(t);
  const absent = await doctorReport(t, {
    codexRuntime: 'unavailable', codexBinaries: [binary], desktopState: 'notRunning', host: host('shell'),
  });
  assert.equal(actionNames(absent).includes('open-app'), false);
});

test('acceptance matrix summaries agree with setup JSON outcomes', async (t) => {
  const binary = codexBinary(t);
  const reports = [
    await doctorReport(t, { claudeReason: 'cli-not-found', codexRuntime: 'unavailable', codexBinaries: [] }),
    await doctorReport(t, { claudeMeasurement: { cliVersion: '2.2.0' } }),
    await doctorReport(t, { claudeReason: 'cli-unsupported', host: host('claude-code-terminal') }),
    await doctorReport(t, { codexRuntime: 'unavailable', codexBinaries: [binary] }),
    await doctorReport(t, { desktopState: 'unattached', host: host('claude-desktop', 'desktop') }),
    await doctorReport(t, { desktopState: 'unattached', host: host('codex-desktop', 'desktop') }),
    await doctorReport(t, { host: host('codex-tui') }),
    await doctorReport(t, { desktopState: 'notRunning', host: host('cursor', 'ide') }),
    await doctorReport(t, { claudeReason: 'unsupported-platform', host: host('shell', 'terminal', false) }),
  ];
  for (const report of reports) {
    const result = await throughSetup(report);
    const summary = renderSetupSummary(report);
    assert.equal(summary.split('\n').length, 4);
    assert.equal(result.outcome, report.setup.outcome);
    assert.equal(result.ready, report.setup.ready);
    assert.deepEqual(result.providers, report.setup.providers);
    if (result.outcome === 'needs-action' && result.plan.steps[0]) {
      assert.ok(summary.includes(result.plan.steps[0].what));
    }
    if (result.providers.claude === 'unsupported') assert.match(summary, /Claude lanes are unavailable/);
  }
});
