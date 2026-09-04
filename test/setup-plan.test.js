'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  COMMANDS, IDE_CONTEXT, TERMINAL_CONTEXT, UNSUPPORTED_CONTEXT, computeSetupPlan,
} = require('../scripts/lib/setup-plan');

function host(app, surface = 'terminal', supported = true) {
  return {
    app,
    surface,
    platform: { os: supported ? 'darwin' : 'linux', arch: supported ? 'arm64' : 'x64', claudeLanesSupported: supported },
  };
}

function result(ownerActions, nativeVisibility) {
  return {
    setup: { ready: ownerActions.every((action) => !action.blocking), ownerActions },
    providers: { codex: nativeVisibility ? { nativeVisibility } : {} },
  };
}

test('fresh Apple Silicon Mac plan installs and signs in to both hosts before starting the runtime', () => {
  const plan = computeSetupPlan(result([
    { provider: 'claude', reason: 'cli-not-found', blocking: true, ownerAction: 'install Claude' },
    { provider: 'codex', reason: 'cli-not-found', blocking: true, ownerAction: 'install Codex' },
    { provider: 'codex', reason: 'runtime-unavailable', blocking: true, ownerAction: 'start runtime' },
  ]), host('shell'));
  assert.deepEqual(plan.steps, [
    { what: 'Install Claude Code.', why: 'Claude lanes need the Claude Code command-line tool.', consent: 'install', command: COMMANDS.installClaude },
    { what: 'Sign in to Claude Code.', why: 'Claude lanes run through your Claude account.', consent: 'sign-in', command: COMMANDS.signInClaude },
    { what: 'Install the Codex command-line tool.', why: 'Codex lanes need a compatible tool to host their shared runtime.', consent: 'install', command: COMMANDS.installCodex },
    { what: 'Sign in to Codex.', why: 'The Codex runtime needs your signed-in Codex account.', consent: 'sign-in', command: COMMANDS.signInCodex },
    { what: 'Start a compatible shared Codex runtime.', why: 'Codex lanes need a measured local runtime for reliable control.', consent: 'start-runtime', command: COMMANDS.startRuntime },
  ]);
});

test('a newer compatible Claude CLI adds no version action', () => {
  const plan = computeSetupPlan(result([]), host('claude-code-terminal'));
  assert.deepEqual(plan, { context: TERMINAL_CONTEXT, steps: [] });
});

test('an old Claude CLI is upgraded through setup and never downgraded', () => {
  const plan = computeSetupPlan(result([
    { provider: 'claude', reason: 'cli-outdated', blocking: true, ownerAction: 'upgrade' },
  ]), host('claude-code-terminal'));
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].consent, 'install');
  assert.equal(JSON.stringify(plan).includes('2.1.258'), false);
  assert.equal(JSON.stringify(plan).toLowerCase().includes('downgrade'), false);
});

test('an absent runtime is the next consented runtime action', () => {
  const plan = computeSetupPlan(result([
    { provider: 'codex', reason: 'runtime-unavailable', blocking: true, ownerAction: 'start it' },
  ]), host('claude-code-terminal'));
  assert.deepEqual(plan.steps, [{
    what: 'Start a compatible shared Codex runtime.',
    why: 'Codex lanes need a measured local runtime for reliable control.',
    consent: 'start-runtime',
    command: COMMANDS.startRuntime,
  }]);
});

test('a supported Desktop-bundled Codex tool is named as the runtime source', () => {
  const doctorResult = result([
    { provider: 'codex', reason: 'runtime-unavailable', blocking: true, ownerAction: 'start it' },
  ]);
  doctorResult.providers.codex.cliBinaries = [
    { source: 'path', supported: false },
    { source: 'desktop-bundled', supported: true },
  ];
  const plan = computeSetupPlan(doctorResult, host('claude-code-terminal'));
  assert.match(plan.steps[0].what, /bundled in the Codex app/);
});

test('an unattached Codex app from a Claude host explains streaming and relaunch consent', () => {
  const plan = computeSetupPlan(result([
    { provider: 'codex', reason: 'desktop-unattached', blocking: false, ownerAction: 'relaunch' },
  ]), host('claude-desktop', 'desktop'));
  assert.equal(plan.steps[0].consent, 'relaunch-desktop');
  assert.match(plan.steps[0].why, /Live lane updates/);
  assert.match(plan.steps[0].why, /ends what the app is doing now/);
});

test('Codex Desktop never receives a self-relaunch step', () => {
  const plan = computeSetupPlan(result([
    { provider: 'codex', reason: 'desktop-unattached', blocking: false, ownerAction: 'relaunch' },
  ]), host('codex-desktop', 'desktop'));
  assert.deepEqual(plan.steps, []);
  assert.match(plan.context, /cannot relaunch itself/);
  assert.match(plan.context, /collaboration/);
});

test('terminal, IDE, and unsupported hosts carry the required context sentence', () => {
  assert.equal(computeSetupPlan(result([]), host('codex-tui')).context, TERMINAL_CONTEXT);
  assert.equal(computeSetupPlan(result([]), host('cursor', 'ide')).context, IDE_CONTEXT);
  assert.equal(computeSetupPlan(result([]), host('shell', 'terminal', false)).context, UNSUPPORTED_CONTEXT);
});

test('the measured attachment state contributes a plan without rewriting owner actions', () => {
  const doctorResult = result([], {
    evidence: 'desktop-attachment:notRunning',
    nextAction: 'run-desktop-attach-ensure',
  });
  const before = structuredClone(doctorResult.setup.ownerActions);
  const plan = computeSetupPlan(doctorResult, host('claude-desktop', 'desktop'));
  assert.equal(plan.steps[0].command, COMMANDS.attachDesktop);
  assert.deepEqual(doctorResult.setup.ownerActions, before);
});

test('an explicitly non-persistent attachment adds one final consented persistence step', () => {
  const doctorResult = result([], {
    verified: true,
    evidence: 'codex-desktop-attached-to-selected-runtime',
    receipt: { persisted: false },
  });
  const plan = computeSetupPlan(doctorResult, host('claude-desktop', 'desktop'));
  assert.deepEqual(plan.steps, [{
    what: 'Keep the Codex app connected to the shared runtime after login.',
    why: 'Persistent attachment makes new Codex app sessions reuse the measured shared runtime automatically.',
    consent: 'persist-attach',
    command: COMMANDS.persistAttach,
  }]);
});

test('persistence is ordered after a required Desktop relaunch', () => {
  const doctorResult = result([
    { provider: 'codex', reason: 'desktop-unattached', blocking: false, ownerAction: 'relaunch' },
  ], {
    evidence: 'desktop-attachment:unattached',
    receipt: { persisted: false },
  });
  const plan = computeSetupPlan(doctorResult, host('claude-desktop', 'desktop'));
  assert.deepEqual(plan.steps.map((entry) => entry.consent), ['relaunch-desktop', 'persist-attach']);
});

test('an absent or true persistence receipt adds no persistence step', () => {
  const absent = result([], {
    verified: true,
    evidence: 'codex-desktop-attached-to-selected-runtime',
    receipt: {},
  });
  const persisted = result([], {
    verified: true,
    evidence: 'codex-desktop-attached-to-selected-runtime',
    receipt: { persisted: true },
  });
  assert.deepEqual(computeSetupPlan(absent, host('shell')).steps, []);
  assert.deepEqual(computeSetupPlan(persisted, host('shell')).steps, []);
});
