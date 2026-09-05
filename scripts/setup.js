#!/usr/bin/env node
'use strict';

// Execute the doctor's measured setup plan through a small allowlist. The
// command text in the plan is explanatory data, never a shell program: each
// recognized step maps to one fixed implementation below. After every action,
// the doctor measures the machine again before setup considers the step done.

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline/promises');
const { parseArgs } = require('node:util');
const { doctor, parseDoctorArgs } = require('./doctor');
const { detectHostContext } = require('./lib/host-context');
const { runtimeUrl } = require('./lib/codex-runtime');
const { publicResult } = require('./lib/output-schema');
const { ACTIONS: PLAN_ACTIONS } = require('./lib/setup-plan');
const {
  PUBLIC_ERROR_MESSAGES, exitCodeForError, publicErrorMessage,
} = require('./lib/public-error');
const { ensurePreferredRuntime } = require('./runtime-launch');

const HELP = `usage: setup.js --repo-root <absolute-path> [options]

Runs the doctor's setup plan one measured step at a time. A consented step
runs only with its matching flag or after an interactive yes on a TTY.

options:
  --dry-run              print the measured plan and perform no setup actions
  --install-claude-cli   authorize installing Claude Code for this run
  --install-codex-cli    authorize installing Codex CLI for this run
  --sign-in              authorize provider sign-in steps for this run
  --start-runtime        authorize starting an owned Codex runtime
  --relaunch-desktop     authorize relaunching Codex Desktop for attachment
  --persist-attach       authorize persistent Desktop attachment for login sessions
  --help                 print this help`;

const ACTIONS = Object.freeze({
  installClaude: 'install-claude',
  installCodex: 'install-codex',
  signInClaude: 'sign-in-claude',
  signInCodex: 'sign-in-codex',
  startRuntime: 'start-runtime',
  openApp: 'open-app',
  relaunchApp: 'relaunch-app',
  persistAttach: 'persist-attach',
});
const KNOWN_ACTIONS = new Set(PLAN_ACTIONS);

class SetupError extends Error {
  constructor(code, reason, step, message) {
    super(message || publicErrorMessage(code));
    this.code = code;
    this.reason = reason;
    this.step = step;
  }
}

function usage(message) {
  throw new SetupError('USAGE_ERROR', 'invalid-options', null, message);
}

function stableErrorCode(code) {
  return PUBLIC_ERROR_MESSAGES.has(code) ? code : 'OPERATOR_ERROR';
}

function parseSetupArgs(argv, env = process.env) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: HELP };
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        'repo-root': { type: 'string' },
        'dry-run': { type: 'boolean' },
        'install-claude-cli': { type: 'boolean' },
        'install-codex-cli': { type: 'boolean' },
        'sign-in': { type: 'boolean' },
        'start-runtime': { type: 'boolean' },
        'relaunch-desktop': { type: 'boolean' },
        'persist-attach': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    usage(error.message);
  }
  if (parsed.values.help) {
    if (argv.length !== 1) usage('--help cannot be combined with setup options');
    return { help: HELP };
  }
  const repoRoot = parsed.values['repo-root'] || env.REPO_ROOT;
  if (!repoRoot || !path.isAbsolute(repoRoot) || path.normalize(repoRoot) !== repoRoot) {
    usage('--repo-root or REPO_ROOT must be a normalized absolute path');
  }
  return {
    repoRoot,
    dryRun: parsed.values['dry-run'] === true,
    installClaudeCli: parsed.values['install-claude-cli'] === true,
    installCodexCli: parsed.values['install-codex-cli'] === true,
    signIn: parsed.values['sign-in'] === true,
    startRuntime: parsed.values['start-runtime'] === true,
    relaunchDesktop: parsed.values['relaunch-desktop'] === true,
    persistAttach: parsed.values['persist-attach'] === true,
  };
}

function runProcess(executable, args, env = process.env, dependencies = {}) {
  const launch = dependencies.spawn || spawn;
  return new Promise((resolve, reject) => {
    const child = launch(executable, args, { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`setup child ended by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`setup child exited ${code}`));
        return;
      }
      resolve({ code: 0 });
    });
  });
}

// Verified against the vendors' current official installation pages on
// 2026-09-04. Keep the URLs beside the commands so a future change is checked
// against the source instead of memory:
// https://code.claude.com/docs/en/getting-started
// https://learn.chatgpt.com/docs/codex/cli
const INSTALL_COMMANDS = Object.freeze({
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
  codex: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
});

async function installProvider(provider, env, dependencies) {
  const injected = dependencies.installers?.[provider];
  if (injected) return injected({ provider, command: INSTALL_COMMANDS[provider], env });
  return runProcess('/bin/bash', ['-o', 'pipefail', '-c', INSTALL_COMMANDS[provider]], env, dependencies);
}

async function signInProvider(provider, env, dependencies) {
  const injected = dependencies.signIn?.[provider] || dependencies.signInProvider;
  if (injected) return injected({ provider, env });
  const command = provider === 'claude' ? ['claude', ['auth', 'login']] : ['codex', ['login']];
  return runProcess(command[0], command[1], env, dependencies);
}

function runtimeOptions(binary, env = process.env, dependencies = {}) {
  // The same precedence every Codex command uses: TRANSMOGRIFY_URL, the live
  // relay record, then the legacy loopback port.
  const url = runtimeUrl({}, env, dependencies.runtimeUrlDependencies || dependencies);
  return {
    url,
    probe: path.join(__dirname, 'runtime-probe.js'),
    ...(binary ? { bin: binary } : {}),
    ...(env.TRANSMOGRIFY_LOG ? { log: env.TRANSMOGRIFY_LOG } : {}),
    ...(env.TRANSMOGRIFY_RELAY_PORT ? { relayPort: env.TRANSMOGRIFY_RELAY_PORT } : {}),
  };
}

async function startRuntime(step, env, dependencies) {
  const ensure = dependencies.ensureRuntime || ensurePreferredRuntime;
  return ensure(runtimeOptions(step.binary, env, dependencies), {
    ...dependencies.runtimeDependencies,
    env,
  });
}

async function runDesktopAttach(operation, env, dependencies) {
  const args = operation === ACTIONS.openApp
    ? ['ensure', '--launch-only']
    : operation === ACTIONS.relaunchApp
      ? ['ensure', '--relaunch-desktop']
      : ['persist', '--authorize'];
  if (dependencies.desktopAttach) return dependencies.desktopAttach({ operation, args, env });
  return runProcess(process.execPath, [path.join(__dirname, 'desktop-attach.js'), ...args], env, dependencies);
}

function flagAuthorizes(action, options) {
  if (action === ACTIONS.installClaude) return options.installClaudeCli;
  if (action === ACTIONS.installCodex) return options.installCodexCli;
  if ([ACTIONS.signInClaude, ACTIONS.signInCodex].includes(action)) return options.signIn;
  if (action === ACTIONS.startRuntime) return options.startRuntime;
  if (action === ACTIONS.relaunchApp) return options.relaunchDesktop;
  if (action === ACTIONS.persistAttach) return options.persistAttach;
  return action === ACTIONS.openApp;
}

function authorizationKey(action) {
  if ([ACTIONS.signInClaude, ACTIONS.signInCodex].includes(action)) return 'sign-in';
  return action;
}

function hostOwnsCli(action, hostContext) {
  return action === ACTIONS.installClaude && hostContext?.tools?.claudeCode === true ||
    action === ACTIONS.installCodex && hostContext?.tools?.codex === true;
}

async function interactiveConsent(step, dependencies = {}) {
  if (dependencies.confirm) return dependencies.confirm(step);
  const input = dependencies.stdin || process.stdin;
  const output = dependencies.promptOutput || process.stderr;
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question('Continue? [y/N] ');
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function stepReceipt(step, outcome) {
  return { what: step.what, consent: step.consent, outcome };
}

function appReadiness(report) {
  const statuses = report?.setup?.providers || {};
  return {
    claude: statuses.claude || 'needs-action',
    codex: statuses.codex || 'needs-action',
    nextSession: 'A new session in the other app picks up this setup.',
  };
}

async function inspect(options, env, dependencies) {
  if (dependencies.runDoctor) return dependencies.runDoctor({ ...options, target: 'all', explain: true }, env);
  const doctorOptions = parseDoctorArgs([
    '--repo-root', options.repoRoot, '--target', 'all', '--explain',
  ], env);
  return doctor(doctorOptions, env, dependencies.doctorDependencies || {});
}

function setupResult(report, options, completed, extra = {}) {
  const plan = report?.setup?.plan || { context: null, steps: [] };
  return publicResult({
    version: 1,
    ok: extra.ok ?? true,
    operation: 'setup',
    dryRun: options.dryRun,
    ready: report?.setup?.ready === true,
    outcome: report?.setup?.outcome || 'needs-action',
    providers: report?.setup?.providers || {},
    plan,
    completed,
    apps: appReadiness(report),
    ...extra,
  });
}

async function executeAction(action, step, env, dependencies) {
  if (action === ACTIONS.installClaude) return installProvider('claude', env, dependencies);
  if (action === ACTIONS.installCodex) return installProvider('codex', env, dependencies);
  if (action === ACTIONS.signInClaude) return signInProvider('claude', env, dependencies);
  if (action === ACTIONS.signInCodex) return signInProvider('codex', env, dependencies);
  if (action === ACTIONS.startRuntime) return startRuntime(step, env, dependencies);
  if ([ACTIONS.openApp, ACTIONS.relaunchApp, ACTIONS.persistAttach].includes(action)) {
    return runDesktopAttach(action, env, dependencies);
  }
  throw new SetupError('POLICY_REFUSAL', 'manual-action-required');
}

async function runSetup(options, env = process.env, dependencies = {}) {
  let report = await inspect(options, env, dependencies);
  const completed = [];
  if (options.dryRun) return setupResult(report, options, completed);
  const inspectHost = dependencies.detectHostContext || detectHostContext;
  const hostContext = dependencies.hostContext || inspectHost(env, dependencies.hostContextDependencies || {});
  const narration = dependencies.narrate || ((line) => console.error(line));
  const input = dependencies.stdin || process.stdin;
  const interactive = input.isTTY === true;
  const consumedFlags = new Set();

  for (let count = 0; count < 20; count += 1) {
    const step = report?.setup?.plan?.steps?.[0];
    if (!step) return setupResult(report, options, completed);
    const action = step?.action;
    if (!KNOWN_ACTIONS.has(action)) {
      return setupResult(report, options, completed, {
        ok: false,
        code: 'POLICY_REFUSAL',
        message: publicErrorMessage('POLICY_REFUSAL'),
        refusal: { what: step.what, consent: step.consent, reason: 'manual-action-required' },
      });
    }
    if (hostOwnsCli(action, hostContext)) {
      return setupResult(report, options, completed, {
        ok: false,
        code: 'POLICY_REFUSAL',
        message: publicErrorMessage('POLICY_REFUSAL'),
        refusal: { what: step.what, consent: step.consent, reason: 'hosting-cli-protected' },
      });
    }

    narration(step.what);
    narration(`Why: ${step.why}`);
    const key = authorizationKey(action);
    let authorized = step.consent === 'none';
    if (!authorized && flagAuthorizes(action, options) && !consumedFlags.has(key)) {
      authorized = true;
      consumedFlags.add(key);
    }
    if (!authorized && interactive) authorized = await interactiveConsent(step, dependencies);
    if (!authorized) {
      if (completed.length > 0) return setupResult(report, options, completed);
      return setupResult(report, options, completed, {
        ok: false,
        code: 'POLICY_REFUSAL',
        message: publicErrorMessage('POLICY_REFUSAL'),
        refusal: { what: step.what, consent: step.consent, reason: 'consent-required' },
      });
    }

    try {
      await executeAction(action, step, env, dependencies);
    } catch (error) {
      const coded = error instanceof SetupError ? error : new SetupError(
        stableErrorCode(error?.code), 'step-failed', step,
      );
      return setupResult(report, options, completed, {
        ok: false,
        code: coded.code,
        message: publicErrorMessage(coded.code),
        refusal: { what: step.what, consent: step.consent, reason: coded.reason },
      });
    }
    completed.push(stepReceipt(step, 'confirmed'));
    const previous = `${step.action}\0${step.binary || ''}`;
    report = await inspect(options, env, dependencies);
    const next = report?.setup?.plan?.steps?.[0];
    if (next && `${next.action}\0${next.binary || ''}` === previous) {
      return setupResult(report, options, completed, {
        ok: false,
        code: 'PROVIDER_UNAVAILABLE',
        message: publicErrorMessage('PROVIDER_UNAVAILABLE'),
        refusal: { what: next.what, consent: next.consent, reason: 'step-not-verified' },
      });
    }
    if (!interactive) return setupResult(report, options, completed);
  }
  return setupResult(report, options, completed, {
    ok: false,
    code: 'OPERATOR_ERROR',
    message: publicErrorMessage('OPERATOR_ERROR'),
  });
}

async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const options = parseSetupArgs(argv, env);
  if (options.help) return options;
  return runSetup(options, env, dependencies);
}

if (require.main === module) {
  main().then((result) => {
    if (result?.help) {
      console.log(result.help);
      return;
    }
    const serialized = JSON.stringify(result, null, 2);
    if (result.ok) {
      console.log(serialized);
    } else {
      console.error(serialized);
      process.exitCode = exitCodeForError(result.code);
    }
  }).catch((error) => {
    const code = stableErrorCode(error?.code);
    console.error(JSON.stringify({
      version: 1,
      ok: false,
      operation: 'setup',
      code,
      message: code === 'USAGE_ERROR' ? error.message : publicErrorMessage(code),
    }, null, 2));
    process.exitCode = exitCodeForError(code);
  });
}

module.exports = {
  ACTIONS,
  HELP,
  INSTALL_COMMANDS,
  SetupError,
  appReadiness,
  main,
  parseSetupArgs,
  runSetup,
  runtimeOptions,
};
