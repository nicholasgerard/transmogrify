/**
 * Deterministic bundle and performance-budget audit over `dist/`.
 *
 * For each emitted route it follows the local resources the HTML actually
 * references — stylesheets, scripts, images — and measures each response
 * independently at gzip level 9 and Brotli quality 11. Those are stable
 * comparison numbers, not a claim about a particular browser's negotiated
 * transfer size.
 *
 * Budgets live in `performance-budgets.json`. Run with `--update` to rewrite
 * them from the current build; a PR that does so must explain the change.
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { parseHTML } from 'linkedom';

const DIST = resolve('dist');
const BUDGET_FILE = resolve('performance-budgets.json');
const update = process.argv.includes('--update');

const gz = (buffer) => gzipSync(buffer, { level: 9 }).length;
const br = (buffer) =>
  brotliCompressSync(buffer, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buffer.length },
  }).length;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function readIfExists(path) {
  try {
    if (!(await stat(path)).isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

function routeOf(file) {
  const rel = file.slice(DIST.length).replace(/\\/g, '/');
  if (rel === '/index.html') return '/';
  if (rel === '/404.html') return '/404';
  return rel.replace(/\/index\.html$/, '');
}

const allFiles = await walk(DIST);
const htmlFiles = allFiles.filter((f) => f.endsWith('.html')).sort();
if (htmlFiles.length === 0) {
  console.error('No HTML in dist/. Run `npm run build` first.');
  process.exit(1);
}

const measured = {};

for (const file of htmlFiles) {
  const route = routeOf(file);
  const html = await readFile(file);
  const { document } = parseHTML(html.toString('utf8'));

  const totals = {
    rawBytes: html.length,
    gzipBytes: gz(html),
    brotliBytes: br(html),
    jsBrotliBytes: 0,
    cssBrotliBytes: 0,
    mediaRawBytes: 0,
    requests: 1,
  };

  const references = new Set();
  for (const el of document.querySelectorAll('link[rel="stylesheet"][href], script[src], img[src]')) {
    const value = el.getAttribute('href') ?? el.getAttribute('src') ?? '';
    if (value.startsWith('/') && !/^\/\//.test(value)) references.add(value.split('?')[0]);
  }

  for (const reference of [...references].sort()) {
    const buffer = await readIfExists(resolve(DIST, reference.slice(1)));
    if (!buffer) {
      console.error(`${route}: referenced asset ${reference} is missing from dist`);
      process.exitCode = 1;
      continue;
    }
    totals.rawBytes += buffer.length;
    totals.gzipBytes += gz(buffer);
    const brotli = br(buffer);
    totals.brotliBytes += brotli;
    totals.requests += 1;
    if (reference.endsWith('.js')) totals.jsBrotliBytes += brotli;
    else if (reference.endsWith('.css')) totals.cssBrotliBytes += brotli;
    else totals.mediaRawBytes += buffer.length;
  }

  measured[route] = totals;
}

// Whole-deploy size catches dependency and artifact growth that no single route
// reveals — the social card and icon set, for instance.
const deployRaw = (await Promise.all(allFiles.map(async (f) => (await stat(f)).size))).reduce(
  (a, b) => a + b,
  0,
);

const current = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString().slice(0, 10),
  headroomPercent: 10,
  globalLimits: {
    maxAssetRawBytes: 262144,
    maxScriptRawBytes: 32768,
    maxStyleRawBytes: 65536,
  },
  deploy: { rawBytes: deployRaw },
  routes: measured,
};

if (update) {
  await writeFile(BUDGET_FILE, JSON.stringify(current, null, 2) + '\n', 'utf8');
  console.log(`updated ${BUDGET_FILE}`);
  console.table(
    Object.fromEntries(
      Object.entries(measured).map(([route, t]) => [
        route,
        { raw: t.rawBytes, gzip: t.gzipBytes, brotli: t.brotliBytes, js: t.jsBrotliBytes, req: t.requests },
      ]),
    ),
  );
  process.exit(0);
}

const budgets = JSON.parse(await readFile(BUDGET_FILE, 'utf8'));
const headroom = 1 + budgets.headroomPercent / 100;
const problems = [];

function compare(label, actual, budget) {
  const ceiling = Math.ceil(budget * headroom);
  if (actual > ceiling) {
    problems.push(
      `${label}: ${actual} B exceeds budget ${budget} B (+${budgets.headroomPercent}% = ${ceiling} B)`,
    );
  }
}

for (const [route, totals] of Object.entries(measured)) {
  const budget = budgets.routes[route];
  if (!budget) {
    problems.push(`route ${route} has no recorded budget — run with --update and explain the change`);
    continue;
  }
  for (const key of ['rawBytes', 'gzipBytes', 'brotliBytes', 'jsBrotliBytes', 'cssBrotliBytes', 'mediaRawBytes']) {
    compare(`${route} ${key}`, totals[key], budget[key]);
  }
  if (totals.requests > budget.requests) {
    problems.push(`${route}: ${totals.requests} requests exceeds budget ${budget.requests}`);
  }
}

for (const route of Object.keys(budgets.routes)) {
  if (!measured[route]) problems.push(`budgeted route ${route} is no longer emitted`);
}

compare('deploy rawBytes', deployRaw, budgets.deploy.rawBytes);

// Per-file ceilings catch a single oversized asset that a route total hides.
for (const file of allFiles) {
  const size = (await stat(file)).size;
  const name = file.slice(DIST.length);
  if (file.endsWith('.js') && size > budgets.globalLimits.maxScriptRawBytes) {
    problems.push(`${name}: ${size} B exceeds maxScriptRawBytes ${budgets.globalLimits.maxScriptRawBytes}`);
  } else if (file.endsWith('.css') && size > budgets.globalLimits.maxStyleRawBytes) {
    problems.push(`${name}: ${size} B exceeds maxStyleRawBytes ${budgets.globalLimits.maxStyleRawBytes}`);
  } else if (size > budgets.globalLimits.maxAssetRawBytes) {
    problems.push(`${name}: ${size} B exceeds maxAssetRawBytes ${budgets.globalLimits.maxAssetRawBytes}`);
  }
}

console.log(`budgets from ${budgets.updatedAt}, +${budgets.headroomPercent}% headroom\n`);
for (const [route, t] of Object.entries(measured)) {
  console.log(
    `${route.padEnd(10)} raw ${String(t.rawBytes).padStart(7)}  gzip ${String(t.gzipBytes).padStart(6)}` +
      `  brotli ${String(t.brotliBytes).padStart(6)}  js(br) ${String(t.jsBrotliBytes).padStart(5)}` +
      `  css(br) ${String(t.cssBrotliBytes).padStart(5)}  requests ${t.requests}`,
  );
}
console.log(`\ndeploy tree: ${deployRaw} B raw across ${allFiles.length} files`);

if (problems.length) {
  console.error('\nBUDGET FAILURES:\n' + problems.map((p) => ' - ' + p).join('\n'));
  console.error('\nIf the growth is intended: node scripts/check-budgets.mjs --update, then explain it in the PR.');
  process.exit(1);
}
console.log('\nall routes within budget');
