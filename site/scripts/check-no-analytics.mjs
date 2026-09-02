/** Fail if a default build ships executable analytics code. */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DIST = resolve(process.argv[2] ?? 'dist');
const GOOGLE = /googletagmanager\.com|google-analytics\.com|analytics\.google\.com/;
const failures = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
    } else if (/\.(?:js|css)$/.test(entry.name)) {
      const source = await readFile(path, 'utf8');
      if (GOOGLE.test(source)) failures.push(path.slice(DIST.length + 1));
    }
  }
}

await walk(DIST);
if (failures.length) {
  console.error(`analytics endpoint found in default build asset(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('default build contains no executable analytics endpoint');
