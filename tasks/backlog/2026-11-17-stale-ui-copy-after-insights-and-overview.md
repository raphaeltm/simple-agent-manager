# Stale UI copy after Insights token usage and the Overview landing

## Problem

1. `apps/web/src/pages/insights/AccountsTab.tsx` (footer) says "SAM does not record per-run token
   use for API keys". Since #2811 SAM records tokens per run and model and shows an estimated API-key
   spend on each run receipt; only the Accounts tab does not add them up yet.
2. `apps/web/src/components/NavSidebar.tsx` (`PROJECT_NAV_ITEMS` comment) says the project still
   opens in Chat; since #2793 the Overview is the index route.

## Context

Found 2026-11-17 during the weekly docs update; `guides/insights.md` was corrected in that PR.

## Acceptance Criteria

- [x] Accounts tab footer no longer says tokens are not recorded: the tab now shows tokens and API-key spend itself (#2828)
- [ ] NavSidebar comment describes the Overview as the landing page
