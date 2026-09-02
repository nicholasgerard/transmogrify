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
    assert.ok(source.indexOf('export WORKTREES=') < source.indexOf('npm ci --ignore-scripts'));
    assert.match(source, /Pass both to every managed lane lifecycle call/);
    assert.doesNotMatch(source, /git clone|origin main/);
  });

  test('rejects a non-object release selector', () => {
    assert.throws(
      () => renderStart({ releaseCommit: 'main', version: '0.1.0' }),
      /Git object ID/,
    );
  });
});
