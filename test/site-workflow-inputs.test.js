'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

function rootBuildInputs(entry) {
  const visited = new Set();
  const inputs = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    // Follow literal relative imports, require calls, and URL-backed reads.
    // An unrecognized root-relative reference fails closed so a new build input
    // cannot silently bypass CI when the generator's import style changes.
    const references = [...source.matchAll(/(?:from\s*|import\s*|require\(\s*|new URL\(\s*)['"](\.[^'"]+)['"]/g)]
      .map((match) => match[1]);
    for (const match of source.matchAll(/['"](\.\.\/\.\.\/[^'"]+)['"]/g)) {
      assert.ok(references.includes(match[1]), `unrecognized build input: ${match[1]}`);
    }
    for (const reference of references) {
      const resolved = path.resolve(path.dirname(file), reference);
      const relative = path.relative(root, resolved).split(path.sep).join('/');
      assert.ok(!relative.startsWith('../'), `input outside repository: ${reference}`);
      if (!relative.startsWith('site/')) inputs.add(relative);
      if (/\.[cm]?js$/.test(resolved)) visit(resolved);
    }
  }
  visit(path.join(root, entry));
  return [...inputs].sort();
}

function workflowPathFilters(source) {
  return [...source.matchAll(/^    paths:\n((?:^      .*\n|^\s*\n)+)/gm)]
    .map((match) => [...match[1].matchAll(/^      - ['"]([^'"]+)['"]$/gm)]
      .map((item) => item[1]));
}

test('both site workflows cover every root input of the start generator in every path filter', () => {
  const inputs = rootBuildInputs('site/scripts/build-start.mjs');
  assert.ok(inputs.includes('package.json'));
  assert.ok(inputs.includes('scripts/lib/setup-plan.js'));
  for (const [file, count] of [['site.yml', 2], ['site-deploy.yml', 1]]) {
    const filters = workflowPathFilters(fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8'));
    assert.equal(filters.length, count, `${file}: expected push and any pull-request filters`);
    for (const [index, filter] of filters.entries()) {
      for (const input of inputs) assert.ok(filter.includes(input), `${file} filter ${index}: ${input}`);
    }
  }
});
