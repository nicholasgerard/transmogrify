import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildCompatibilityPins,
  buildRepoFacts,
  normalizeNodeEngine,
  normalizeRepositoryUrl,
  parseSkillMetadata,
} from '../src/lib/repo-facts.ts';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const read = (relative: string) => readFileSync(resolve(repoRoot, relative), 'utf8');

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
    skill: read('SKILL.md'),
    rootPackageJson: JSON.parse(read('package.json')),
  });

  test('extracts every compatibility pin', () => {
    assert.match(facts.pins.verifiedDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(facts.pins.supportedCodexRuntime, /app-server/);
    // No Codex Desktop build is verified for shared-runtime attachment since 0.6.1;
    // the pin then reads 'none; exact-build verification required'.
    assert.match(facts.pins.verifiedCodexDesktop, /^(?:\d|none; exact-build verification required$)/);
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
