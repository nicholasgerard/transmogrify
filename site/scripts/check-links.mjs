/**
 * Internal-link validation over the built output.
 *
 * Every same-origin href and every local asset reference must resolve to a file
 * in `dist/`, and every in-page fragment must resolve to an element with that
 * id. External links are listed but not fetched: this check must stay offline
 * and deterministic.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { parseHTML } from 'linkedom';

import { SITE_ORIGIN } from './lib/constants.mjs';

const DIST = resolve(process.argv[2] ?? 'dist');

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push('/' + posix.normalize(full.slice(base.length + 1).split(/[\\/]/).join('/')));
  }
  return out;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cloudflare Static Assets serves `/foo/index.html` at `/foo`, so a bare path resolves
 * against three candidates.
 */
async function resolvesInDist(pathname) {
  const clean = decodeURIComponent(pathname).replace(/\/+$/, '') || '/';
  const candidates =
    clean === '/'
      ? ['index.html']
      : [clean.slice(1), `${clean.slice(1)}.html`, `${clean.slice(1)}/index.html`];
  for (const candidate of candidates) {
    if (await exists(resolve(DIST, candidate))) return true;
  }
  return false;
}

function parseRedirects(source) {
  const map = new Map();
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [from, to] = trimmed.split(/\s+/);
    if (from && to) map.set(from.replace(/\/+$/, '') || '/', to);
  }
  return map;
}

const problems = [];
const externals = new Set();
let checkedLinks = 0;
let checkedFragments = 0;

const files = await walk(DIST);
const htmlFiles = files.filter((f) => f.endsWith('.html'));

if (htmlFiles.length === 0) {
  console.error('No HTML found in dist/. Run `npm run build` first.');
  process.exit(1);
}

if (!(await exists(resolve(DIST, 'start')))) problems.push('/start is missing from dist');

let redirects = new Map();
if (await exists(resolve(DIST, '_redirects'))) {
  redirects = parseRedirects(await readFile(resolve(DIST, '_redirects'), 'utf8'));
}

for (const file of htmlFiles) {
  const html = await readFile(resolve(DIST, file.slice(1)), 'utf8');
  const { document } = parseHTML(html);
  const ids = new Set([...document.querySelectorAll('[id]')].map((el) => el.getAttribute('id')));

  const refs = [
    ...[...document.querySelectorAll('a[href]')].map((el) => ['href', el.getAttribute('href')]),
    ...[...document.querySelectorAll('link[href]')].map((el) => ['href', el.getAttribute('href')]),
    ...[...document.querySelectorAll('img[src], script[src]')].map((el) => [
      'src',
      el.getAttribute('src'),
    ]),
  ];

  for (const [, raw] of refs) {
    if (!raw) continue;
    const value = raw.trim();
    if (value === '' || value.startsWith('mailto:') || value.startsWith('data:')) continue;

    if (value.startsWith('#')) {
      checkedFragments += 1;
      if (!ids.has(value.slice(1))) {
        problems.push(`${file}: fragment ${value} has no matching id`);
      }
      continue;
    }

    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      if (url.origin === SITE_ORIGIN) {
        checkedLinks += 1;
        if (!(await resolvesInDist(url.pathname))) {
          problems.push(`${file}: absolute self link ${value} does not resolve in dist`);
        }
      } else {
        externals.add(url.origin);
      }
      continue;
    }

    if (!value.startsWith('/')) {
      problems.push(`${file}: relative reference "${value}" — use a root-relative path`);
      continue;
    }

    const [pathname, fragment] = value.split('#');
    checkedLinks += 1;

    const normalized = pathname.replace(/\/+$/, '') || '/';
    if (redirects.has(normalized)) continue;

    if (!(await resolvesInDist(pathname))) {
      problems.push(`${file}: link ${value} does not resolve in dist`);
      continue;
    }

    if (fragment) {
      const targetPath =
        (pathname.replace(/\/+$/, '') || '/') === '/'
          ? 'index.html'
          : `${pathname.replace(/^\/|\/+$/g, '')}/index.html`;
      if (await exists(resolve(DIST, targetPath))) {
        const targetHtml = await readFile(resolve(DIST, targetPath), 'utf8');
        const target = parseHTML(targetHtml).document;
        checkedFragments += 1;
        if (!target.querySelector(`[id="${fragment}"]`)) {
          problems.push(`${file}: ${value} — target page has no id "${fragment}"`);
        }
      }
    }
  }
}

// Every `_redirects` destination that stays on this site must also resolve.
for (const [from, to] of redirects) {
  if (to.startsWith('/')) {
    const [pathname] = to.split('#');
    if (!(await resolvesInDist(pathname))) {
      problems.push(`_redirects: ${from} → ${to} does not resolve in dist`);
    }
  }
}

console.log(
  `checked ${checkedLinks} internal link(s) and ${checkedFragments} fragment(s) across ${htmlFiles.length} page(s)`,
);
console.log(`external origins referenced (not fetched): ${[...externals].sort().join(', ')}`);

if (problems.length) {
  console.error('\nBROKEN LINKS:\n' + problems.map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}
console.log('all internal links and fragments resolve');
