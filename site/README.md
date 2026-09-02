# transmogrify.sh

The public marketing and documentation site for Transmogrify: a static
[Astro](https://astro.build) build with no server, no database, and no
framework runtime in the browser.

This package is self-contained. It has its own `package.json` and lockfile, and
nothing it depends on reaches the repository root — the lifecycle tools keep
their `ws`-only runtime dependency contract, and `npm pack` at the root does not
include `site/`.

```
site/
├─ src/
│  ├─ content/            Markdown copy with typed frontmatter
│  │  ├─ sections/        Landing-page sections, ordered by `order`
│  │  └─ legal/           Terms of Service and Privacy Policy
│  ├─ components/         Presentational Astro components
│  ├─ layouts/            BaseLayout: metadata, landmarks, theme bootstrap
│  ├─ lib/                Pure, unit-tested logic (facts, consent, prompt)
│  ├─ pages/              /, /[slug] (legal), /404
│  ├─ scripts/            The only client JavaScript: copy, theme, consent
│  └─ styles/global.css   Tokens, reset, typography, focus, motion
├─ scripts/               Build-output tooling and audits (plain .mjs)
├─ test/                  node:test suites (.ts, run with native type stripping)
├─ public/                Icons, robots.txt, and redirects
├─ wrangler.jsonc         Static Assets routing and custom-domain contract
└─ performance-budgets.json
```

## Requirements

Node.js **22.18 or newer**. Astro 7 requires ≥ 22.12, and the test suite runs
`.ts` files directly through Node's native type stripping, which is on by
default from 22.18.

## Local development

```bash
cd site
npm ci
npm run dev          # http://localhost:4321
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm run build` | Production build into `dist/`, then generates `/start` and `dist/_headers` |
| `npm run preview` | Serve the built `dist/` locally |
| `npm run check` | `astro check` — Astro, TypeScript, and content-schema diagnostics |
| `npm test` | Unit tests for the pure logic and the content guarantees |
| `npm run verify` | All default build-output audits, including the disabled-or-pinned `/start` contract |

`npm run verify` runs against `dist/`, so build first.

## Content

Substantive copy lives in Markdown under `src/content/`, validated by the typed
schemas in `src/content.config.ts`.

- **`sections/*.md`** — the landing page. Prose is the Markdown body; anything
  the page renders as *structure* (ledger rows, install steps, document cards,
  the "not claimed yet" list) is typed frontmatter, so a copy edit cannot
  silently break a layout. `order` controls sequence; `module` selects which
  structural component renders after the prose.
- **`legal/*.md`** — the Terms of Service and Privacy Policy, rendered by
  `src/pages/[slug].astro`. Both must declare the same `effectiveDate` as
  `LEGAL_EFFECTIVE_DATE` in `src/lib/site.ts`; the page throws at build time if
  they disagree, and a unit test asserts it too.

Frontmatter strings support `` `code` `` and `**bold**` through
`src/lib/inline-code.ts` — deliberately those two forms and nothing else, so a
content field can never inject markup.

### Facts have exactly one home

The site does **not** keep its own copy of the compatibility matrix or the
version pins. `src/lib/repo-facts.ts` parses them out of the repository root at
build time:

| Fact on the site | Parsed from |
| --- | --- |
| Host → target support matrix | the `## Support matrix` table in `README.md` |
| Codex runtime/Desktop/mobile, Claude CLI/Desktop/mobile, verified date | the `metadata:` block in `SKILL.md` frontmatter |
| Version, repository URL, issues URL, Node engine, runtime deps | root `package.json` |

Every parser throws when its anchor is missing or malformed, so documentation
drift **fails the build** rather than shipping a stale page. If you rename that
README heading or restructure the SKILL.md frontmatter, the site build is the
thing that tells you.

Wire-level details, security boundaries, and full dated receipts link to their
canonical documents on GitHub. The landing page carries only enough summary to
explain current support; it is not a second protocol manual.

### Remote start prompt

The large copy action on the landing page is intentionally one line:
`Fetch https://transmogrify.sh/start and follow its instructions.` The full,
versioned Markdown prompt is generated into `dist/start` by
`scripts/build-start.mjs`. A production build must receive one exact published
Git object ID through `TRANSMOGRIFY_RELEASE_COMMIT`; the prompt fetches and
verifies that object and refuses branch fallback. Without the variable, `/start`
is a safe pre-release stop message and fetches nothing. Cloudflare serves it as
`text/markdown`, and tests keep its installation and ownership guardrails
aligned with the repository.

## Configuration

The analytics variable is optional and is not committed.

| Variable | Effect |
| --- | --- |
| `PUBLIC_GA_MEASUREMENT_ID` | A `G-XXXXXXX` measurement ID. **Absent by default.** With it absent, no analytics code, consent UI, or request-capable Google resource exists in the output. |
| `TRANSMOGRIFY_RELEASE_COMMIT` | Exact lowercase 40-character published release commit used to generate `/start`. **Absent by default**, which disables remote installation safely. |

Canonical metadata always points to `https://transmogrify.sh`. Cloudflare's
version-preview responses carry `X-Robots-Tag: noindex`, so previews remain
non-indexable without changing their build output.

## Analytics and consent behaviour

The default is **no analytics**. The privacy posture is enforced in three
independent places, and any one of them failing fails CI:

1. **Build time** — with no measurement ID the consent component is not rendered
   and no analytics code is emitted.
2. **`npm run verify:html` and `verify:no-analytics`** — assert that a build without a measurement ID
   contains no `<script>`, `<link>`, or `<img>` referencing Google, and no
   preconnect or DNS-prefetch of any kind.
3. **CI** — a separate `grep` over `dist/` as a framework-independent second
   check.

When a measurement ID *is* configured, `src/lib/consent.ts` decides what happens,
in this precedence order:

1. **Global Privacy Control or Do Not Track** → analytics stays off, no prompt is
   shown, and the footer explains why. A stored "allow" does not override the
   signal, and neither does reopening the choice.
2. **A stored choice** → honoured.
3. **Otherwise** → nothing loads and the visitor is asked.

Consent is required **worldwide**. There is no geography lookup: the decision
function takes no locale, region, or IP input, so no code path can enable
analytics by location. This is deliberately more conservative than the law
requires in some places, and it is also simpler and more reliable than
client-side geo-detection.

Other guarantees, each covered by a test:

- Nothing — no script, preconnect, DNS prefetch, or request — reaches Google
  before an affirmative click.
- Declining leaves every part of the site working.
- The **Privacy choices** control in the footer is permanent, states the current
  setting, and reopens the panel.
- Withdrawing consent sets `ga-disable-<ID>`, pushes a `consent update` denial,
  and expires the first-party `_ga`, `_ga_*`, `_gid`, and `_gat` cookies on the
  host and each registrable parent domain.
- The consent panel is non-modal and never traps focus.
- With `localStorage` unavailable the visitor is asked rather than assumed.

## Client JavaScript

Two modules, ~2 KB Brotli in the default build; the consent module is emitted
only by an explicitly analytics-enabled build:

| Module | Purpose |
| --- | --- |
| `src/scripts/theme.ts` | Keeps the theme radio group in sync and reacts to system changes |
| `src/scripts/copy.ts` | Copy buttons, with selection fallback when the clipboard is unavailable |
| `src/scripts/consent.ts` | DOM wiring for the consent policy |

Plus one inline pre-paint statement in `BaseLayout.astro` that commits the theme
before the first frame (so there is no flash of the wrong theme) and clears the
`no-js` class. Everything else is HTML and CSS.

Without JavaScript the page is fully usable: the prompt is present and
selectable, and the copy button and theme control are *removed* rather than left
as dead controls.

## Security headers and caching

`dist/_headers` is generated by `scripts/build-headers.mjs` as part of
`npm run build`. It computes a SHA-256 CSP hash for every inline `<script>` the
build actually produced, so the policy cannot drift from the output.
`'unsafe-inline'` is present only as a CSP Level 1 fallback and is ignored by any
browser that understands hashes.

`npm run verify:headers` re-derives the hashes from `dist/` and fails on a
mismatch, a stale hash, a weakened directive, or immutable caching applied to a
path that is not content-fingerprinted. Only `/_astro/*` is immutable; HTML stays
revalidatable.

`public/_redirects` provides short links to the canonical repository documents
(`/skill`, `/protocol`, `/security`, `/roadmap`, `/license`, `/issues`,
`/github`) and is validated against Cloudflare's documented syntax and limits.

## Verification

Run from `site/` after a clean install:

```bash
npm ci
npm run check
npm test
npm run build
npm run verify
```

`npm run verify` is six gates:

| Gate | What it proves |
| --- | --- |
| `verify:headers` | CSP hashes match the build; cache policy and redirects are valid |
| `verify:links` | Every internal link and in-page fragment resolves in `dist/` |
| `verify:html` | Landmarks, heading order, names, metadata, analytics posture, exact route set |
| `verify:no-analytics` | No executable JS or CSS asset contains a Google analytics endpoint |
| `verify:start` | `/start` is disabled without a release commit or pinned to and verifies the exact configured commit |
| `verify:budgets` | Per-route raw/gzip/Brotli/JS/CSS budgets and per-file ceilings |

If a size change is intentional:

```bash
node scripts/check-budgets.mjs --update
```

Review the JSON diff and explain the change in the pull request. Never update a
budget to make an unexplained regression pass.

### Browser checks (not in CI)

The static gates above are deliberately browser-free so CI stays fast and
installs no browser. A rendered pass is still worth running before a release.
Install Playwright temporarily and drive the preview server:

```bash
npm run build && npm run preview      # then, in another shell:
npm i --no-save playwright axe-core
npx playwright install chromium
```

Cover, at minimum: `/`, `/terms`, `/privacy`, `/404` × {dark, light} ×
{1440×900, 390×844, 320×568}, plus a reduced-motion run — and exercise copy,
the theme control, consent accept/decline/revisit, and the no-JavaScript
fallback. Record the rendered receipts in the release review, not in the public
source tree.

### Regenerating the icons and social card

The social card, touch icon, maskable icon, and `favicon.ico` are rendered once
and committed, so the site ships no image toolchain:

```bash
npm i --no-save playwright && npx playwright install chromium
node scripts/make-images.mjs
```

The design lives in the markup inside that script, not in the PNGs.

## CI

`.github/workflows/site.yml` is scoped to `site/` (plus `README.md`, `SKILL.md`,
and the root `package.json`, because the build reads facts from them). On Node
22 and 24 it installs from the lockfile and checks the default, analytics-free
build. Node 24 also builds a fake-ID analytics variant and applies the consent
and output audits before rebuilding the default artifact. CI asserts there is
no analytics code or source map in the uploaded `dist/`.

The root `ci.yml` independently verifies the lifecycle tools with their own
dependency set and test suite.

## Cloudflare deployment

The site deploys as a pure **Workers Static Assets** project: no Worker script,
function, database, or server runtime. Cloudflare recommends Static Assets for
new static projects, and it applies the generated `_headers` and `_redirects`
files natively.

`site/wrangler.jsonc` is the deployment source of truth. It pins the
`transmogrify-site` Worker name, serves the Astro `dist/` directory, preserves
extensionless canonical URLs, enables the generated 404 page, exposes immutable
preview versions, and maps production to the `transmogrify.sh` custom domain.

`.github/workflows/site-deploy.yml` is gated until the repository variable
`CLOUDFLARE_DEPLOY_ENABLED` is exactly `true`. To activate it:

1. Create a Cloudflare API token from the **Edit Cloudflare Workers** template,
   restricted to the one account and the `transmogrify.sh` zone.
2. Create a protected `production` GitHub Environment and restrict it to
   `main`. When the repository has at least two maintainers, add required
   reviewers and prevent self-review; a single-maintainer repository must omit
   that reviewer gate or every deployment will remain blocked.
3. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as secrets on that
   environment. Never store either value in a repository variable or file.
4. Keep the `production` environment variable `PUBLIC_GA_MEASUREMENT_ID` unset
   for the initial release. The opt-in
   implementation exists, but production activation remains gated on the legal
   details listed in the Privacy Policy.
5. Set the repository variable `CLOUDFLARE_DEPLOY_ENABLED=true` only after the GitHub repository and
   custom-domain zone are ready.

Once enabled, a verified `main` build runs `wrangler deploy`. Pull requests are
always build-only and never enter a credentialed job. The deploy job rebuilds
and reruns every output audit before the credentialed step. Its `/start` prompt
is pinned to the exact `${{ github.sha }}` checked out by the workflow and the
job verifies that object before building. Credentials are released only through
the protected `production` environment. Wrangler and every GitHub Action are
pinned.

Production deployment is live as of 2026-09-02. The protected environment
accepts only `main`, its Cloudflare credential is restricted to the deployment
account and the `transmogrify.sh` zone, and analytics remains unset.

Cloudflare receipts, verified 2026-09-01:

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Static-site routing and 404s](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/)
- [Static Assets headers](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Static Assets redirects](https://developers.cloudflare.com/workers/static-assets/redirects/)
- [Workers GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)

## License

MIT, same as the rest of the repository. See [`LICENSE`](../LICENSE).
