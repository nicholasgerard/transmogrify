/**
 * Static HTML and accessibility sanity checks over the built output.
 *
 * This is a fail-closed structural gate, not a substitute for a rendered axe
 * run, keyboard pass, or screen-reader spot check — see site/README.md for
 * those. It catches the regressions that are cheap to catch without a browser:
 * missing landmarks, broken heading order, unlabelled controls, unreachable
 * icons, absent metadata, and — most importantly for this site — any analytics
 * code shipped into a build that has no measurement ID.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseHTML } from 'linkedom';

import { EXPECTED_ROUTES } from './lib/constants.mjs';

const DIST = resolve(process.argv[2] ?? 'dist');
const analyticsConfigured = /^G-[A-Z0-9]+$/i.test(
  (process.env.PUBLIC_GA_MEASUREMENT_ID ?? '').trim(),
);

async function htmlFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await htmlFiles(full, base)));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out.sort();
}

const problems = [];
const files = await htmlFiles(DIST);

function routeOf(file) {
  const rel = file.slice(DIST.length).replace(/\\/g, '/');
  if (rel === '/index.html') return '/';
  if (rel === '/404.html') return '/404';
  return rel.replace(/\/index\.html$/, '');
}

const seenRoutes = new Set();

for (const file of files) {
  const route = routeOf(file);
  seenRoutes.add(route);
  const source = await readFile(file, 'utf8');
  const { document } = parseHTML(source);
  const fail = (message) => problems.push(`${route}: ${message}`);

  // --- document basics -----------------------------------------------------
  const html = document.documentElement;
  if (html.getAttribute('lang') !== 'en') fail('<html> is missing lang="en"');
  if (!document.querySelector('meta[charset]')) fail('missing <meta charset>');
  if (!document.querySelector('meta[name="viewport"]')) fail('missing viewport meta');

  const title = document.querySelector('title')?.textContent?.trim() ?? '';
  if (title.length < 10) fail(`<title> is missing or too short ("${title}")`);
  if (title.length > 70) fail(`<title> is ${title.length} chars; keep it under 70`);

  const description = document.querySelector('meta[name="description"]')?.getAttribute('content');
  if (!description || description.length < 50) fail('meta description is missing or too short');

  if (!document.querySelector('link[rel="canonical"]')) fail('missing canonical link');
  for (const property of ['og:title', 'og:description', 'og:image', 'og:url']) {
    if (!document.querySelector(`meta[property="${property}"]`)) fail(`missing ${property}`);
  }
  if (!document.querySelector('meta[name="twitter:card"]')) fail('missing twitter:card');

  // --- landmarks and headings ---------------------------------------------
  if (document.querySelectorAll('main').length !== 1) fail('expected exactly one <main>');
  if (!document.querySelector('header')) fail('missing <header>');
  if (!document.querySelector('footer')) fail('missing <footer>');

  const skip = document.querySelector('a.skip-link');
  if (!skip) fail('missing skip link');
  else if (skip.getAttribute('href') !== '#main') fail('skip link does not target #main');
  else if (!document.querySelector('#main')) fail('skip link target #main does not exist');

  const h1s = document.querySelectorAll('h1');
  if (h1s.length !== 1) fail(`expected exactly one <h1>, found ${h1s.length}`);

  let previous = 0;
  for (const heading of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const level = Number(heading.tagName[1]);
    if (previous !== 0 && level > previous + 1) {
      fail(`heading level jumps from h${previous} to h${level} ("${heading.textContent?.trim().slice(0, 40)}")`);
    }
    if (!heading.textContent?.trim()) fail(`empty h${level}`);
    previous = level;
  }

  // Duplicate ids break every fragment link and every aria reference.
  const ids = [...document.querySelectorAll('[id]')].map((el) => el.getAttribute('id'));
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) fail(`duplicate id(s): ${[...new Set(duplicates)].join(', ')}`);

  // --- controls and names --------------------------------------------------
  for (const button of document.querySelectorAll('button')) {
    const name =
      (button.textContent ?? '').trim() ||
      button.getAttribute('aria-label') ||
      (button.getAttribute('aria-labelledby')
        ? document.getElementById(button.getAttribute('aria-labelledby'))?.textContent?.trim()
        : '');
    if (!name) fail('a <button> has no accessible name');
    if (!button.getAttribute('type')) fail(`<button> "${name}" has no explicit type`);
  }

  for (const link of document.querySelectorAll('a[href]')) {
    const name = (link.textContent ?? '').trim() || link.getAttribute('aria-label');
    if (!name) fail(`<a href="${link.getAttribute('href')}"> has no accessible name`);
  }

  for (const input of document.querySelectorAll('input')) {
    const id = input.getAttribute('id');
    const labelled =
      (id && document.querySelector(`label[for="${id}"]`)) ||
      input.getAttribute('aria-label') ||
      input.getAttribute('aria-labelledby');
    if (!labelled) fail(`<input${id ? ` id="${id}"` : ''}> has no label`);
  }

  for (const img of document.querySelectorAll('img')) {
    if (img.getAttribute('alt') === null) fail(`<img src="${img.getAttribute('src')}"> has no alt`);
  }

  // Decorative inline SVG must be hidden from assistive technology; meaningful
  // SVG must carry a name. Anything in between is an ambiguity worth failing.
  const hiddenFromAt = (element) => {
    for (let node = element; node; node = node.parentElement) {
      if (node.getAttribute?.('aria-hidden') === 'true') return true;
    }
    return false;
  };
  for (const svg of document.querySelectorAll('svg')) {
    const named = svg.getAttribute('aria-label') || svg.querySelector('title');
    if (!hiddenFromAt(svg) && !named) {
      fail('an inline <svg> is neither aria-hidden (directly or by an ancestor) nor named');
    }
  }

  for (const table of document.querySelectorAll('table')) {
    if (!table.querySelector('th')) fail('a <table> has no header cells');
    const twoDimensional = table.querySelector('tbody th');
    if (twoDimensional) {
      for (const th of table.querySelectorAll('th')) {
        if (!th.getAttribute('scope')) {
          fail(`a <th> ("${th.textContent?.trim().slice(0, 30)}") in a two-dimensional table has no scope`);
        }
      }
    }
  }

  // --- analytics posture ---------------------------------------------------
  // Only executable and fetchable references count. The privacy policy names
  // googletagmanager.com in its prose on purpose, and that is not a request.
  const GOOGLE = /googletagmanager\.com|google-analytics\.com|\bgtag\s*\(/;
  for (const script of document.querySelectorAll('script')) {
    const body = `${script.getAttribute('src') ?? ''} ${script.textContent ?? ''}`;
    if (!analyticsConfigured && GOOGLE.test(body)) {
      fail('build has no PUBLIC_GA_MEASUREMENT_ID but a <script> references Google');
    }
  }
  for (const el of document.querySelectorAll('link[href], iframe[src], img[src]')) {
    const target = el.getAttribute('href') ?? el.getAttribute('src') ?? '';
    if (!analyticsConfigured && GOOGLE.test(target)) {
      fail(`build has no PUBLIC_GA_MEASUREMENT_ID but <${el.tagName.toLowerCase()}> targets ${target}`);
    }
  }
  if (!analyticsConfigured && document.querySelector('#consent-dialog')) {
    fail('consent dialog rendered in a build with no measurement ID');
  }
  for (const preconnect of document.querySelectorAll('link[rel="preconnect"], link[rel="dns-prefetch"]')) {
    fail(`unexpected ${preconnect.getAttribute('rel')} to ${preconnect.getAttribute('href')}`);
  }
  for (const script of document.querySelectorAll('script[src]')) {
    const src = script.getAttribute('src') ?? '';
    if (/^https?:/i.test(src)) fail(`third-party script in static output: ${src}`);
  }
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const href = link.getAttribute('href') ?? '';
    if (/^https?:/i.test(href)) fail(`third-party stylesheet: ${href}`);
  }

  // --- outbound link hygiene ----------------------------------------------
  for (const link of document.querySelectorAll('a[target="_blank"]')) {
    const rel = link.getAttribute('rel') ?? '';
    if (!rel.includes('noopener')) fail('target="_blank" link without rel="noopener"');
  }
}

for (const route of EXPECTED_ROUTES) {
  if (!seenRoutes.has(route)) problems.push(`expected route ${route} was not emitted`);
}
for (const route of seenRoutes) {
  if (!EXPECTED_ROUTES.includes(route)) {
    problems.push(`unexpected route ${route} in output — remove it or add it to EXPECTED_ROUTES`);
  }
}

console.log(`checked ${files.length} page(s): ${[...seenRoutes].sort().join(', ')}`);
console.log(`analytics configured for this build: ${analyticsConfigured ? 'yes' : 'no'}`);

if (problems.length) {
  console.error('\nHTML/A11Y PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}
console.log('html and accessibility sanity checks passed');
