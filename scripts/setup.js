#!/usr/bin/env node
'use strict';

// Execute the doctor's measured setup plan through a small allowlist. The
// command text in the plan is explanatory data, never a shell program: each
// recognized step maps to one fixed implementation below. After every action,
// the doctor measures the machine again before setup considers the step done.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline/promises');
const { parseArgs } = require('node:util');
const { doctor, parseDoctorArgs } = require('./doctor');
const { detectHostContext } = require('./lib/host-context');
const { publicResult } = require('./lib/output-schema');
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
  attachDesktop: 'attach-desktop',
  relaunchDesktop: 'relaunch-desktop',
  persistAttach: 'persist-attach',
});

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

function executableOnPath(name, env = process.env) {
  for (const directory of String(env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {}
  }
  return null;
}

function runtimeOptions(env = process.env) {
  const url = env.TRANSMOGRIFY_URL || `ws://127.0.0.1:${env.TRANSMOGRIFY_PORT || '8843'}`;
  const managedFallback = path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'),
    'packages', 'standalone', 'current', 'codex');
  let bin = env.TRANSMOGRIFY_BIN || executableOnPath('codex', env);
  if (!bin && fs.existsSync(managedFallback)) bin = managedFallback;
  return {
    url,
    probe: path.join(__dirname, 'runtime-probe.js'),
    ...(bin ? { bin } : {}),
    ...(env.TRANSMOGRIFY_LOG ? { log: env.TRANSMOGRIFY_LOG } : {}),
    ...(env.TRANSMOGRIFY_RELAY_PORT ? { relayPort: env.TRANSMOGRIFY_RELAY_PORT } : {}),
  };
}

async function startRuntime(env, dependencies) {
  const ensure = dependencies.ensureRuntime || ensurePreferredRuntime;
  const result = await ensure(runtimeOptions(env), { ...dependencies.runtimeDependencies, env });
  const foreign = result?.owned === false ||
    (result?.runtime === 'standalone-fallback' && ['reused', 'race-reused'].includes(result.state));
  if (foreign) {
    throw new SetupError(
      'RUNTIME_MISMATCH',
      'foreign-runtime',
      null,
      'a compatible runtime appeared, but this setup did not start it',
    );
  }
  return result;
}

async function runDesktopAttach(operation, env, dependencies) {
  const args = operation === ACTIONS.attachDesktop
    ? ['ensure']
    : operation === ACTIONS.relaunchDesktop
      ? ['ensure', '--relaunch-desktop']
      : ['persist'];
  if (dependencies.desktopAttach) return dependencies.desktopAttach({ operation, args, env });
  return runProcess(process.execPath, [path.join(__dirname, 'desktop-attach.js'), ...args], env, dependencies);
}

function actionForStep(step) {
  const command = String(step?.command || '');
  if (step?.consent === 'install' && command.includes('--install-claude-cli')) return ACTIONS.installClaude;
  if (step?.consent === 'install' && command.includes('--install-codex-cli')) return ACTIONS.installCodex;
  if (step?.consent === 'sign-in' && /^claude\s+auth\s+login(?:\s|$)/.test(command)) return ACTIONS.signInClaude;
  if (step?.consent === 'sign-in' && /^codex\s+login(?:\s|$)/.test(command)) return ACTIONS.signInCodex;
  if (step?.consent === 'start-runtime') return ACTIONS.startRuntime;
  if (step?.consent === 'relaunch-desktop') return ACTIONS.relaunchDesktop;
  if (step?.consent === 'persist-attach' || command.includes('desktop-attach.js') && /\bpersist\b/.test(command)) {
    return ACTIONS.persistAttach;
  }
  if (step?.consent === 'none' && command.includes('desktop-attach.js') && /\bensure\b/.test(command)) {
    return ACTIONS.attachDesktop;
  }
  return null;
}

function flagAuthorizes(action, options) {
  if (action === ACTIONS.installClaude) return options.installClaudeCli;
  if (action === ACTIONS.installCodex) return options.installCodexCli;
  if ([ACTIONS.signInClaude, ACTIONS.signInCodex].includes(action)) return options.signIn;
  if (action === ACTIONS.startRuntime) return options.startRuntime;
  if (action === ACTIONS.relaunchDesktop) return options.relaunchDesktop;
  if (action === ACTIONS.persistAttach) return options.persistAttach;
  return action === ACTIONS.attachDesktop;
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
  const claudeReady = report?.providers?.claude?.reusable === true;
  const codexReady = report?.providers?.codex?.reusable === true;
  const live = report?.providers?.codex?.nativeVisibility?.verified === true;
  return {
    claude: claudeReady ? 'ready' : 'needs setup',
    codex: codexReady ? (live ? 'ready with live app updates' : 'ready without live app updates') : 'needs setup',
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
    ready: report?.setup?.ready === true && plan.steps.length === 0,
    plan,
    completed,
    apps: appReadiness(report),
    ...extra,
  });
}

async function executeAction(action, env, dependencies) {
  if (action === ACTIONS.installClaude) return installProvider('claude', env, dependencies);
  if (action === ACTIONS.installCodex) return installProvider('codex', env, dependencies);
  if (action === ACTIONS.signInClaude) return signInProvider('claude', env, dependencies);
  if (action === ACTIONS.signInCodex) return signInProvider('codex', env, dependencies);
  if (action === ACTIONS.startRuntime) return startRuntime(env, dependencies);
  if ([ACTIONS.attachDesktop, ACTIONS.relaunchDesktop, ACTIONS.persistAttach].includes(action)) {
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

  for (let count = 0; count < 20; count += 1) {
    const step = report?.setup?.plan?.steps?.[0];
    if (!step) return setupResult(report, options, completed);
    const action = actionForStep(step);
    if (!action) {
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
    let authorized = flagAuthorizes(action, options);
    const input = dependencies.stdin || process.stdin;
    if (!authorized && input.isTTY === true) authorized = await interactiveConsent(step, dependencies);
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
      await executeAction(action, env, dependencies);
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
    const previous = `${step.what}\0${step.command}`;
    report = await inspect(options, env, dependencies);
    const next = report?.setup?.plan?.steps?.[0];
    if (next && `${next.what}\0${next.command}` === previous) {
      return setupResult(report, options, completed, {
        ok: false,
        code: 'PROVIDER_UNAVAILABLE',
        message: publicErrorMessage('PROVIDER_UNAVAILABLE'),
        refusal: { what: next.what, consent: next.consent, reason: 'step-not-verified' },
      });
    }
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
  actionForStep,
  appReadiness,
  main,
  parseSetupArgs,
  runSetup,
  runtimeOptions,
};
