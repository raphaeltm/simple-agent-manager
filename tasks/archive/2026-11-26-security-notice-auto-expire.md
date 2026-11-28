# Make the pinned security advisory and homepage notice expire automatically

## Problem

Raphaël, replying to the #3008 result (2026-11-26): "Can you make it time out automatically after
two weeks?" The pin and the homepage notice shipped in #3008 stay until someone removes them.

## Research findings

- `apps/www` is static: dates checked at build time only take effect when the site rebuilds.
  `deploy-www.yml` runs on push to main (www paths) and on manual dispatch only.
- The pin is `pinned: true` in the advisory frontmatter (`src/content.config.ts` schema); the blog
  index (`src/pages/blog/index.astro`) and the homepage notice (`SecurityNotice.astro`, hard-coded
  slug) were independent, so expiring one would not expire the other.
- Browser tests (`blog-index.spec.ts`, `homepage.spec.ts`) asserted the pinned state unconditionally;
  they would start failing on every www PR after the expiry date.

## Checklist

- [x] `pinnedUntil` optional date in the blog schema; advisory set to 2026-12-09 (two weeks after it went live on 2026-11-25)
- [x] `isPinnedAt(data, now)` in `src/lib/blog-utils.ts`, used by the blog index
- [x] Homepage notice renders only while the advisory is pinned (same helper, link from the post id)
- [x] Daily `schedule` on `deploy-www.yml` so the expiry takes effect within a day without a push
- [x] Unit tests for `isPinnedAt` (no flag, no end date, before, at, after)
- [x] Browser tests assert the state the build should be in today (independent oracle from frontmatter), both branches exercised
- [x] Docs: `src/content/CLAUDE.md` (`pinnedUntil`), `apps/www/AGENTS.md`

## Acceptance criteria

- Before 2026-12-09 the advisory leads the blog and the homepage shows the notice (unchanged).
- From the first build on or after 2026-12-09, neither shows, and the advisory is in date order.
- The daily scheduled deploy rebuilds the site without a push.
- www browser tests pass on both sides of the date.

## Implementation notes

- Verified both states on a real build: pinned (44 passed, 2 skipped) and with the date moved to
  2026-11-20 (notice and pinned card absent; 44 passed, 2 skipped).
- Discrimination: with `isPinnedAt` ignoring `pinnedUntil` and an expired date, the unit test and
  both expired-branch browser tests failed. The first browser oracle imported the helper and did
  NOT fail; it now restates the rule independently.
- Full www suite 345 passed / 3 skipped; workflow hardening tests 71 passed; unit 66 passed.
