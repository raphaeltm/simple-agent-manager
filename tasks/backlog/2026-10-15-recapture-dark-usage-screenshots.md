# Re-capture the dark usage screenshots on /enterprise/cost-control/

> **Reconciliation 2026-10-26:** Still open; the images are unchanged since #2082. Two facts to
> add: each dark file is byte-identical to its `-light` sibling (same md5 for both PNGs and both
> WebPs), and the defect reaches a second page. The compute-pools feature page renders
> `sam-usage-tokens.png` from `apps/www/src/data/features/compute-pools.json:60` through the
> same dark/light picture pair.

## Problem

`apps/www/public/images/features/sam-usage-tokens.png` and `sam-usage-compute.png` (the dark-theme
variants) are light images: their mean luminance matches the `-light` siblings (244 of 255 for
all four). So `/enterprise/cost-control/` shows a light Settings → Usage screenshot to visitors in
dark mode, next to dark screenshots elsewhere on the site.

## Context

Found 2026-10-15 while verifying the doubled-screenshot fix in
`tasks/archive/2026-10-14-glasshouse-homepage-a2.md`: the page now correctly shows only the
`.shot-dark` picture in dark mode, which made the light content of that "dark" file visible. The
files came from `apps/web/tests/playwright/marketing-shots-compute.spec.ts` (`sam-usage-tokens`,
`sam-usage-compute`, captured via `marketingSpanShot`) in PR #2082.

## Acceptance Criteria

- [ ] Find why the dark run of `marketing-shots-compute.spec.ts` produces light Usage captures
      (theme not applied to that page, or captured with `MARKETING_THEME=light`)
- [ ] Re-capture both images in both themes (`MARKETING_SHOTS=1`, then `MARKETING_THEME=light`)
      and re-run `pnpm --filter @simple-agent-manager/www optimize:features`
- [ ] Dark files are visibly dark (and the light files light); check `/enterprise/cost-control/`
      in both themes
- [ ] Consider a unit test in `apps/www/tests/` that flags any themed pair whose dark and light
      files have near-identical mean luminance
