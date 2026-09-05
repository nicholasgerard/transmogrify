import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, type TestContext } from 'node:test';

import { renderStart } from '../scripts/build-start.mjs';
import setupPlan from '../../scripts/lib/setup-plan.js';

const { IDE_CONTEXT, TERMINAL_CONTEXT, UNSUPPORTED_CONTEXT } = setupPlan;

function renderedPrerequisiteBlock() {
  const source = renderStart({ releaseCommit: '1'.repeat(40), version: '0.2.0' });
  const firstBashBlock = /```bash\n([\s\S]*?)\n\s*```/.exec(source);
  assert.ok(firstBashBlock, 'the generated handoff has a prerequisite shell block');
  return firstBashBlock[1].replace(/^ {3}/gm, '');
}

function executable(file: string, body = '#!/bin/sh\nexit 0\n') {
  writeFileSync(file, body, { mode: 0o700 });
}

function runPrerequisites(t: TestContext, options: {
  cwd: string;
  commands?: Record<string, string>;
}) {
  const fixture = mkdtempSync(join(tmpdir(), 'transmogrify-start-prerequisites-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const bin = join(fixture, 'bin');
  const marker = join(fixture, 'preparation-reached');
  if (options.commands) {
    mkdirSync(bin, { mode: 0o700 });
    for (const [name, body] of Object.entries(options.commands)) executable(join(bin, name), body);
  }
  const result = spawnSync('/bin/bash', ['-c', [
    renderedPrerequisiteBlock(),
    'printf reached > "$PREPARATION_MARKER"',
  ].join('\n')], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: options.commands ? bin : process.env.PATH,
      PREPARATION_MARKER: marker,
    },
  });
  return { result, preparationReached: existsSync(marker) };
}

describe('renderStart', () => {
  test('disables installation when no public release commit is configured', () => {
    const source = renderStart({ releaseCommit: '', version: '0.2.0' });
    assert.match(source, /not published yet/);
    assert.doesNotMatch(source, /git\s+(?:clone|fetch)/);
  });

  test('pins, verifies, reports, and installs an exact release for both hosts', () => {
    const commit = '1'.repeat(40);
    const source = renderStart({ releaseCommit: commit, version: '0.2.0' });
    assert.match(source, /Start Transmogrify 0\.2\.0/);
    assert.ok(source.includes(commit));
    assert.match(source, /fetch --depth 1 origin "\$TRANSMOGRIFY_RELEASE_COMMIT"/);
    assert.match(source, /rev-parse HEAD/);
    assert.match(source, /Report the verified version and commit/);
    assert.match(source, /export WORKTREES=/);
    assert.match(source, /createHash\("sha256"\)/);
    assert.match(source, /install -d -m 700 "\$WORKTREES"/);
    const npmInstall = 'npm --prefix "$TRANSMOGRIFY_SCRATCH" ci --ignore-scripts';
    assert.ok(source.indexOf('export WORKTREES=') < source.indexOf(npmInstall));
    assert.match(source, /"\$TRANSMOGRIFY_SCRATCH\/install\.sh" --dry-run/);
    assert.match(source, /"\$TRANSMOGRIFY_SCRATCH\/install\.sh"\n/);
    assert.ok(source.indexOf(npmInstall) < source.indexOf('install.sh" --dry-run'));
    assert.match(source, /cleanup_transmogrify_scratch/);
    assert.match(source, /Pass `REPO_ROOT` to repository-bound lifecycle calls/);
    assert.match(source, /Pass `WORKTREES`[\s\S]*when spawning a managed lane/);
    assert.doesNotMatch(source, /TRANSMOGRIFY_INSTALL_TARGET|install\.sh" --target/);
    assert.match(source, /default installs both copies/);
    assert.match(source, /\.agents\/skills\/transmogrify/);
    assert.match(source, /\.claude\/skills\/transmogrify/);
    assert.match(source, /--target all \\\n\s+--explain/);
    assert.doesNotMatch(source, /git clone|origin main/);
  });

  test('checks prerequisites before creating any Transmogrify path', () => {
    const source = renderStart({ releaseCommit: '1'.repeat(40), version: '0.2.0' });
    const prerequisites = source.indexOf('command -v git');
    const preparation = source.indexOf('install -d -m 700');
    assert.ok(prerequisites >= 0 && prerequisites < preparation);
    assert.match(source, /command -v node/);
    assert.match(source, /command -v npm/);
    assert.match(source, /major >= 20/);
    assert.match(source, /git rev-parse --verify HEAD/);
    assert.match(source, /REPO_ROOT="\$\(git rev-parse --show-toplevel\)"/);
    assert.match(source, /\n\s+export REPO_ROOT\n/);
    assert.doesNotMatch(source, /export REPO_ROOT="\$\(git rev-parse --show-toplevel\)"/);
  });

  test('stops before preparation outside a Git repository', (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'transmogrify-start-no-repo-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const { result, preparationReached } = runPrerequisites(t, { cwd });
    assert.notEqual(result.status, 0);
    assert.equal(preparationReached, false);
    assert.match(result.stderr, /Git repository with at least one commit/);
  });

  test('stops before preparation in an unborn Git repository', (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'transmogrify-start-unborn-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    assert.equal(spawnSync('git', ['init'], { cwd }).status, 0);
    const { result, preparationReached } = runPrerequisites(t, { cwd });
    assert.notEqual(result.status, 0);
    assert.equal(preparationReached, false);
    assert.match(result.stderr, /Git repository with at least one commit/);
  });

  test('stops before preparation when Node.js is missing', (t) => {
    const { result, preparationReached } = runPrerequisites(t, {
      cwd: tmpdir(),
      commands: { git: '#!/bin/sh\nexit 0\n', npm: '#!/bin/sh\nexit 0\n' },
    });
    assert.notEqual(result.status, 0);
    assert.equal(preparationReached, false);
    assert.match(result.stderr, /needs Node\.js 20 or newer/);
  });

  test('stops before preparation when Node.js is below the minimum', (t) => {
    const { result, preparationReached } = runPrerequisites(t, {
      cwd: tmpdir(),
      commands: {
        git: '#!/bin/sh\nexit 0\n',
        node: '#!/bin/sh\nexit 1\n',
        npm: '#!/bin/sh\nexit 0\n',
      },
    });
    assert.notEqual(result.status, 0);
    assert.equal(preparationReached, false);
    assert.match(result.stderr, /Upgrade Node\.js/);
  });

  test('stops before preparation when repository-root resolution fails visibly', (t) => {
    const { result, preparationReached } = runPrerequisites(t, {
      cwd: tmpdir(),
      commands: {
        git: [
          '#!/bin/sh',
          'if test "$1" = rev-parse && test "$2" = --verify; then exit 0; fi',
          'printf "%s\\n" "root resolution failed at Git boundary" >&2',
          'exit 2',
          '',
        ].join('\n'),
        node: '#!/bin/sh\nexit 0\n',
        npm: '#!/bin/sh\nexit 0\n',
      },
    });
    assert.notEqual(result.status, 0);
    assert.equal(preparationReached, false);
    assert.match(result.stderr, /root resolution failed at Git boundary/);
    assert.match(result.stderr, /repository root could not be resolved/);
  });

  test('uses the explaining doctor and guided setup one consented step at a time', () => {
    const source = renderStart({ releaseCommit: '2'.repeat(40), version: '0.2.0' });
    assert.match(source, /before describing the\s+machine or asking the user/);
    assert.match(source, /doctor\.js"[\s\S]*--target all[\s\S]*--explain/);
    assert.match(source, /first remaining step only/);
    assert.match(source, /ask one yes-or-no question and\s+wait/);
    assert.match(source, /Do\s+not pre-authorize later steps/);
    for (const flag of [
      '--install-claude-cli', '--install-codex-cli', '--sign-in',
      '--start-runtime', '--relaunch-desktop', '--persist-attach',
    ]) {
      assert.match(source, new RegExp(`setup\\.js" --repo-root "\\$REPO_ROOT" ${flag}`));
    }
  });

  test('carries every context sentence verbatim and pins the narration rules', () => {
    const source = renderStart({ releaseCommit: '3'.repeat(40), version: '0.2.0' });
    for (const sentence of [TERMINAL_CONTEXT, IDE_CONTEXT, UNSUPPORTED_CONTEXT]) {
      assert.ok(source.includes(`"${sentence}"`));
    }
    assert.match(source, /what was found, what is ready,\s+what is needed and why, and what happens next/);
    assert.match(source, /Keep\s+identifiers, file paths, ports, command names, and error codes out/);
    assert.match(source, /If the user declines, explain what remains\s+available/);
  });

  test('rejects a non-object release selector', () => {
    assert.throws(
      () => renderStart({ releaseCommit: 'main', version: '0.2.0' }),
      /Git object ID/,
    );
  });
});
