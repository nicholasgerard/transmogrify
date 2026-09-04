import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { renderStart } from '../scripts/build-start.mjs';
import setupPlan from '../../scripts/lib/setup-plan.js';

const { IDE_CONTEXT, TERMINAL_CONTEXT, UNSUPPORTED_CONTEXT } = setupPlan;

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
