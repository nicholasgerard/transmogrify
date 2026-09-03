/**
 * Removes the whitespace Astro's own compressor has to leave behind.
 *
 * `compressHTML` collapses runs of whitespace but keeps a single space between
 * most tags, because between two *inline* elements that space is rendered:
 * dropping it would turn "Get started · Source" into "Get started·Source".
 *
 * So this pass only removes whitespace at a boundary where CSS could never
 * render it — where the tag on one side is block-level. Everything inside
 * `<pre>`, `<textarea>`, `<script>`, and `<style>` is masked out first and put
 * back byte for byte, so the install commands survive exactly as written.
 *
 * Runs after `astro build` and before `build-headers.mjs`, so the CSP hashes
 * are computed over the bytes that actually ship.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', 'dist');

/**
 * Elements whose boxes are never inline, so whitespace touching one of them is
 * always discarded by CSS white-space processing. Deliberately conservative:
 * `span`, `a`, `em`, `code`, `button`, `label`, `img`, `svg` and friends are
 * absent, and a boundary between two of those keeps its space.
 */
const BLOCK = new Set([
  'html', 'head', 'body', 'base', 'link', 'meta', 'title', 'script', 'style',
  'noscript', 'template',
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div',
  'dl', 'dt', 'dd', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'legend',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'ul',
  'table', 'caption', 'col', 'colgroup', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr',
]);

/** Contents that must survive byte for byte. */
const PROTECTED = /<(pre|textarea|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * A held region is swapped for an empty stand-in tag, so the boundary pass
 * still sees a real element in its place. `pre`, `script` and `style` stand in
 * as `pre`, which is block; `textarea` is inline-block, so it stands in as
 * `code` and keeps the whitespace beside it.
 */
const HOLD = /<(?:pre|code) data-h="(\d+)"><\/(?:pre|code)>/g;

/** A tag, the whitespace after it, and the name of whatever comes next. */
const BOUNDARY = /<\/?([a-zA-Z][\w-]*)\b[^>]*>\s+(?=<\/?([a-zA-Z][\w-]*))/g;

export function minifyHtml(html) {
  const held = [];

  let out = html.replace(PROTECTED, (match, tag) => {
    held.push(match);
    const stand = tag.toLowerCase() === 'textarea' ? 'code' : 'pre';
    return `<${stand} data-h="${held.length - 1}"></${stand}>`;
  });

  out = out.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');

  out = out.replace(BOUNDARY, (match, left, right) => {
    if (!BLOCK.has(left.toLowerCase()) && !BLOCK.has(right.toLowerCase())) return match;
    return match.replace(/\s+$/, '');
  });

  out = out.replace(/\s{2,}/g, ' ').trim();

  return out.replace(HOLD, (_, index) => held[Number(index)]);
}

async function* htmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.name.endsWith('.html')) yield path;
  }
}

async function main() {
  let before = 0;
  let after = 0;
  let count = 0;

  for await (const file of htmlFiles(distDir)) {
    const source = await readFile(file, 'utf8');
    const output = minifyHtml(source);
    if (output !== source) await writeFile(file, output);
    before += Buffer.byteLength(source);
    after += Buffer.byteLength(output);
    count += 1;
  }

  const saved = before - after;
  const percent = before === 0 ? 0 : ((saved / before) * 100).toFixed(1);
  console.log(
    `minified ${count} html file(s) in ${relative(process.cwd(), distDir)}: ` +
      `${before} B -> ${after} B (-${saved} B, -${percent}%)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
