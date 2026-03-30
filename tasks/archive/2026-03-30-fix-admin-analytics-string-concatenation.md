# Fix Admin Analytics String Concatenation Bug

## Problem

The admin analytics page shows wildly incorrect numbers because Cloudflare Analytics Engine SQL API returns numeric aggregates as strings in JSON responses. Several API endpoints pass these strings through to the frontend unchanged. When the frontend performs arithmetic (reduce/sum), JavaScript concatenates strings instead of adding numbers.

**Example**: EVENTS (7D) shows `054808015562721344611629116811199628816` — individual daily event counts concatenated as strings.

## Root Cause

In `apps/api/src/routes/admin-analytics.ts`, the `queryAnalyticsEngine()` function returns raw JSON from the CF API. Some endpoints (`/website-traffic`, `/retention`) correctly convert with `Number()`, but these endpoints do NOT:

- `/dau` — `unique_users` returned as string
- `/events` — `count`, `unique_users`, `avg_response_ms` returned as strings
- `/funnel` — `unique_users` returned as string
- `/feature-adoption` — `count`, `unique_users` returned as strings in both `totals` and `trend`
- `/geo` — `event_count`, `unique_users` returned as strings

## Research Findings

- **Good pattern exists**: `/website-traffic` (line 454-457, 485-487) correctly uses `Number()` conversion
- **Frontend types are correct**: `AnalyticsEventsResponse` declares `count: number` etc. — but TypeScript types don't enforce runtime JSON types
- **Frontend arithmetic is correct**: `reduce((s, e) => s + e.count, 0)` would work if values were numbers
- **Fix location**: API layer (convert before sending to client), not frontend

## Implementation Checklist

- [ ] Add `Number()` conversion to `/dau` endpoint for `unique_users`
- [ ] Add `Number()` conversion to `/events` endpoint for `count`, `unique_users`, `avg_response_ms`
- [ ] Add `Number()` conversion to `/funnel` endpoint for `unique_users`
- [ ] Add `Number()` conversion to `/feature-adoption` endpoint for `count`, `unique_users` in both queries
- [ ] Add `Number()` conversion to `/geo` endpoint for `event_count`, `unique_users`
- [ ] Add unit test verifying numeric conversion for all affected endpoints
- [ ] Verify `/retention` and `/website-traffic` remain unaffected (already correct)

## Acceptance Criteria

- [ ] All KPI summary cards display correct numeric values (not concatenated strings)
- [ ] Event counts are summed, not concatenated
- [ ] DAU averages are mathematically correct
- [ ] Feature adoption chart shows correct counts
- [ ] Geo distribution shows correct counts
- [ ] All existing analytics tests still pass

## References

- Screenshot: `/workspaces/.private/Simple Agent Manager 2026-03-30 20.54.21.png`
- API code: `apps/api/src/routes/admin-analytics.ts`
- Frontend KPI: `apps/web/src/pages/admin-analytics/KpiSummary.tsx`
- Good pattern: `admin-analytics.ts:454-457` (website-traffic Number() conversions)
