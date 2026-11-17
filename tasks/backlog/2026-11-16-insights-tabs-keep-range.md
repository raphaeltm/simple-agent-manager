# Insights tabs drop the selected range

## Problem

On the project Insights page (`/projects/:id/insights/*`), choosing 90 days on Flow and then
clicking the Accounts tab opens `/insights/accounts` with no `?range=`, so the page falls back
to 30 days. The range control says "the range stays in the page's address", but the tab links
are built from `basePath` + tab path only (`INSIGHTS_TABS` in
`apps/web/src/pages/insights/index.tsx`, rendered by `Tabs` from `@simple-agent-manager/ui`).

## Context

Found during staging verification of Insights slice A (PR #2810) on staging2, 2026-11-16: the
live check opened `flow?range=90d`, clicked Accounts, and landed on `insights/accounts`. Present
since slice F (#2789); not caused by slice A.

## Acceptance Criteria

- [ ] Switching between Insights tabs keeps the current `?range=`
- [ ] A Playwright test in `apps/web/tests/playwright/insights-audit.spec.ts` selects 90 days,
      switches tab, and asserts the new tab's URL and the range control both say 90 days
- [ ] Other users of the shared `Tabs` component are unaffected (or the fix is local to Insights)
