# Website Analytics Tracking + Admin Traffic Dashboard

## Problem

The marketing site (`apps/www/`, Astro + Starlight, deployed to `www.simple-agent-manager.org`) has zero analytics instrumentation. Page visits don't appear anywhere. The admin analytics dashboard only covers the app (`apps/web/`).

## Research Findings

### Analytics Engine Blob Schema
- blob1: event name
- blob2: projectId (empty string `''` for client events, populated for API events)
- blob3: page/route
- blob4: referrer
- blob5: utm_source
- blob6: utm_medium
- blob7: utm_campaign
- blob8: sessionId (browser) / requestId (API)
- blob9: UA bucket (server-derived)
- blob10: country (CF)
- blob11: entityId

**Decision**: Store `host` in blob2 for client events (it's already empty). This reuses an existing slot without needing new blob fields. Server-side, derive host from Origin/Referer header when not explicitly provided by the client.

### Client Analytics Pattern (`apps/web/src/lib/analytics.ts`)
- 310-line library with batching, session/visitor IDs, UTM capture, sendBeacon
- Sends to `POST /api/t` with schema: event, page, referrer, utmSource, utmMedium, utmCampaign, sessionId, visitorId, entityId, durationMs, timestamp

### Ingest Endpoint (`apps/api/src/routes/analytics-ingest.ts`)
- Accepts batch of events, validates/truncates, writes to Analytics Engine
- Currently does NOT accept or derive a host field
- Uses `waitUntil` for fire-and-forget writes

### CORS (`apps/api/src/index.ts`)
- Default-deny with subdomain check: `hostname === baseDomain || hostname.endsWith('.baseDomain')`
- `www.simple-agent-manager.org` → `api.simple-agent-manager.org` already allowed

### Marketing Site
- `apps/www/src/layouts/Base.astro` — clean head, no analytics
- `apps/www/astro.config.mjs` — Starlight head config accepts `{ tag, attrs, content }` entries

### Admin Analytics
- `apps/api/src/routes/admin-analytics.ts` — 6 existing endpoints, all superadmin-protected
- `apps/web/src/pages/AdminAnalytics.tsx` — renders chart components from `admin-analytics/` directory
- `apps/web/src/hooks/useAdminAnalytics.ts` — fetches all analytics data in parallel

### Key Files
- `apps/www/src/layouts/Base.astro` — inject tracker script
- `apps/www/astro.config.mjs` — Starlight head config for docs
- `apps/api/src/routes/analytics-ingest.ts` — accept host, store in blob2
- `apps/api/src/routes/admin-analytics.ts` — add website-traffic endpoint
- `apps/web/src/pages/AdminAnalytics.tsx` — add Website Traffic section
- `apps/web/src/hooks/useAdminAnalytics.ts` — add fetch for website traffic
- `apps/web/src/pages/admin-analytics/` — add WebsiteTraffic component

## Implementation Checklist

- [ ] 1. Create standalone tracker script (`apps/www/public/scripts/tracker.js`)
  - ~50 lines vanilla JS
  - Tracks page_view events with: page, referrer, UTM params, sessionId, visitorId, host
  - sendBeacon on page unload for reliability
  - Session ID via sessionStorage, visitor ID via localStorage
  - Sends to configurable API endpoint (data attribute on script tag)
- [ ] 2. Inject tracker into `Base.astro` layout
  - Add script tag referencing tracker.js
  - Pass API URL via data attribute: `data-api="https://api.simple-agent-manager.org/api/t"`
- [ ] 3. Inject tracker into Starlight head config (`astro.config.mjs`)
  - Add inline script or script tag to Starlight `head` array
- [ ] 4. Modify ingest endpoint to accept and store host
  - Accept optional `host` field in event schema
  - Fall back to deriving from Origin/Referer header if not provided
  - Store in blob2 for client events (currently empty string)
  - Preserve blob2=projectId behavior for API middleware events
- [ ] 5. Add `GET /api/admin/analytics/website-traffic` endpoint
  - Query Analytics Engine for page_view events where blob2 contains a host
  - Group by host + path prefix (Landing `/`, Blog `/blog/*`, Docs `/docs/*`, Presentations `/presentations/*`)
  - Return section totals + top pages within each section
  - Accept `period` query param consistent with existing endpoints
  - Configurable limits via env vars
- [ ] 6. Add WebsiteTraffic component to admin dashboard
  - Section breakdown cards (Landing, Blog, Docs, Presentations)
  - Top pages list within each section
  - Period selector integrated with existing dashboard controls
- [ ] 7. Wire up data fetching in `useAdminAnalytics.ts`
  - Add `fetchWebsiteTraffic` function
  - Include in parallel fetch on mount and refresh
- [ ] 8. Add tests
  - Unit test: tracker script event generation
  - Integration test: ingest endpoint accepts host field and stores in blob2
  - Integration test: website-traffic endpoint returns correct groupings
  - Unit test: WebsiteTraffic component renders sections and top pages
- [ ] 9. Update documentation
  - Add tracker script to CLAUDE.md recent changes
  - Document new env vars in relevant locations

## Acceptance Criteria

- [ ] Marketing site pages (landing, blog, docs, presentations) send page_view events to the API
- [ ] Events include host field to distinguish www vs app traffic
- [ ] Admin dashboard shows Website Traffic section with section breakdown
- [ ] Admin can see top pages within each section (blog posts, doc pages, etc.)
- [ ] Period selector works for website traffic data
- [ ] CORS allows cross-origin requests from www subdomain
- [ ] No hardcoded URLs — API endpoint derived from environment/config
- [ ] Tracker is lightweight (~50 lines) and doesn't block page rendering
