# Self-host D1 analytics sink records machine traffic

## Problem

On a self-hosted box with the D1 analytics sink active (`installAnalyticsD1Sink()` +
`ANALYTICS_SINK="d1"`, `apps/api/src/selfhost/analytics/`), `analyticsMiddleware()`
(`apps/api/src/middleware/analytics.ts`) writes one `analytics_events` row per recorded API
request, including VM-agent heartbeats and callback routes. At a sustained 5 requests/s that is
~430k rows a day, so the default `analytics.d1.maxRows` (500,000) is reached in about 1.2 days
and the row cap, not the 90-day age limit, decides retention. Admin analytics for 30/90 days then
silently covers about a day.

Cloudflare is unaffected (Analytics Engine; the sink is never installed there).

## Context

Raised as MEDIUM by the performance reviewer on PR #2889 (L20). Deferred because the sink has no
caller on main yet (the celld entry installs it with the self-host packaging slice) and the right
default skip list is a product decision about what counts as product analytics on a box.

## Acceptance Criteria

- [ ] The self-host sink skips machine routes by default (VM-agent callbacks, heartbeats, internal
      ingest), e.g. a self-host default for `ANALYTICS_SKIP_ROUTES` or a sink-side filter
- [ ] The retention arithmetic (inflow vs `analytics.d1.maxRows`) is stated in the self-host docs
- [ ] A test drives the real middleware with a callback route and asserts no row is written, with
      a product-route control that is written
