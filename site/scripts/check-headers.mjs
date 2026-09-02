/**
 * Validates the generated `dist/_headers` against the build it describes.
 *
 * Three things must hold, and each has bitten real static sites:
 *   1. every inline <script> in the output is covered by a CSP hash;
 *   2. immutable caching is applied only to content-hashed paths;
 *   3. the baseline security headers are present and not weakened.
 *
 * Also checks `_redirects` for Cloudflare Static Assets syntax and limits.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { computeScriptHashes } from './build-headers.mjs';

const DIST = resolve(process.argv[2] ?? 'dist');
const headersPath = resolve(DIST, '_headers');
const redirectsPath = resolve(DIST, '_redirects');

const problems = [];

if (!existsSync(headersPath)) {
  console.error('dist/_headers is missing. Run `npm run build`.');
  process.exit(1);
}

const headers = await readFile(headersPath, 'utf8');

/** Parse the `_headers` format into rule blocks. */
function parseHeaders(source) {
  const rules = [];
  let current = null;
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { path: line.trim(), headers: new Map() };
      rules.push(current);
    } else if (current) {
      const index = line.indexOf(':');
      if (index === -1) {
        problems.push(`_headers: malformed line "${line.trim()}"`);
        continue;
      }
      current.headers.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
    if (line.length > 2000) problems.push('_headers: a line exceeds the 2000-character limit');
  }
  return rules;
}

const rules = parseHeaders(headers);
if (rules.length > 100) problems.push(`_headers: ${rules.length} rules exceeds the 100-rule limit`);

const global = rules.find((rule) => rule.path === '/*');
if (!global) {
  problems.push('_headers: no /* rule');
} else {
  const required = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
  };
  for (const [name, value] of Object.entries(required)) {
    if (global.headers.get(name) !== value) {
      problems.push(`_headers: /* ${name} should be "${value}", found "${global.headers.get(name)}"`);
    }
  }
  for (const name of ['Content-Security-Policy', 'Permissions-Policy', 'Strict-Transport-Security']) {
    if (!global.headers.has(name)) problems.push(`_headers: /* is missing ${name}`);
  }

  const hsts = global.headers.get('Strict-Transport-Security') ?? '';
  const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0);
  if (maxAge < 31536000) problems.push(`_headers: HSTS max-age ${maxAge} is under one year`);

  const csp = global.headers.get('Content-Security-Policy') ?? '';
  const directives = new Map(
    csp
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name, values];
      }),
  );

  for (const name of ['default-src', 'base-uri', 'object-src', 'frame-ancestors', 'form-action', 'script-src']) {
    if (!directives.has(name)) problems.push(`CSP: missing ${name}`);
  }
  if (directives.get('object-src')?.[0] !== "'none'") problems.push("CSP: object-src must be 'none'");
  if (directives.get('frame-ancestors')?.[0] !== "'none'") {
    problems.push("CSP: frame-ancestors must be 'none'");
  }
  if (directives.get('base-uri')?.[0] !== "'self'") problems.push("CSP: base-uri must be 'self'");

  const scriptSrc = directives.get('script-src') ?? [];
  if (scriptSrc.includes("'unsafe-eval'")) problems.push("CSP: script-src must not allow 'unsafe-eval'");

  // Every inline script in the build must be hash-pinned. `'unsafe-inline'` is
  // present only as a CSP Level 1 fallback and is ignored wherever hashes are
  // understood, so a missing hash is a real break on modern browsers.
  const expected = await computeScriptHashes(DIST);
  const missing = expected.filter((hash) => !scriptSrc.includes(hash));
  if (missing.length) {
    problems.push(
      `CSP: ${missing.length} inline script hash(es) missing from script-src — rerun \`npm run build\`:\n     ${missing.join('\n     ')}`,
    );
  }
  const stale = scriptSrc.filter((value) => value.startsWith("'sha256-") && !expected.includes(value));
  if (stale.length) {
    problems.push(`CSP: ${stale.length} stale hash(es) in script-src: ${stale.join(' ')}`);
  }
  console.log(`CSP pins ${expected.length} inline script hash(es)`);
}

// Immutable caching may only cover content-fingerprinted paths.
for (const rule of rules) {
  const cache = rule.headers.get('Cache-Control') ?? '';
  if (cache.includes('immutable') && !/^\/_astro\//.test(rule.path)) {
    problems.push(`_headers: immutable Cache-Control on non-fingerprinted path "${rule.path}"`);
  }
}
if (!rules.some((rule) => rule.path === '/_astro/*' && rule.headers.get('Cache-Control')?.includes('immutable'))) {
  problems.push('_headers: /_astro/* is missing the immutable Cache-Control rule');
}
const startRule = rules.find((rule) => rule.path === '/start');
if (startRule?.headers.get('Content-Type') !== 'text/markdown; charset=utf-8') {
  problems.push('_headers: /start must be served as text/markdown; charset=utf-8');
}
const previewRule = rules.find(
  (rule) => rule.path === 'https://:version.:subdomain.workers.dev/*',
);
if (previewRule?.headers.get('X-Robots-Tag') !== 'noindex, nofollow') {
  problems.push('_headers: Cloudflare version previews must be noindex, nofollow');
}

// --- redirects -------------------------------------------------------------
if (existsSync(redirectsPath)) {
  const redirects = await readFile(redirectsPath, 'utf8');
  const lines = redirects.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
  if (lines.length > 2100) problems.push(`_redirects: ${lines.length} rules exceeds the 2100 limit`);
  const seen = new Set();
  for (const line of lines) {
    if (line.length > 1000) problems.push('_redirects: a rule exceeds the 1000-character limit');
    const [from, to, code] = line.trim().split(/\s+/);
    if (!from?.startsWith('/')) problems.push(`_redirects: source "${from}" must start with /`);
    if (!to) problems.push(`_redirects: "${from}" has no destination`);
    if (code && !['301', '302', '303', '307', '308'].includes(code)) {
      problems.push(`_redirects: "${from}" uses unsupported status ${code}`);
    }
    if (seen.has(from)) problems.push(`_redirects: duplicate source "${from}"`);
    seen.add(from);
  }
  console.log(`_redirects: ${lines.length} rule(s)`);
}

if (problems.length) {
  console.error('\nHEADER/REDIRECT PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}
console.log('security headers, cache policy, and redirects validated');
