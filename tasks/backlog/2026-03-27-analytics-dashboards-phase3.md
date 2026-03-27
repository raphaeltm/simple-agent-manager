# Analytics Engine Phase 3 — Dashboards

## Problem

Phase 1 (server-side core) and Phase 2 (client-side tracker + ingest) of the Cloudflare Analytics Engine system are implemented. The admin analytics page currently shows DAU chart, top events table, and a basic conversion funnel. Phase 3 adds richer dashboard visualizations:

- **Feature adoption tracking** — which features are users engaging with and how adoption trends over time
- **Geographic distribution** — where are users located (from CF country headers already captured in `blob10`)
- **Retention cohorts** — are users coming back (using the 90-day Analytics Engine window)

## Research Findings

### Existing Infrastructure
- **Admin analytics page**: `apps/web/src/pages/AdminAnalytics.tsx` — has DauChart, EventsTable, FunnelChart, PeriodSelector
- **API routes**: `apps/api/src/routes/admin-analytics.ts` — has `/dau`, `/events`, `/funnel` endpoints with `queryAnalyticsEngine()` helper
- **Hook**: `apps/web/src/hooks/useAdminAnalytics.ts` — fetches all 3 endpoints in parallel with auto-refresh
- **API client**: `apps/web/src/lib/api.ts` — has `fetchAnalyticsDau/Events/Funnel` functions + response types

### Analytics Engine Schema (already captured)
- `index1`: userId (auth) or anon IP prefix
- `blob1`: event name
- `blob2`: projectId
- `blob3`: route/page pathname
- `blob10`: country (from CF headers)
- `blob8`: browser session ID
- `blob9`: user-agent bucket
- `double1`: duration/response time
- `double2`: HTTP status code

### Key Design Decisions
1. **Reuse existing `queryAnalyticsEngine()` helper** for all new SQL queries
2. **Add new API endpoints** alongside existing ones under `/api/admin/analytics/`
3. **Extend `useAdminAnalytics` hook** to include new data
4. **Add new chart components** to `AdminAnalytics.tsx` (split into child components if file exceeds 500 lines)
5. **All limits/periods configurable** via env vars (constitution Principle XI)

## Implementation Checklist

### Backend (API Routes)
- [ ] Add `GET /api/admin/analytics/feature-adoption` — counts per feature-event with daily trend
- [ ] Add `GET /api/admin/analytics/geo` — unique users by country
- [ ] Add `GET /api/admin/analytics/retention` — weekly cohort retention (signup week → return weeks)
- [ ] Add period query param support to new endpoints (24h/7d/30d/90d)
- [ ] Add configurable env vars: `ANALYTICS_GEO_LIMIT`, `ANALYTICS_RETENTION_WEEKS`

### Frontend (API Client)
- [ ] Add `fetchAnalyticsFeatureAdoption()` API client function + response type
- [ ] Add `fetchAnalyticsGeo()` API client function + response type
- [ ] Add `fetchAnalyticsRetention()` API client function + response type

### Frontend (Hook)
- [ ] Extend `useAdminAnalytics` to fetch feature adoption, geo, and retention data

### Frontend (Visualizations)
- [ ] Build `FeatureAdoptionChart` component — horizontal bars grouped by feature category
- [ ] Build `GeoDistribution` component — table/bar chart of top countries
- [ ] Build `RetentionCohorts` component — cohort table with retention percentages (heat-map coloring)
- [ ] Add new sections to `AdminAnalytics.tsx`
- [ ] Split `AdminAnalytics.tsx` into directory if it exceeds 500 lines

### Tests
- [ ] Unit tests for new API endpoints (feature adoption, geo, retention SQL queries)
- [ ] Unit tests for new frontend components (render with mock data, empty states)
- [ ] Unit test for hook extension

### Documentation
- [ ] Update CLAUDE.md recent changes with Phase 3 summary

## Acceptance Criteria

- [ ] Admin analytics page shows feature adoption chart with trend data
- [ ] Admin analytics page shows geographic distribution of users
- [ ] Admin analytics page shows retention cohort table
- [ ] All new endpoints are superadmin-protected
- [ ] All limits/periods are configurable via env vars
- [ ] All visualizations handle empty data gracefully
- [ ] Unit tests cover all new API endpoints and UI components
- [ ] No hardcoded values (constitution compliance)

## References

- Idea: Internal analytics system via Cloudflare Analytics Engine (01KMQ9S069MP8SXEBHN80FQY41)
- Phase 1 commit: 2a2e37f8
- Phase 2 commit: 7378eb63
- Existing analytics middleware: `apps/api/src/middleware/analytics.ts`
- Existing admin page: `apps/web/src/pages/AdminAnalytics.tsx`
- Existing API routes: `apps/api/src/routes/admin-analytics.ts`
