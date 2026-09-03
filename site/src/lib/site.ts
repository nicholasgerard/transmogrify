/** Static site-wide constants. No secrets, no account identifiers. */

export const SITE_NAME = 'Transmogrify';
export const SITE_ORIGIN = 'https://transmogrify.sh';
export const SITE_TAGLINE =
  'One skill that lets your coding agents put each other to work.';
export const SITE_DESCRIPTION =
  'Transmogrify is an open-source skill for Claude Code and Codex. Install it and either app can put the other to work — each job in its own worktree, visible in the desktop and mobile apps you already use, and steerable while it runs.';

/** Social card. Regenerate with `node scripts/make-images.mjs`. */
export const OG_IMAGE = { path: '/og.png', width: 1200, height: 630 } as const;

/**
 * Effective date shown on both legal pages. Kept here as well as in each
 * document's frontmatter so a check can prove they agree.
 */
export const LEGAL_EFFECTIVE_DATE = '2026-09-02';

export interface NavLink {
  label: string;
  href: string;
  external?: boolean;
}

/** Footer navigation, present on every page. */
export const FOOTER_LINKS: NavLink[] = [
  { label: 'Terms', href: '/terms' },
  { label: 'Privacy', href: '/privacy' },
];

/** Build a canonical URL for a repository-relative document. */
export function docUrl(repositoryUrl: string, path: string): string {
  return `${repositoryUrl}/blob/main/${path}`;
}

/** Canonical page URL with no trailing slash. */
export function canonical(origin: string, pathname: string): string {
  const clean = pathname.replace(/\/+$/, '');
  return clean === '' ? origin : `${origin}${clean}`;
}
