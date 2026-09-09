import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

/**
 * Landing-page sections.
 *
 * Prose lives in the Markdown body. Anything the page renders as structure —
 * the feature grid, the two provider diagrams, document cards — lives in typed
 * frontmatter so a content edit cannot silently break the layout.
 *
 * Facts with a canonical home in the repository root are NOT stored here. The
 * version pins are read from SKILL.md and the root package.json at build time
 * (see `src/lib/repo-facts.ts`), so this site has no second copy to drift.
 */
const sections = defineCollection({
  loader: glob({ base: './src/content/sections', pattern: '**/*.md' }),
  schema: z.object({
    /** Ascending render order on the landing page. */
    order: z.number().int().positive(),
    /** Fragment id and in-page nav target. */
    anchor: z.string().regex(/^[a-z][a-z0-9-]*$/),
    /** Short label for the section index. */
    label: z.string().min(2).max(28),
    /** Two-digit section number shown beside the heading. */
    number: z.string().regex(/^\d{2}$/),
    title: z.string().min(4),
    lede: z.string().optional(),
    /** Which structural module renders after the prose body. */
    module: z.enum(['prose', 'features', 'providers', 'docs']).default('prose'),
    /** Key features, each with one of the icons drawn in FeaturesModule. */
    features: z
      .array(
        z.object({
          icon: z.enum(['arrows', 'route', 'branch', 'eye', 'message', 'archive']),
          title: z.string(),
          detail: z.string(),
        }),
      )
      .optional(),
    /** One block per provider, each with the diagram drawn in ProvidersModule. */
    providers: z
      .array(
        z.object({
          id: z.enum(['claude', 'codex']),
          title: z.string(),
          body: z.string(),
          doc: z.object({
            label: z.string(),
            /** Repository-relative path; the canonical URL is built at render time. */
            path: z.string(),
          }),
        }),
      )
      .optional(),
    docs: z
      .array(
        z.object({
          title: z.string(),
          detail: z.string(),
          /** Repository-relative path; the canonical URL is built at render time. */
          path: z.string(),
        }),
      )
      .optional(),
  }),
});

/** Terms of Service and Privacy Policy. */
const legal = defineCollection({
  loader: glob({ base: './src/content/legal', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string(),
    description: z.string().min(40).max(300),
    /** Shown verbatim and used for the `dateModified` in page metadata. */
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    summary: z.string().min(40),
    order: z.number().int().positive(),
  }),
});

export const collections = { sections, legal };
