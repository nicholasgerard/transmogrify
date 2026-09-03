/**
 * The minifier is only allowed to remove whitespace that CSS would have thrown
 * away anyway. These tests pin the two halves of that: what it must remove, and
 * what it must never touch.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { minifyHtml } from '../scripts/minify-html.mjs';

describe('minifyHtml removes whitespace that never renders', () => {
  test('between two block elements', () => {
    assert.equal(minifyHtml('<div>a</div>\n  <div>b</div>'), '<div>a</div><div>b</div>');
  });

  test('just inside a block open tag and just before its close tag', () => {
    assert.equal(minifyHtml('<p> <a href="/">x</a> </p>'), '<p><a href="/">x</a></p>');
  });

  test('between list items', () => {
    assert.equal(minifyHtml('<ul>\n<li>a</li>\n<li>b</li>\n</ul>'), '<ul><li>a</li><li>b</li></ul>');
  });

  test('in the document skeleton', () => {
    assert.equal(
      minifyHtml('<html lang="en"> <head><title>t</title></head> <body>x</body> </html>'),
      '<html lang="en"><head><title>t</title></head><body>x</body></html>',
    );
  });

  test('and it drops comments', () => {
    assert.equal(minifyHtml('<div><!-- note -->a</div>'), '<div>a</div>');
  });
});

describe('minifyHtml preserves whitespace that renders', () => {
  test('between two inline elements', () => {
    const source = '<p><a href="/">Get started</a> <span>·</span> <a href="/s">Source</a></p>';
    assert.equal(minifyHtml(source), source);
  });

  test('around inline text', () => {
    assert.equal(minifyHtml('<p>one <strong>two</strong> three</p>'), '<p>one <strong>two</strong> three</p>');
  });

  test('it collapses a run between inline elements to exactly one space', () => {
    assert.equal(minifyHtml('<p><em>a</em>   <em>b</em></p>'), '<p><em>a</em> <em>b</em></p>');
  });
});

describe('minifyHtml never touches preformatted content', () => {
  const code = 'export REPO_ROOT="$(git rev-parse --show-toplevel)"\n  install -d -m 700 "$WORKTREES"\n';

  test('a pre block survives byte for byte', () => {
    const output = minifyHtml(`<div>\n  <pre>${code}</pre>\n</div>`);
    assert.equal(output, `<div><pre>${code}</pre></div>`);
    assert.ok(output.includes(code));
  });

  test('two pre blocks are restored in the right order', () => {
    const output = minifyHtml('<div>\n<pre>  first  </pre>\n<pre>\tsecond\t</pre>\n</div>');
    assert.equal(output, '<div><pre>  first  </pre><pre>\tsecond\t</pre></div>');
  });

  test('inline script and style bodies are untouched', () => {
    const source = '<head>\n<script>var a = 1;  var b = 2;</script>\n<style>a {  color: red }</style>\n</head>';
    assert.equal(
      minifyHtml(source),
      '<head><script>var a = 1;  var b = 2;</script><style>a {  color: red }</style></head>',
    );
  });

  test('a numeric run next to a pre block is not mistaken for a placeholder', () => {
    const output = minifyHtml('<p>see 0 and 1</p><pre>kept  as  is</pre>');
    assert.equal(output, '<p>see 0 and 1</p><pre>kept  as  is</pre>');
  });
});
