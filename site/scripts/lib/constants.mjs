/** Shared by the build-output checkers. Kept out of `src/` so the checks never
 *  depend on the Astro/Vite module graph. */
export const SITE_ORIGIN = 'https://transmogrify.sh';

/** Routes the site is expected to emit. A new or missing route fails the audit. */
export const EXPECTED_ROUTES = ['/', '/terms', '/privacy', '/404'];
