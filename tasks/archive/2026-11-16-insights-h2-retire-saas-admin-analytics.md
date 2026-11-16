# Insights H2: retire SaaS-era Admin Analytics sections

Task: 01M7K7EH5AW0WS77NP9CY4S8TT. Spec: idea 01M7HTS38KX2G78JD0ESAGMKKH (decision 3, slice H2). Depends on slice H (#2784, merged as 0f52c9cae).

## Problem

Raphaël decided to retire the SaaS-era parts of Admin Analytics (signup funnel, geographic
breakdown, weekly retention cohorts) once Admin Health & cost shipped. They answer
growth-funnel questions a self-hosted installation does not have. Daily active users, feature
adoption, website traffic, top events, AI usage and event forwarding stay.

## Research findings

- API: `apps/api/src/routes/admin-analytics.ts` (`/funnel`, `/geo`),
  `apps/api/src/routes/admin-analytics-audience.ts` (`/retention`, plus `/website-traffic`,
  which stays), constants in `apps/api/src/routes/admin-analytics-query.ts`
  (`DEFAULT_GEO_LIMIT`, `DEFAULT_RETENTION_WEEKS`, `MAX_RETENTION_QUERY_ROWS`).
- Route-to-event names in `apps/api/src/middleware/analytics.ts` (`admin_analytics_funnel|geo|retention`).
- Env: `ANALYTICS_GEO_LIMIT`, `ANALYTICS_RETENTION_WEEKS` in `apps/api/src/env.ts`,
  `apps/api/.env.example`, `scripts/quality/runtime-tunables-baseline.json`, public
  `reference/configuration.md`. Not in `wrangler.toml`, sync-wrangler-config or workflows.
- Web: `FunnelChart`, `GeoDistribution`, `RetentionCohorts` components, `KpiSummary`
  "Funnel Conversion" card, `useAdminAnalytics` queries, `lib/api/admin-analytics.ts` types
  and fetchers, `lib/api/index.ts` re-exports. `GeoDistribution` is the only user of
  `react-simple-maps`, `d3-scale` and `VITE_GEO_TOPOJSON_URL` (`apps/web/.env.example`).
- Tests: `apps/api/tests/unit/routes/admin-analytics.test.ts`,
  `apps/web/tests/unit/admin-analytics-charts.test.tsx`,
  `apps/web/tests/unit/hooks/useAdminAnalytics.test.ts`,
  `apps/web/tests/playwright/admin-analytics-audit.spec.ts`.
- Storage: all three sections read the Cloudflare Analytics Engine dataset. No D1 table is
  used only by them. The dataset stays: DAU, events, adoption, website traffic and forwarding
  read it. `blob10` (country) is still read by `services/analytics-forward.ts`, so the
  middleware and ingest keep writing it. No migration.
- Admin navigation: the Analytics tab stays; Health & cost (`admin-health-cost/*`) only imports
  `chartTokens`, which stays. No links to the removed sections exist.

## Checklist

- [x] API: delete `/funnel`, `/geo`, `/retention` handlers and their constants; delete the
      orphan retention doc comment; fold `/website-traffic` registration so no dead helper stays
- [x] API: drop the three route-to-event names in the analytics middleware
- [x] Env: remove `ANALYTICS_GEO_LIMIT`, `ANALYTICS_RETENTION_WEEKS` (env.ts, .env.example,
      runtime-tunables baseline, configuration.md)
- [x] Web: delete the three components, their exports, types, fetchers, hook queries and the
      KPI funnel card; tidy the page error condition
- [x] Web: remove `react-simple-maps`, `d3-scale` and their types; remove `VITE_GEO_TOPOJSON_URL`
- [x] Tests: remove tests for removed routes/components; add tests that the removed routes 404
      and the remaining routes still answer; update hook and Playwright audit mocks
- [x] Docs: update public docs that mention the removed sections
- [x] Playwright audit of Admin Analytics at 375 and 1280, realistic and empty data
- [ ] Staging: remaining sections render from real data, removed routes 404, non-superadmin 403

## Acceptance criteria

- [ ] `GET /api/admin/analytics/{funnel,geo,retention}` return 404 for a superadmin
- [ ] DAU, events, feature adoption, website traffic, AI usage and forward status work unchanged
- [ ] Non-superadmin still gets 403 on remaining analytics routes
- [ ] No reference to removed functions, routes, types, env vars or dependencies remains
- [ ] No table dropped, no stored data deleted

## Implementation notes

- `admin-analytics-audience.ts` held only `/retention` and `/website-traffic`; it is now
  `admin-analytics-website-traffic.ts` (`registerAdminWebsiteTrafficRoutes`).
- The KPI row lost its funnel card; the grid is now 2 columns on phones and 3 on desktop, and
  an odd last card spans the phone row.
- Found and fixed while auditing: `chartCategoryTick` used `--sam-color-fg-secondary`, which
  is not defined, so the Feature Adoption and Website Traffic category labels rendered black on
  dark panes. It now uses `--sam-color-fg-primary`. The same undefined token in
  `FailureCard.tsx` is filed as `tasks/backlog/2026-11-16-failure-card-undefined-fg-secondary-token.md`.
- The Playwright error-state tests captured a spinner (fixed 600 ms wait raced the failed
  queries); they now wait for the settled empty states.
- The API tests for the retired routes were proven discriminating: run against the
  `origin/main` route files, all five 404 cases fail.
