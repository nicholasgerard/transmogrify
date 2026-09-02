/** Verify the consent-gated shape of a build with analytics configured. */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DIST = resolve(process.argv[2] ?? 'dist');
const measurementId = (process.env.PUBLIC_GA_MEASUREMENT_ID ?? '').trim();
if (!/^G-[A-Z0-9]+$/i.test(measurementId)) {
  throw new Error('PUBLIC_GA_MEASUREMENT_ID must be set to a test GA4 ID');
}

const index = await readFile(join(DIST, 'index.html'), 'utf8');
if (!index.includes(`data-analytics-id="${measurementId}"`)) {
  throw new Error('analytics-enabled build omitted its measurement ID');
}
if (!/<a[^>]*href="\/privacy#analytics"[^>]*data-privacy-choices/.test(index)) {
  throw new Error('analytics-enabled build needs an enhanced privacy link with a no-JavaScript destination');
}
if (!/<section[^>]*id="consent-dialog"[^>]*hidden/.test(index)) {
  throw new Error('analytics-enabled build omitted the initially hidden consent region');
}
if (/<(?:script|link|img)[^>]+(?:src|href)="https:\/\/(?:www\.)?(?:googletagmanager|google-analytics|analytics\.google)\.com/i.test(index)) {
  throw new Error('analytics-enabled HTML requests Google before consent');
}

let consentAsset = false;
for (const entry of await readdir(join(DIST, '_astro'), { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
  const source = await readFile(join(DIST, '_astro', entry.name), 'utf8');
  if (source.includes('www.googletagmanager.com/gtag/js')) consentAsset = true;
}
if (!consentAsset) throw new Error('analytics-enabled build omitted the consent-gated loader');

console.log('analytics-enabled artifact preserves consent and no-JavaScript controls');
