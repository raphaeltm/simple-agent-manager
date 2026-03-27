# Analytics Engine Phase 4 — External Event Forwarding

## Problem Statement

The analytics system (Phases 1-3) captures events in Cloudflare Analytics Engine with 90-day retention. Phase 4 adds server-side forwarding of key conversion events to external analytics platforms (Segment and GA4) for ad campaign optimization and long-term analytics. This is a scheduled batch export — not real-time — running as a daily cron job that queries Analytics Engine for recent events and forwards them.

## Research Findings

### Existing Analytics Architecture
- **Analytics middleware** (`apps/api/src/middleware/analytics.ts`): writes data points to Analytics Engine on every API request with 11 blobs + 3 doubles
- **Client-side tracker** (`apps/web/src/lib/analytics.ts`): batches events to `POST /api/t`
- **Ingest endpoint** (`apps/api/src/routes/analytics-ingest.ts`): validates + writes client events
- **Admin dashboard** (`apps/web/src/pages/admin-analytics/`): 6 query endpoints, multiple chart components
- **Existing cron** runs every 5 minutes (`apps/api/src/index.ts:722-771`), dispatches to modules in `apps/api/src/scheduled/`

### Analytics Engine Schema (relevant fields)
- `index1`: userId (or "anonymous")
- `blob1`: event name (e.g., "signup", "project_created", "task_submitted")
- `blob2`: projectId
- `blob3`: route pattern
- `blob5-7`: utm_source, utm_medium, utm_campaign
- `blob10`: country
- `double1`: response time (ms)
- `double2`: HTTP status code

### Key Conversion Events to Forward
Per the idea spec, the key conversions for ad optimization are:
- `signup` — user registration
- `login` — (for active user tracking)
- `project_created` — first project creation
- `workspace_created` — first workspace (strong intent signal)
- `task_submitted` — first task (full activation)

### External APIs

**Segment Track API (server-side):**
- `POST https://api.segment.io/v1/batch` (or configurable endpoint)
- Basic auth with write key as username, empty password
- Batch of `track` calls with `userId`, `event`, `properties`, `timestamp`
- Max 500KB per batch, max 32KB per event

**GA4 Measurement Protocol:**
- `POST https://www.google-analytics.com/mp/collect?measurement_id=<id>&api_secret=<secret>`
- JSON body with `client_id`, `user_id`, `events[]` array
- Max 25 events per request
- Events have `name` + `params` object

### Architecture Decisions
1. **Daily batch, not real-time**: Forwarding runs once daily to avoid rate limits and reduce complexity. A cron trigger at a configurable hour (default: 03:00 UTC).
2. **Separate cron schedule**: The existing 5-minute cron is for operational tasks. Daily forwarding uses the same `scheduled()` handler but checks time-of-day to decide whether to run.
3. **Cursor-based deduplication**: Store the last-forwarded timestamp in KV to avoid re-sending events on retry.
4. **Opt-in per destination**: Each destination (Segment, GA4) is independently enabled via env vars. If no credentials are configured, forwarding is silently skipped.
5. **Configurable event filter**: Which events to forward is configurable, with sensible defaults (key conversions only).

### Cron Approach
Cloudflare Workers supports multiple cron entries in `wrangler.toml`. We'll add a daily trigger and use the cron expression to distinguish the 5-minute sweep from the daily export in the `scheduled()` handler via `controller.cron`.

## Implementation Checklist

- [ ] **1. Add env vars to Env interface** (`apps/api/src/index.ts`)
  - `ANALYTICS_FORWARD_ENABLED?: string` — master enable (default: "false")
  - `ANALYTICS_FORWARD_EVENTS?: string` — comma-separated event names to forward (default: key conversions)
  - `ANALYTICS_FORWARD_LOOKBACK_HOURS?: string` — hours of data to query per run (default: 25, overlaps to catch stragglers)
  - `SEGMENT_WRITE_KEY?: string` — Segment write key (enables Segment forwarding)
  - `SEGMENT_API_URL?: string` — Segment batch endpoint (default: `https://api.segment.io/v1/batch`)
  - `SEGMENT_MAX_BATCH_SIZE?: string` — max events per Segment batch (default: 100)
  - `GA4_MEASUREMENT_ID?: string` — GA4 measurement ID (enables GA4 forwarding)
  - `GA4_API_SECRET?: string` — GA4 API secret
  - `GA4_API_URL?: string` — GA4 Measurement Protocol endpoint (default: `https://www.google-analytics.com/mp/collect`)
  - `GA4_MAX_BATCH_SIZE?: string` — max events per GA4 request (default: 25)
  - `ANALYTICS_FORWARD_CURSOR_KEY?: string` — KV key for last-forwarded timestamp (default: `analytics-forward-cursor`)

- [ ] **2. Add daily cron trigger to wrangler.toml**
  - Add `"0 3 * * *"` to the crons array (daily at 03:00 UTC)

- [ ] **3. Create forwarding service** (`apps/api/src/services/analytics-forward.ts`)
  - `queryRecentConversionEvents(env, sinceIso)` — query Analytics Engine SQL API for forwarded event types since cursor
  - `forwardToSegment(env, events)` — batch POST to Segment Track API
  - `forwardToGA4(env, events)` — batch POST to GA4 Measurement Protocol
  - `runAnalyticsForward(env)` — orchestrator: read cursor from KV, query events, forward to enabled destinations, update cursor
  - All functions return structured results for logging

- [ ] **4. Create scheduled module** (`apps/api/src/scheduled/analytics-forward.ts`)
  - Export `runAnalyticsForwardJob(env)` — thin wrapper that checks `ANALYTICS_FORWARD_ENABLED` and delegates to service
  - Follow pattern from `observability-purge.ts`

- [ ] **5. Wire into scheduled handler** (`apps/api/src/index.ts`)
  - In `scheduled()`, check `controller.cron` to distinguish daily from 5-minute
  - On daily cron (`"0 3 * * *"`): call `runAnalyticsForwardJob(env)` in addition to existing tasks
  - Log forwarding results alongside other cron results

- [ ] **6. Write unit tests** (`apps/api/tests/unit/analytics-forward.test.ts`)
  - Test event query SQL generation
  - Test Segment batch formatting (auth header, payload structure)
  - Test GA4 batch formatting (query params, payload structure)
  - Test cursor read/write from KV
  - Test disabled destinations are skipped
  - Test master disable skips all forwarding
  - Test event filter configuration

- [ ] **7. Write integration test** (`apps/api/tests/integration/analytics-forward.test.ts`)
  - Mock Analytics Engine SQL API response
  - Mock Segment and GA4 endpoints
  - Verify end-to-end flow: query → format → forward → update cursor
  - Verify deduplication via cursor

- [ ] **8. Update admin analytics dashboard** (`apps/web/src/pages/admin-analytics/`)
  - Add a "Forwarding Status" card showing:
    - Whether forwarding is enabled
    - Last forwarded timestamp (from API)
    - Destination status (Segment: configured/not, GA4: configured/not)
  - New API endpoint: `GET /api/admin/analytics/forward-status`

- [ ] **9. Add forwarding status endpoint** (`apps/api/src/routes/admin-analytics.ts`)
  - `GET /api/admin/analytics/forward-status` — returns enabled state, cursor timestamp, configured destinations

- [ ] **10. Update documentation**
  - Update `CLAUDE.md` Recent Changes section
  - Update `.env.example` with new env vars
  - Add forwarding configuration section to any analytics docs

## Acceptance Criteria

- [ ] When `ANALYTICS_FORWARD_ENABLED=true` and `SEGMENT_WRITE_KEY` is set, conversion events are forwarded to Segment in daily batches
- [ ] When `ANALYTICS_FORWARD_ENABLED=true` and `GA4_MEASUREMENT_ID` + `GA4_API_SECRET` are set, conversion events are forwarded to GA4
- [ ] Forwarding is idempotent — re-running with the same cursor doesn't re-send events
- [ ] No forwarding happens when `ANALYTICS_FORWARD_ENABLED` is unset or "false" (default)
- [ ] The admin dashboard shows forwarding status
- [ ] All configurable values use env vars with sensible defaults (constitution Principle XI)
- [ ] Unit and integration tests pass
- [ ] Typecheck and lint pass
