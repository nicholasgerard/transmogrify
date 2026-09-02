import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildCompatibilityPins,
  buildRepoFacts,
  normalizeNodeEngine,
  normalizeRepositoryUrl,
  parseMarkdownTableUnderHeading,
  parseSkillMetadata,
  parseTableRow,
} from '../src/lib/repo-facts.ts';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const read = (relative: string) => readFileSync(resolve(repoRoot, relative), 'utf8');

describe('parseTableRow', () => {
  test('trims cells and drops the outer pipes', () => {
    assert.deepEqual(parseTableRow('| a | b  |c |'), ['a', 'b', 'c']);
  });

  test('keeps an escaped pipe inside a cell', () => {
    assert.deepEqual(parseTableRow('| a \\| b | c |'), ['a | b', 'c']);
  });
});

describe('parseMarkdownTableUnderHeading', () => {
  const doc = [
    '# Title',
    '',
    '## Support matrix',
    '',
    'Some intro.',
    '',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '| 3 | 4 |',
    '',
    'Trailing prose.',
    '',
    '## Next',
  ].join('\n');

  test('reads headers, rows, and the prose that follows', () => {
    const table = parseMarkdownTableUnderHeading(doc, 'Support matrix');
    assert.deepEqual(table.headers, ['A', 'B']);
    assert.deepEqual(table.rows, [
      ['1', '2'],
      ['3', '4'],
    ]);
    assert.equal(table.trailingProse, 'Trailing prose.');
  });

  test('is case insensitive on the heading', () => {
    assert.doesNotThrow(() => parseMarkdownTableUnderHeading(doc, 'SUPPORT MATRIX'));
  });

  test('throws when the heading is absent, so drift fails the build', () => {
    assert.throws(() => parseMarkdownTableUnderHeading(doc, 'Nope'), /not found/);
  });

  test('throws when the next heading arrives before a table', () => {
    const noTable = '## Support matrix\n\nJust prose.\n\n## Next\n';
    assert.throws(() => parseMarkdownTableUnderHeading(noTable, 'Support matrix'), /No Markdown table/);
  });

  test('throws on a ragged row rather than rendering a broken grid', () => {
    const ragged = '## T\n\n| A | B |\n| --- | --- |\n| 1 |\n';
    assert.throws(() => parseMarkdownTableUnderHeading(ragged, 'T'), /1 cells but 2 headers/);
  });

  test('throws when the delimiter row is missing', () => {
    const bad = '## T\n\n| A | B |\n| 1 | 2 |\n';
    assert.throws(() => parseMarkdownTableUnderHeading(bad, 'T'), /delimiter row/);
  });
});

describe('parseSkillMetadata', () => {
  test('reads the flat metadata map and strips quotes', () => {
    const skill = ['---', 'name: x', 'metadata:', '  version: "1.2.3"', "  date: '2026-01-01'", '---', '# Body'].join(
      '\n',
    );
    assert.deepEqual(parseSkillMetadata(skill), { version: '1.2.3', date: '2026-01-01' });
  });

  test('stops at the next top-level key', () => {
    const skill = ['---', 'metadata:', '  a: "1"', 'other: 2', '---'].join('\n');
    assert.deepEqual(parseSkillMetadata(skill), { a: '1' });
  });

  test('throws without frontmatter', () => {
    assert.throws(() => parseSkillMetadata('# No frontmatter'), /frontmatter/);
  });

  test('throws without a metadata block', () => {
    assert.throws(() => parseSkillMetadata('---\nname: x\n---\n'), /metadata/);
  });
});

describe('normalizers', () => {
  test('normalizeRepositoryUrl handles the git+https form', () => {
    assert.equal(
      normalizeRepositoryUrl('git+https://github.com/owner/name.git'),
      'https://github.com/owner/name',
    );
  });

  test('normalizeRepositoryUrl handles the ssh form', () => {
    assert.equal(normalizeRepositoryUrl('git@github.com:owner/name.git'), 'https://github.com/owner/name');
  });

  test('normalizeRepositoryUrl rejects an unexpected host', () => {
    assert.throws(() => normalizeRepositoryUrl('https://example.com/x/y'), /Unexpected repository URL/);
  });

  test('normalizeNodeEngine extracts the major version', () => {
    assert.equal(normalizeNodeEngine('>=20'), '20');
    assert.equal(normalizeNodeEngine('^22.12.0'), '22');
  });
});

describe('buildCompatibilityPins', () => {
  test('names the missing key so a SKILL.md edit is easy to fix', () => {
    assert.throws(() => buildCompatibilityPins({ version: '1' }), /verified_date/);
  });
});

describe('the real repository', () => {
  const facts = buildRepoFacts({
    readme: read('README.md'),
    skill: read('SKILL.md'),
    rootPackageJson: JSON.parse(read('package.json')),
  });

  test('extracts the support matrix with both orchestrators', () => {
    assert.equal(facts.supportMatrix.headers.length, 3);
    assert.deepEqual(
      facts.supportMatrix.rows.map((row) => row[0]),
      ['Codex', 'Claude Code'],
    );
  });

  test('every matrix cell has content', () => {
    for (const row of facts.supportMatrix.rows) {
      for (const cell of row) assert.ok(cell.length > 0, `empty cell in row ${row[0]}`);
    }
  });

  test('extracts every compatibility pin', () => {
    assert.match(facts.pins.verifiedDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(facts.pins.supportedCodexRuntime, /app-server/);
    assert.match(facts.pins.verifiedCodexDesktop, /^\d/);
    assert.match(facts.pins.verifiedCodexMobile, /^ChatGPT for iOS\s+\d/);
    assert.match(facts.pins.verifiedClaudeCli, /^\d+\.\d+\.\d+$/);
    assert.match(facts.pins.verifiedClaudeDesktop, /^\d/);
    assert.match(facts.pins.verifiedClaudeMobile, /^Claude for iOS\s+\d/);
  });

  test('the skill version and the package version agree', () => {
    assert.equal(facts.pins.version, facts.packageVersion);
  });

  test('the runtime dependency contract is still ws-only', () => {
    assert.deepEqual(facts.runtimeDependencies, ['ws']);
  });

  test('resolves the canonical repository and issue URLs', () => {
    assert.equal(facts.repositoryUrl, 'https://github.com/nicholasgerard/transmogrify');
    assert.ok(facts.issuesUrl.startsWith(facts.repositoryUrl));
  });
});
