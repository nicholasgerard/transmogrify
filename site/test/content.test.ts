/**
 * Content guarantees that are cheap to assert and expensive to lose: the start
 * prompt stays legible and truthful, the inline formatter cannot swallow text,
 * and the legal documents agree on their effective date.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { START_PROMPT } from '../src/lib/start-prompt.ts';
import { parseInline } from '../src/lib/inline-code.ts';
import { LEGAL_EFFECTIVE_DATE, canonical, docUrl } from '../src/lib/site.ts';
import { renderStart } from '../scripts/build-start.mjs';

const siteRoot = resolve(import.meta.dirname, '..');

describe('the start prompt', () => {
  const remotePrompt = renderStart({ releaseCommit: '1'.repeat(40), version: '0.2.0' });

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
      /REPO_ROOT="\$\(git rev-parse --show-toplevel\)"/g,
    ) ?? [];
    const rootExports = remotePrompt.match(/export REPO_ROOT/g) ?? [];
    assert.equal(rootAssignments.length, 1);
    assert.equal(rootExports.length, 1);
    assert.ok(remotePrompt.indexOf(rootAssignments[0]) < remotePrompt.indexOf(rootExports[0]));
    assert.ok(remotePrompt.indexOf(rootAssignments[0]) < remotePrompt.indexOf('Create a fresh scratch'));
    assert.doesNotMatch(remotePrompt, /export REPO_ROOT="\$\(git rev-parse --show-toplevel\)"/);
    assert.match(remotePrompt, /--repo-root "\$REPO_ROOT"/);
    assert.match(remotePrompt, /Keep `REPO_ROOT` and `WORKTREES` unchanged/);
  });

  test('installs without lifecycle scripts and previews first', () => {
    assert.match(
      remotePrompt,
      /npm --prefix "\$TRANSMOGRIFY_SCRATCH" ci --ignore-scripts/,
    );
    assert.match(
      remotePrompt,
      /"\$TRANSMOGRIFY_SCRATCH\/install\.sh" --dry-run/,
    );
    assert.doesNotMatch(remotePrompt, /TRANSMOGRIFY_INSTALL_TARGET|install\.sh" --target/);
    assert.match(remotePrompt, /cleanup_transmogrify_scratch/);
  });

  test('pins and verifies one exact public release commit', () => {
    assert.match(remotePrompt, /TRANSMOGRIFY_RELEASE_COMMIT=1{40}/);
    assert.match(remotePrompt, /fetch --depth 1 origin "\$TRANSMOGRIFY_RELEASE_COMMIT"/);
    assert.match(remotePrompt, /rev-parse HEAD/);
    assert.match(remotePrompt, /never fall back to the repository default branch/);
  });

  test('tells the agent to reuse only what the doctor found', () => {
    assert.match(remotePrompt, /Reuse what the doctor found/i);
    assert.match(
      remotePrompt,
      /Never kill, restart,\s+reconfigure, steer,\s+interrupt, archive, or adopt/i,
    );
  });

  test('requires one consent before starting a new runtime', () => {
    assert.match(remotePrompt, /ask one yes-or-no question and\s+wait/i);
    assert.match(remotePrompt, /setup\.js" --repo-root "\$REPO_ROOT" --start-runtime/);
  });

  test('names both host targets so it works pasted into either agent', () => {
    assert.match(remotePrompt, /Install for both Claude and Codex/);
    assert.match(remotePrompt, /\.agents\/skills\/transmogrify/);
    assert.match(remotePrompt, /\.claude\/skills\/transmogrify/);
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

/**
 * The release refresh has two manual parts, and a test fails when either is
 * forgotten: the site package version tracks the root package, and the Docs
 * section keeps its six reviewed cards pointing at documents that exist.
 */
describe('the release refresh', () => {
  const repoRoot = resolve(siteRoot, '..');

  test('the site package version tracks the root package version', () => {
    const rootVersion = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).version;
    const siteVersion = JSON.parse(readFileSync(resolve(siteRoot, 'package.json'), 'utf8')).version;
    assert.equal(siteVersion, rootVersion, 'run `npm version <version> --no-git-tag-version` in site/');
  });

  describe('the documentation cards', () => {
    const source = readFileSync(resolve(siteRoot, 'src/content/sections/05-read.md'), 'utf8');
    const carded = [...source.matchAll(/^\s+path:\s*(\S+)\s*$/gm)].map((match) => match[1]);

    test('the Docs section keeps six cards, each pointing at a document that exists', () => {
      assert.equal(carded.length, 6, 'the landing page shows exactly six documents; change this test to change the set');
      for (const path of carded) {
        assert.ok(existsSync(resolve(repoRoot, path)), `${path} does not exist in the repository`);
      }
    });

    test('the cards are the documents a first reader needs, in reading order', () => {
      assert.deepEqual(carded, [
        'SKILL.md',
        'examples/README.md',
        'docs/PROTOCOL.md',
        'docs/CLAUDE-CODE.md',
        'SECURITY.md',
        'docs/TROUBLESHOOTING.md',
      ]);
    });
  });
});
