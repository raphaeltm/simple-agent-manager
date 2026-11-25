# Pin the security advisory on the blog and warn on the homepage

## Problem

The setup-takeover security advisory (`apps/www/src/content/blog/security-advisory-setup-takeover.md`,
2026-11-15) has been pushed down the blog index by daily journal posts, and the homepage gives
self-hosters no hint it exists. Raphaël asked to pin it as the first blog post and add a warning on
the front page, reviewed the screenshots, and said "Ship it" (chat task 01M8973SEN29AT97RHF0Y35QJ9).

## Research findings

- Blog collection schema: `apps/www/src/content.config.ts`; index sorts by date only
  (`apps/www/src/pages/blog/index.astro`). `[slug].astro` is unaffected by ordering.
- Homepage hero: `apps/www/src/components/factory/FactoryHero.astro`, rendered by `FactoryHome.astro`.
- Amber token `--color-warning` exists in both themes (`packages/ui/src/brand/brand.css`).
- Browser tests: `apps/www/tests/playwright/homepage.spec.ts`, `marketing-pages.spec.ts`; CI runs
  `test:browser` on www changes (`.github/workflows/ci.yml`, marketing job).
- Frontmatter docs: `apps/www/src/content/CLAUDE.md` (optional fields table) and `apps/www/AGENTS.md`.
- No staging for `apps/www`; it deploys through `deploy-www.yml` on push to main (policy 8afaafbb).

## Checklist

- [x] Add optional `pinned` boolean to the blog schema (default false)
- [x] Set `pinned: true` on the advisory
- [x] Blog index: pinned posts first as a full-width card (amber + "Security advisory" for security-tagged posts), rest in date order
- [x] Homepage: `SecurityNotice.astro` at the top of the hero linking to the advisory
- [x] Accessibility: notice keeps its visible text as the link name (no role/aria-label override)
- [x] Playwright tests: blog index lists the pinned advisory first even though newer posts exist; homepage notice links to the advisory; no overflow/serious axe violations
- [x] Document `pinned` in `src/content/CLAUDE.md` and `apps/www/AGENTS.md`
- [x] www lint, typecheck, build + link check, unit tests, browser tests
- [x] Desktop/mobile, dark/light screenshots checked

## Acceptance criteria

- The advisory is the first post on `/blog/`, above newer posts, in a visually distinct pinned card.
- The homepage shows an amber security warning above the hero badge that links to the advisory.
- No horizontal overflow at 375px and 1280px; no serious/critical axe violations.
- Removing `pinned: true` returns the advisory to date order (covered by the schema default).

## Implementation notes

- Validation: www lint, typecheck (exit 0, 1 pre-existing baseline error), unit tests 63/63, build,
  link check (0 broken), full www browser suite 343 passed / 1 skipped against a
  `PUBLIC_BASE_DOMAIN=localhost` production build.
- Discrimination: removing `pinned: true` and `<SecurityNotice />` turned both new tests red;
  restoring turned them green.
- The blog index axe check settles `.animate-on-scroll` first (same as `marketing-pages.spec.ts`);
  without it axe samples the page header mid-fade.
- Local Chromium lacked system libraries; they were extracted from Debian packages into `.tmp/`
  (no sudo) and passed via `LD_LIBRARY_PATH`.
