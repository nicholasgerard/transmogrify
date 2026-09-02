/**
 * Build-time binding between the site and the repository's canonical docs.
 *
 * The root Markdown and manifest are pulled in with Vite's `?raw` import so the
 * facts are resolved while the bundle is built. Nothing is read from disk at
 * render time, and nothing here ships to the browser.
 */
import readmeSource from '../../../README.md?raw';
import skillSource from '../../../SKILL.md?raw';
import rootPackageSource from '../../../package.json?raw';

import { buildRepoFacts, type RepoFacts } from './repo-facts.ts';

let cached: RepoFacts | undefined;

export function getRepoFacts(): RepoFacts {
  cached ??= buildRepoFacts({
    readme: readmeSource,
    skill: skillSource,
    rootPackageJson: JSON.parse(rootPackageSource),
  });
  return cached;
}
