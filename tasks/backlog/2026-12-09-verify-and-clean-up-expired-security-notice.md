# Verify the security advisory pin expired, then remove the advisory-specific notice code

## Problem

The setup-takeover advisory is pinned on the blog and announced by a homepage notice until
2026-12-09 (`pinnedUntil` in `apps/www/src/content/blog/security-advisory-setup-takeover.md`,
PR #3013). Expiry relies on the daily scheduled run of `.github/workflows/deploy-www.yml`
(04:17 UTC). A failed scheduled run raises no alert, so the expiry must be checked on the live site.
After expiry the advisory-specific code is dormant and should be removed (no dead code).

## Context

Follow-up from the task-completion review of #3013 (findings M1, M2, L3). A SAM scheduled session
on 2026-12-09 is meant to pick this up.

## Checklist

- [ ] After 2026-12-09 04:17 UTC, confirm the latest scheduled `deploy-www.yml` run succeeded
- [ ] Confirm https://www.simple-agent-manager.org/ has no `.fh-notice` and /blog/ has no `.pinned-card`, with the advisory in date order. If either still shows, find out why the rebuild did not run and fix it; tell Raphaël via the inbox
- [ ] Remove `apps/www/src/components/factory/SecurityNotice.astro` and its use in `FactoryHero.astro`
- [ ] Remove `pinned` / `pinnedUntil` from the advisory frontmatter
- [ ] Remove `apps/www/tests/playwright/advisory-pin.ts` and the advisory-specific tests in `blog-index.spec.ts` and `homepage.spec.ts`. Keep generic pin coverage (`tests/blog-pin.test.ts`)
- [ ] Decide on the daily cron in `deploy-www.yml`: keep it for future `pinnedUntil` uses (cheap) or remove it with its docs in `apps/www/AGENTS.md` and `src/content/CLAUDE.md`
- [ ] Update `apps/www/AGENTS.md` (drop the `SecurityNotice.astro` row)

## Acceptance criteria

- The live homepage and blog show no advisory notice or pin.
- No code or test refers to the advisory pin.
- www lint, typecheck, unit and browser tests pass.
