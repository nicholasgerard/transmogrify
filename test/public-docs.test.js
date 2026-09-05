'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseHandback, exchangePreamble } = require('../scripts/lib/exchange');
const { MINIMUM_CLI_VERSION } = require('../scripts/lib/claude-surface');
const { MINIMUM_APP_SERVER_VERSION } = require('../scripts/lib/app-server');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('SKILL.md stays within its byte and word budgets', () => {
  const skill = read('SKILL.md');
  // The skill is loaded into every operator context. Bound growth so detailed
  // reference material moves into linked docs. Baseline: 28,138 bytes / 4,031
  // words at 6cbce31; these limits leave roughly 18% release-edit headroom.
  assert.ok(Buffer.byteLength(skill, 'utf8') <= 33000, 'SKILL.md exceeds 33,000 bytes');
  assert.ok(skill.trim().split(/\s+/u).length <= 4800, 'SKILL.md exceeds 4,800 words');
});

test('the example handback parses with the real exchange contract', () => {
  const handback = parseHandback(read('examples/handback.md'));
  const preamble = exchangePreamble('/tmp/example-seat', 'codex');
  const required = [...preamble.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(Object.keys(handback.sections), required);
  assert.equal(handback.commitSha, '1'.repeat(40));
  assert.ok(handback.title.length >= 10 && handback.title.length <= 72);
  assert.ok(handback.body.trim());
  assert.doesNotMatch(handback.body, /^SHA:/m);
});

test('the example packet restricts child Git actions to its assigned clone', () => {
  const packet = read('examples/packet.md');
  assert.match(packet, /Commit the authorized changes in the assigned clone on its current branch/);
  assert.match(packet, /Never push\. Never change branches\./);
  assert.match(packet, /\.transmogrify\/handback\.md/);
  const instructions = packet.replace(/Never push\. Never change branches\./, '');
  assert.doesNotMatch(instructions, /\bpush\b|\b(?:checkout|switch)\b|change branches|git branch/i);
  assert.doesNotMatch(packet, /Handback:.*outside|must not commit|do not commit/i);
});

test('current support docs separate measured minimums from the private archive pin', () => {
  assert.equal(typeof MINIMUM_CLI_VERSION, 'string');
  for (const file of ['README.md', 'SECURITY.md', 'docs/ONBOARDING.md', 'docs/EXECUTION-PROFILES.md']) {
    const doc = read(file);
    assert.ok(doc.includes(`\`${MINIMUM_CLI_VERSION}\``), `${file}: Claude minimum`);
    assert.match(doc, /private archiv[\s\S]{0,180}(?:exact|pin)|exact[\s\S]{0,180}private archiv/i, file);
  }
  assert.ok(read('README.md').includes(`\`${MINIMUM_APP_SERVER_VERSION}\``));
  assert.match(read('SECURITY.md'), /current `0\.6\.x` release line/);
  assert.doesNotMatch(read('README.md'), /claude install 2\.|initialize-only Codex handshake|unpinned Claude CLI/);
  assert.doesNotMatch(read('docs/EXECUTION-PROFILES.md'), /refusing every unpinned version|on a pinned CLI/);
  assert.doesNotMatch(read('.github/ISSUE_TEMPLATE/bug.yml'), /0\.2\.6/);
});

test('the roadmap preserves the dated release exception and fresh-machine gate', () => {
  const roadmap = read('ROADMAP.md');
  assert.ok(roadmap.includes('2026-09-04 exception: 0.6.0 shipped without the fresh-machine acceptance pass.'));
  assert.match(roadmap, /0\.6\.1 release gate still requires[\s\S]*machine that has never seen Transmogrify/);
  assert.match(roadmap, /Persistence across login, mobile[\s\S]*remain unverified live/);
  assert.doesNotMatch(roadmap, /queued for a Codex worker/);
});
