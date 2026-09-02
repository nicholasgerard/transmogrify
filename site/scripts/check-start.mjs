/** Verify that /start is either safely disabled or pinned to one release commit. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = await readFile(resolve(process.argv[2] ?? 'dist/start'), 'utf8');
const releaseCommit = (process.env.TRANSMOGRIFY_RELEASE_COMMIT ?? '').trim();

if (!releaseCommit) {
  if (!/not published yet[\s\S]*Stop here/.test(source) || /git\s+(?:clone|fetch)/.test(source)) {
    throw new Error('pre-release /start must stop without fetching executable source');
  }
  console.log('/start is safely disabled before release');
} else {
  if (!source.includes(releaseCommit)) throw new Error('/start omitted the configured release commit');
  if (!/fetch --depth 1 origin "\$TRANSMOGRIFY_RELEASE_COMMIT"/.test(source)) {
    throw new Error('/start does not fetch the exact configured commit');
  }
  if (!/rev-parse HEAD/.test(source) || !/never fall back[^\n]*default branch/.test(source)) {
    throw new Error('/start does not verify the checkout or refuse branch fallback');
  }
  console.log('/start is pinned to and verifies the configured release commit');
}
