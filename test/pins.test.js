'use strict';

// The skill's published compatibility pins must equal the constants the code
// enforces, or a code-side pin bump ships a false public claim with green tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { PINNED_CLI_VERSION } = require('../scripts/lib/claude-surface');
const { TESTED_DESKTOP_BUILDS } = require('../scripts/lib/desktop-attach');
const { VERSION } = require('../scripts/lib/version');

const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
const frontmatter = skill.split('---')[1];
function pin(key) {
  const match = new RegExp(`^\\s*${key}: "([^"]+)"`, 'm').exec(frontmatter);
  assert.ok(match, `SKILL.md frontmatter has ${key}`);
  return match[1];
}

test('SKILL.md pins agree with the enforced constants', () => {
  assert.equal(pin('version'), VERSION);
  assert.equal(pin('verified_claude_cli'), PINNED_CLI_VERSION);
  const newest = TESTED_DESKTOP_BUILDS[TESTED_DESKTOP_BUILDS.length - 1];
  assert.equal(pin('verified_codex_desktop'), `${newest.version} (${newest.build})`);
});
