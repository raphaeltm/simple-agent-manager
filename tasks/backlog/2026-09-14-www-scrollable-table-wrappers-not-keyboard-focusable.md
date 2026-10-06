# Marketing site: scrollable table wrappers fail axe `scrollable-region-focusable`

## Problem

Several `overflow-x: auto` table wrapper `<div>`s in `apps/www` are scrollable on
narrow viewports but have no keyboard focus target, which axe-core flags as a
serious violation (`scrollable-region-focusable` — "Scrollable region must have
keyboard access", WCAG 2.1.1/2.1.3).

Found and fixed on `src/components/Comparison.astro`'s `.table-wrapper`
(homepage) while adding a new Playwright a11y test
(`tests/playwright/marketing-pages.spec.ts`) that exercises the homepage on
Mobile Chrome — the existing `public-surface-a11y.spec.ts` only covered
`/self-host/`, which doesn't contain a comparison table, so this class of bug
was never caught before.

The same `overflow-x: auto` pattern (without `tabindex="0"` / `role="region"` /
`aria-label`) also appears in:

- `src/pages/enterprise/index.astro` (`.comp-table-wrap`)
- `src/pages/enterprise/security.astro`
- `src/pages/enterprise/compliance.astro`
- `src/pages/self-host/index.astro`
- `src/pages/compare/paseo.astro`
- `src/layouts/BlogPost.astro`
- `src/components/GitHubAppSetup.astro`
- `src/components/placement/explorer.css`

These were not touched because they aren't exercised by any current Playwright
a11y test, and fixing all of them was out of scope for the marketing-content
task that surfaced this (`Execute this task using the /do skill.` was not
requested for this finding — filing per the bug-discovery policy in root
`CLAUDE.md`).

## Fix

For each `overflow-x: auto` wrapper around a `<table>`, add:

```astro
<div class="table-wrapper" tabindex="0" role="region" aria-label="<descriptive label>">
```

(See the applied fix in `Comparison.astro` for the pattern.)

## Acceptance Criteria

- [ ] Every `overflow-x: auto` table wrapper listed above gets `tabindex="0"`,
      `role="region"`, and a descriptive `aria-label`
- [ ] Add or extend Playwright a11y coverage (axe, serious/critical filter) for
      `/enterprise/`, `/enterprise/cost-control/`, `/self-host/`, and
      `/compare/paseo/` on a mobile viewport project, so this class of
      regression is caught going forward
- [ ] `pnpm --filter @simple-agent-manager/www test:browser` passes with zero
      serious/critical axe violations across the newly covered pages

## Execute

Execute this task using the /do skill.
