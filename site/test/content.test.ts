/**
 * Content guarantees that are cheap to assert and expensive to lose: the start
 * prompt stays legible and truthful, the inline formatter cannot swallow text,
 * and the legal documents agree on their effective date.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { START_PROMPT } from '../src/lib/start-prompt.ts';
import { parseInline } from '../src/lib/inline-code.ts';
import { LEGAL_EFFECTIVE_DATE, canonical, docUrl } from '../src/lib/site.ts';
import { renderStart } from '../scripts/build-start.mjs';

const siteRoot = resolve(import.meta.dirname, '..');

describe('the start prompt', () => {
  const remotePrompt = renderStart({ releaseCommit: '1'.repeat(40), version: '0.1.0' });

  test('the copyable bootstrap is exactly one short line', () => {
    assert.equal(START_PROMPT.split('\n').length, 1);
    assert.ok(START_PROMPT.length <= 80);
    assert.equal(START_PROMPT, 'Fetch https://transmogrify.sh/start and follow its instructions.');
  });

  test('the remote Markdown names the canonical repository and no alternate source', () => {
    assert.match(remotePrompt, /https:\/\/github\.com\/nicholasgerard\/transmogrify/);
    const repositoryUrls = remotePrompt.match(/https:\/\/github\.com\/[^\s`)]+/g) ?? [];
    assert.ok(repositoryUrls.length >= 1);
    assert.ok(
      repositoryUrls.every((url) =>
        url.startsWith('https://github.com/nicholasgerard/transmogrify'),
      ),
    );
  });

  test('runs the read-only doctor against the current repository', () => {
    assert.match(remotePrompt, /scripts\/doctor\.js/);
    assert.match(remotePrompt, /git rev-parse --show-toplevel/);
    assert.match(remotePrompt, /read-only/);
  });

  test('preserves the target and private worktree roots before entering install scratch space', () => {
    const rootAssignments = remotePrompt.match(
      /export REPO_ROOT="\$\(git rev-parse --show-toplevel\)"/g,
    ) ?? [];
    assert.equal(rootAssignments.length, 1);
    assert.ok(remotePrompt.indexOf(rootAssignments[0]) < remotePrompt.indexOf('Create a fresh scratch'));
    assert.match(remotePrompt, /--repo-root "\$REPO_ROOT"/);
    assert.match(remotePrompt, /Keep `REPO_ROOT` and `WORKTREES` unchanged/);
  });

  test('installs without lifecycle scripts and previews first', () => {
    assert.match(remotePrompt, /npm ci\s+--ignore-scripts/);
    assert.match(remotePrompt, /\.\/install\.sh --dry-run/);
  });

  test('pins and verifies one exact public release commit', () => {
    assert.match(remotePrompt, /TRANSMOGRIFY_RELEASE_COMMIT=1{40}/);
    assert.match(remotePrompt, /fetch --depth 1 origin "\$TRANSMOGRIFY_RELEASE_COMMIT"/);
    assert.match(remotePrompt, /rev-parse HEAD/);
    assert.match(remotePrompt, /never fall back to the repository default branch/);
  });

  test('tells the agent to reuse a compatible runtime', () => {
    assert.match(remotePrompt, /reuse a compatible runtime/i);
    assert.match(
      remotePrompt,
      /Never kill, restart,\s+reconfigure, steer, interrupt, archive, or adopt/i,
    );
  });

  test('tells the agent to ask before starting a new runtime', () => {
    assert.match(remotePrompt, /ask before starting one/i);
  });

  test('names both host targets so it works pasted into either agent', () => {
    assert.match(remotePrompt, /--target codex/);
    assert.match(remotePrompt, /--target all/);
    assert.match(remotePrompt, /Codex or Claude Code/);
  });

  test('contains no personal path or machine-specific detail', () => {
    assert.doesNotMatch(remotePrompt, /\/Users\/|\/home\/[a-z]/i);
  });

  test('has no trailing whitespace to survive a copy-paste round trip', () => {
    for (const line of remotePrompt.split('\n')) {
      assert.equal(line, line.replace(/\s+$/, ''), `trailing whitespace on "${line}"`);
    }
  });
});

describe('the rendered install sequence', () => {
  const source = readFileSync(
    resolve(siteRoot, 'src/content/sections/04-install.md'),
    'utf8',
  );

  test('defines target and seat roots before the release-pinned handoff', () => {
    const target = source.indexOf('export REPO_ROOT=');
    const seats = source.indexOf('export WORKTREES=');
    const handoff = source.indexOf('Fetch https://transmogrify.sh/start');
    assert.ok(target >= 0 && seats >= 0 && handoff >= 0);
    assert.ok(target < handoff);
    assert.ok(seats < handoff);
    assert.match(source, /createHash\("sha256"\)/);
    assert.match(source, /WORKTREES="\$TRANSMOGRIFY_DATA_ROOT\/worktrees\/\$TRANSMOGRIFY_REPO_KEY"/);
    assert.match(source, /install -d -m 700 "\$WORKTREES"/);
  });

  test('does not present a mutable branch checkout as the automated install path', () => {
    assert.doesNotMatch(source, /git clone|origin main|--branch\s+main/);
    assert.match(source, /one exact[\s\S]*commit/);
    assert.match(source, /refuses branch fallback/);
  });

  test('uses the defined roots in doctor and spawn commands', () => {
    assert.match(source, /scripts\/doctor\.js[\s\S]*--repo-root "\$REPO_ROOT"/);
    assert.match(source, /scripts\/lane\.js[\s\S]*--repo-root "\$REPO_ROOT"/);
    assert.match(source, /--worktrees "\$WORKTREES"/);
  });
});

describe('parseInline', () => {
  test('splits backticked code out of plain text', () => {
    assert.deepEqual(parseInline('run `npm ci` now'), [
      { kind: 'text', value: 'run ' },
      { kind: 'code', value: 'npm ci' },
      { kind: 'text', value: ' now' },
    ]);
  });

  test('recognises bold runs', () => {
    assert.deepEqual(parseInline('a **b** c'), [
      { kind: 'text', value: 'a ' },
      { kind: 'strong', value: 'b' },
      { kind: 'text', value: ' c' },
    ]);
  });

  test('leaves an unmatched delimiter literal instead of eating the rest', () => {
    assert.deepEqual(parseInline('a ` b'), [{ kind: 'text', value: 'a ` b' }]);
    assert.deepEqual(parseInline('a ** b'), [{ kind: 'text', value: 'a ** b' }]);
  });

  test('round-trips every character of the input', () => {
    for (const source of ['plain', '`x`', 'a `b` c **d** e', '**a** `b`', '', '``', '`a``b`']) {
      const joined = parseInline(source)
        .map((token) => (token.kind === 'code' ? `\`${token.value}\`` : token.kind === 'strong' ? `**${token.value}**` : token.value))
        .join('');
      assert.equal(joined, source, `lossy for ${JSON.stringify(source)}`);
    }
  });
});

describe('site helpers', () => {
  test('docUrl builds a canonical blob URL', () => {
    assert.equal(
      docUrl('https://github.com/o/n', 'docs/PROTOCOL.md'),
      'https://github.com/o/n/blob/main/docs/PROTOCOL.md',
    );
  });

  test('canonical never emits a trailing slash except for the origin', () => {
    assert.equal(canonical('https://x.test', '/'), 'https://x.test');
    assert.equal(canonical('https://x.test', '/terms'), 'https://x.test/terms');
    assert.equal(canonical('https://x.test', '/terms/'), 'https://x.test/terms');
  });
});

describe('legal documents', () => {
  const dir = resolve(siteRoot, 'src/content/legal');
  const files = readdirSync(dir).filter((name) => name.endsWith('.md'));

  test('both documents exist', () => {
    assert.deepEqual(files.sort(), ['privacy.md', 'terms.md']);
  });

  for (const file of files) {
    const source = readFileSync(resolve(dir, file), 'utf8');

    test(`${file} declares the shared effective date`, () => {
      const match = /^effectiveDate:\s*'?(\d{4}-\d{2}-\d{2})'?/m.exec(source);
      assert.ok(match, 'no effectiveDate in frontmatter');
      assert.equal(match[1], LEGAL_EFFECTIVE_DATE);
    });

    test(`${file} links the MIT license or the repository`, () => {
      assert.match(source, /github\.com\/nicholasgerard\/transmogrify/);
    });

    test(`${file} invents no postal address or company entity`, () => {
      assert.doesNotMatch(source, /\b(Inc\.|LLC|Ltd\.|GmbH|Suite \d|P\.?O\.? Box)\b/);
      assert.doesNotMatch(source, /\b\d{5}(-\d{4})?\b/, 'looks like a postal code');
    });

    test(`${file} names no private path or internal host`, () => {
      assert.doesNotMatch(source, /\/Users\/|localhost:\d|\.internal\b/);
    });
  }

  test('the privacy policy states the no-analytics default', () => {
    const source = readFileSync(resolve(dir, 'privacy.md'), 'utf8');
    assert.match(source, /default is no analytics/i);
    assert.match(source, /Global Privacy Control/);
    assert.match(source, /Do Not Track/);
  });
});
