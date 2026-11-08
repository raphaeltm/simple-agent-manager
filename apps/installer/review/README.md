# Installer review evidence

Captured with Playwright from the installer branch and its local fixture services.
The data is synthetic: 35 accounts, long Unicode/HTML-like account names, domain
conflicts, failures and cleanup, plus maintenance job states. No paid build ran.

- `brand-comparison-*`: homepage (left), redesigned installer (right).
- `plan-maintenance-*`: reviewed installation plan (left), account-owned maintenance controls (right).
- `homepage-refactor-*`: original homepage (left), extracted shared brand (right).
- `homepage-diff-*`: full-page absolute RGB difference amplified 8×; unchanged pixels are black.
- `homepage-diffs.json`: exact dimensions and changed-pixel counts at a >2/channel threshold.
- `privacy-*`, `self-host-*`, `handoff-*`: complete desktop/mobile captures, both themes.

The audit ran all states at 320, 375 and 1280px in light and dark (126 captures).
Homepage baselines/refactor captures use 375 and 1440px, reduced motion. Dimensions
are unchanged and differences remain below 0.04%; these include minor rasterization
and settled scene differences. Screenshots were opened and reviewed for clipping,
overflow, readability and responsive behavior. The narrow stepper was fixed.
Agent review is evidence, not Raphaël's design approval.

Reproduce with a local www server on 4321 and installer on 8787:
`node scripts/homepage-comparison.mjs before` before editing, `... after` after,
`node scripts/compare-images.mjs`, `pnpm test:browser`, then
`node scripts/review-images.mjs` from `apps/installer`.
The original full screenshots stay in `.codex/tmp/playwright-screenshots/` locally;
these compressed comparisons and pixel diffs are retained for PR review.
