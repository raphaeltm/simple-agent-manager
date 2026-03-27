# Analytics Engine Phase 2: Client-side Tracker

## Problem Statement

Phase 1 established the server-side analytics foundation (Analytics Engine binding, API middleware, admin dashboard). Phase 2 adds client-side tracking: a lightweight React tracker with batching, a `/api/t` ingest endpoint, page view tracking, UTM capture, and browser session tracking. This gives visibility into user navigation patterns, landing page attribution, and feature interaction — data that server-side middleware alone cannot capture.

Phase 1 exists on branch `sam/analytics-engine-phase-1-01kmqa` (not yet merged to main). Phase 2 must incorporate those changes.

## Research Findings

### Key Files
- `apps/api/src/routes/client-errors.ts` — Reference pattern for public batched ingest endpoint (optionalAuth + IP rate limiting + fire-and-forget)
- `apps/api/src/middleware/rate-limit.ts` — KV-based rate limiting with `getRateLimit()` helper
- `apps/api/src/middleware/analytics.ts` (phase 1 branch) — Server-side middleware with schema, user-agent bucketing, event mapping
- `apps/web/src/main.tsx` — App initialization (error reporter init pattern to follow)
- `apps/web/src/App.tsx` — BrowserRouter setup, route tree
- `apps/web/src/components/AuthProvider.tsx` — `useAuth()` hook provides `user?.id`
- `apps/web/src/lib/api.ts` — API client with `request<T>()` and `getClientErrorsApiUrl()`
- `apps/web/src/lib/error-reporter.ts` — Reference pattern for fire-and-forget client-side reporting

### Analytics Engine Schema (from Phase 1)
```
index:   userId or visitorId
blob1:   event name
blob2:   projectId
blob3:   page/route
blob4:   referrer
blob5:   utm_source
blob6:   utm_medium
blob7:   utm_campaign
blob8:   browser_session_id
blob9:   user_agent bucket (server derives from User-Agent header)
blob10:  country (server derives from CF-IPCountry header)
blob11:  entity ID
double1: duration_ms
double2: status_code
double3: value
```

### Ingest Endpoint Pattern
Follow `client-errors.ts`: `optionalAuth()` for userId when available, `rateLimit({ useIp: true })` for abuse prevention, `c.executionCtx.waitUntil()` for non-blocking Analytics Engine writes, return 204.

### Client-side Tracker Pattern
Follow `error-reporter.ts`: initialize in `main.tsx`, use `navigator.sendBeacon()` for unload reliability, batch events in memory, flush on timer/threshold/unload.

### React Router Integration
`useLocation()` inside `<BrowserRouter>` detects route changes. Must be a component or hook inside the router — cannot use in `main.tsx` directly. Best approach: create a `<PageViewTracker>` component inside `<BrowserRouter>` that uses `useLocation()` + `useEffect()`.

## Implementation Checklist

### 1. Merge Phase 1 changes
- [ ] Merge/rebase the phase 1 branch (`sam/analytics-engine-phase-1-01kmqa`) into the working branch so all Analytics Engine infrastructure is available

### 2. Ingest endpoint (`POST /api/t`)
- [ ] Create `apps/api/src/routes/analytics-ingest.ts`
- [ ] Accept batched events: `{ events: AnalyticsEvent[] }`
- [ ] Validate event schema (event name required, all fields optional strings/numbers)
- [ ] Use `optionalAuth()` for userId when available
- [ ] Rate limit by IP via `rateLimit({ useIp: true })` with configurable `RATE_LIMIT_ANALYTICS_INGEST`
- [ ] Configurable max batch size via `MAX_ANALYTICS_INGEST_BATCH_SIZE` (default 25)
- [ ] Configurable max body size via `MAX_ANALYTICS_INGEST_BODY_BYTES` (default 64KB)
- [ ] Write each event to Analytics Engine using same schema as Phase 1 middleware
- [ ] Server-side enrichment: country from `CF-IPCountry`, user-agent bucketing from `User-Agent`
- [ ] Use `c.executionCtx.waitUntil()` for non-blocking writes
- [ ] Return 204 on success
- [ ] Register route in `index.ts` at `/api/t`
- [ ] Add `ANALYTICS_INGEST_ENABLED` env var (default "true") to Env interface

### 3. Client-side analytics tracker (`apps/web/src/lib/analytics.ts`)
- [ ] Generate browser session ID (crypto.randomUUID()) stored in `sessionStorage`
- [ ] Capture UTMs from `window.location.search` on init, persist in `sessionStorage`
- [ ] Capture `document.referrer` on init
- [ ] `track(event, props?)` function — queues event with timestamp
- [ ] Batch queue with configurable flush interval (default 5s) and max batch size (default 10)
- [ ] Flush on: timer, batch full, `visibilitychange` (hidden), `pagehide`
- [ ] Use `navigator.sendBeacon()` for unload flushes, `fetch()` for timer flushes
- [ ] Include userId from auth context when available (set via `setUserId()`)
- [ ] Fire-and-forget — never throw, never block UI
- [ ] Export `initAnalytics()`, `track()`, `setUserId()`, `getAnalyticsApiUrl()`

### 4. Page view tracking
- [ ] Create `apps/web/src/components/PageViewTracker.tsx` — renders null, uses `useLocation()` + `useEffect()` to call `track('page_view', { page, referrer })` on route changes
- [ ] Track time on page via `performance.now()` delta between route changes (send as `duration_ms` on the *previous* page view)
- [ ] Add `<PageViewTracker />` inside `<BrowserRouter>` in `App.tsx`

### 5. Feature interaction tracking
- [ ] Export `trackClick(elementName, props?)` convenience function
- [ ] Add tracking to key UI interactions: task submit, workspace create, project create (in relevant components)

### 6. Initialize in main.tsx
- [ ] Call `initAnalytics(getAnalyticsApiUrl())` in `main.tsx`
- [ ] Add `getAnalyticsApiUrl()` to `apps/web/src/lib/api.ts`

### 7. Auth integration
- [ ] In `AuthProvider.tsx`, call `setUserId(user.id)` when auth state changes
- [ ] On logout, call `setUserId(null)` to reset to visitor mode

### 8. Env interface updates
- [ ] Add `RATE_LIMIT_ANALYTICS_INGEST?: string` to Env interface
- [ ] Add `MAX_ANALYTICS_INGEST_BATCH_SIZE?: string` to Env interface
- [ ] Add `MAX_ANALYTICS_INGEST_BODY_BYTES?: string` to Env interface
- [ ] Add `ANALYTICS_INGEST_ENABLED?: string` to Env interface

### 9. Tests
- [ ] Unit test for analytics ingest route (valid batch, malformed events dropped, rate limit, max body/batch, empty batch returns 204)
- [ ] Unit test for client-side tracker (batching, flush on threshold, session ID generation, UTM capture)
- [ ] Integration test: ingest endpoint writes to Analytics Engine binding

## Acceptance Criteria

- [ ] `POST /api/t` accepts batched client-side events and writes to Analytics Engine
- [ ] Client-side tracker batches events and flushes efficiently (timer + unload)
- [ ] Page views are tracked on every route change with correct pathname
- [ ] UTM parameters are captured from landing page URL and included in all events
- [ ] Browser session ID persists across route changes within a tab session
- [ ] Authenticated users have their userId in events; unauthenticated get a visitor ID
- [ ] Rate limiting prevents abuse of the ingest endpoint
- [ ] Analytics never blocks or crashes the UI (fire-and-forget)
- [ ] All limits and URLs are configurable via env vars
- [ ] Tests cover ingest endpoint and client-side tracker behavior

## References

- Idea: "Internal analytics system via Cloudflare Analytics Engine" (SAM idea 01KMQ9S069MP8SXEBHN80FQY41)
- Phase 1 branch: `sam/analytics-engine-phase-1-01kmqa`
- `apps/api/src/routes/client-errors.ts` — ingest endpoint pattern
- `apps/web/src/lib/error-reporter.ts` — client-side reporter pattern
