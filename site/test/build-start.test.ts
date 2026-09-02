import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { renderStart } from '../scripts/build-start.mjs';

describe('renderStart', () => {
  test('disables installation when no public release commit is configured', () => {
    const source = renderStart({ releaseCommit: '', version: '0.1.0' });
    assert.match(source, /not published yet/);
    assert.doesNotMatch(source, /git\s+(?:clone|fetch)/);
  });

  test('pins, verifies, and reports an exact release commit', () => {
    const commit = '1'.repeat(40);
    const source = renderStart({ releaseCommit: commit, version: '0.1.0' });
    assert.match(source, /Start Transmogrify 0\.1\.0/);
    assert.ok(source.includes(commit));
    assert.match(source, /fetch --depth 1 origin "\$TRANSMOGRIFY_RELEASE_COMMIT"/);
    assert.match(source, /rev-parse HEAD/);
    assert.match(source, /Report the verified version and commit/);
    assert.match(source, /export WORKTREES=/);
    assert.match(source, /createHash\("sha256"\)/);
    assert.match(source, /install -d -m 700 "\$WORKTREES"/);
    const npmInstall = 'npm --prefix "$TRANSMOGRIFY_SCRATCH" ci --ignore-scripts';
    assert.ok(source.indexOf('export WORKTREES=') < source.indexOf(npmInstall));
    assert.match(source, /"\$TRANSMOGRIFY_SCRATCH\/install\.sh" --target/);
    assert.ok(source.indexOf(npmInstall) < source.indexOf('install.sh" --target'));
    assert.match(source, /cleanup_transmogrify_scratch/);
    assert.match(source, /Pass `REPO_ROOT` to repository-bound lifecycle calls/);
    assert.match(source, /Pass `WORKTREES`[\s\S]*when spawning a managed lane/);
    assert.match(source, /TRANSMOGRIFY_INSTALL_TARGET=codex/);
    assert.match(source, /TRANSMOGRIFY_INSTALL_TARGET=claude/);
    assert.match(source, /TRANSMOGRIFY_HOST_PROVIDER=codex/);
    assert.match(source, /TRANSMOGRIFY_HOST_PROVIDER=claude/);
    assert.match(source, /TRANSMOGRIFY_DOCTOR_TARGET=all/);
    assert.match(source, /\.agents\/skills\/transmogrify/);
    assert.match(source, /\.claude\/skills\/transmogrify/);
    assert.match(source, /--target "\$TRANSMOGRIFY_DOCTOR_TARGET"/);
    assert.match(source, /create or recover the current task's durable parent context/);
    assert.match(source, /bounded wait\/acknowledgement loop/);
    assert.doesNotMatch(source, /git clone|origin main/);
  });

  test('rejects a non-object release selector', () => {
    assert.throws(
      () => renderStart({ releaseCommit: 'main', version: '0.1.0' }),
      /Git object ID/,
    );
  });
});
