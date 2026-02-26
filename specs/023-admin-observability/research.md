# Research: Admin Observability Dashboard

**Feature Branch**: `023-admin-observability`
**Date**: 2026-02-25

## R1: Cloudflare Workers Observability API Access

**Decision**: Use raw `fetch()` calls to the Cloudflare Observability API, consistent with existing Cloudflare API patterns in the codebase.

**Rationale**: The codebase already makes direct HTTP calls to `api.cloudflare.com` in `apps/api/src/services/dns.ts` using `CF_API_TOKEN` with Bearer auth. The `cloudflare` npm SDK is not installed and adding it would introduce a large dependency for a few API calls. The Observability API has a straightforward REST interface (`POST /accounts/{account_id}/workers/observability/telemetry/query`).

**Alternatives considered**:
- **Cloudflare npm SDK (`cloudflare`)**: Provides typed client (`client.workers.observability.telemetry.query()`). Rejected because: adds unnecessary dependency weight, codebase convention is raw fetch, and the API surface needed is small (2-3 endpoints).

**Required changes**:
- Add `CF_ACCOUNT_ID` to `Env` interface (not currently present, but needed for Observability API path)
- Add `CF_ACCOUNT_ID` as a Worker secret (it's already available in deployment scripts but not exposed to the Worker runtime)

## R2: Real-Time Log Streaming Architecture

**Decision**: Use a Tail Worker that forwards log events to an `AdminLogs` Durable Object, which broadcasts to connected admin WebSocket clients.

**Rationale**: This follows the established pattern in `ProjectData` DO (hibernatable WebSockets with `broadcastEvent()`). Tail Workers are the Cloudflare-native mechanism for real-time log consumption. The DO provides connection management, filtering, and hibernation support.

**Alternatives considered**:
- **Polling the Observability API**: Rejected because it introduces latency (polling interval), wastes API quota, and doesn't provide true real-time streaming.
- **Server-Sent Events (SSE)**: Rejected because the codebase already has WebSocket patterns via DOs, and SSE doesn't support bidirectional communication (needed for filter changes).
- **Direct Tail Worker to client**: Not possible; Tail Workers can't serve WebSocket connections directly.

**Architecture**:
```
API Worker → console.log() → CF Workers Logs
                           ↓ (tail event)
                    Tail Worker
                           ↓ (fetch to DO)
                    AdminLogs DO
                           ↓ (WebSocket broadcast)
                    Admin Browser Clients
```

**Key implementation details**:
- Tail Worker is a separate Worker (`sam-tail-worker`) registered as a `tail_consumer` in the API Worker's wrangler.toml
- Tail Worker filters for error/warn/info levels and POSTs batched events to the AdminLogs DO
- AdminLogs DO uses hibernatable WebSockets (same pattern as ProjectData)
- Each admin client gets independent filter state via WebSocket messages
- Server-side filtering in the DO reduces bandwidth to clients

## R3: Separate Observability D1 Database

**Decision**: Provision a dedicated `OBSERVABILITY_DATABASE` D1 binding, separate from the main `DATABASE`.

**Rationale**: Error storage is append-heavy with periodic purges (retention-based). Isolating it prevents any risk of error volume affecting core platform queries. It also allows independent reset/purge of observability data without touching user/project data.

**Alternatives considered**:
- **Same D1 database, separate table**: Simpler but couples observability volume to core DB performance. Rejected per user decision.
- **Durable Object with SQLite**: Good isolation but harder to query across time ranges, no standard migration tooling, and not suited for cross-project aggregate queries.
- **Analytics Engine**: Cloudflare's analytics product. Rejected because it's designed for metrics aggregation, not individual error record storage/retrieval.

**Implementation layers**:
1. **Pulumi**: New `observabilityDatabase` resource in `infra/resources/database.ts`
2. **Wrangler**: Second `[[d1_databases]]` binding per environment with separate `migrations_dir`
3. **Env interface**: Add `OBSERVABILITY_DATABASE: D1Database`
4. **Schema**: New `apps/api/src/db/observability-schema.ts` with Drizzle
5. **Migrations**: New directory `apps/api/src/db/migrations/observability/`
6. **Deploy scripts**: Update `sync-wrangler-config.ts` and `run-migrations.ts` to handle both databases

## R4: API Worker Error Self-Capture

**Decision**: Instrument the API Worker's existing structured logger (`apps/api/src/lib/logger.ts`) to also write error-level entries to the observability D1 database.

**Rationale**: The admin wants all three error sources (client, VM agent, API) in a single unified view. Currently API errors only go to `console.error`. Adding a D1 write in the logger's `error()` function (with fail-silent behavior) completes the picture.

**Alternatives considered**:
- **Tail Worker only (capture from console output)**: The Tail Worker already sees all console output, so it could write errors to D1. However, this adds latency and coupling between the Tail Worker and D1. Direct write from the logger is simpler and more reliable.
- **Middleware-only capture (unhandled exceptions)**: Would miss explicit `log.error()` calls. Rejected because the admin wants visibility into all error-level events, not just unhandled crashes.

**Implementation approach**:
- Add an optional `db` parameter to the logger initialization (lazy, set after Worker startup)
- On `error()` calls, attempt a non-blocking D1 insert using `ctx.waitUntil()` to avoid impacting request latency
- Fail silently on D1 write errors (still logs to console as before)
- Include request context (path, method, user ID) when available

## R5: Admin UI Extension Pattern

**Decision**: Extend the existing `/admin` page with tab-based navigation. Add new tabs for "Overview", "Errors", "Logs", and "Stream" alongside the existing "Users" tab.

**Rationale**: The existing admin page has the correct access control (superadmin-only). Adding tabs keeps the admin area cohesive rather than scattering observability across multiple routes. The UI component library already includes a `Tabs` component with keyboard navigation.

**Alternatives considered**:
- **Separate `/observability` route**: Would require duplicating the superadmin gate and doesn't benefit from colocation with other admin functions.
- **Sub-routes under `/admin/observability/*`**: More complex routing for minimal benefit. Tabs are simpler.

**Reusable components from node observability (spec 020)**:
- `LogEntry` component (color-coded levels, expandable metadata, search highlighting)
- `LogFilters` component (source/level/search dropdowns)
- `useNodeLogs` hook pattern (WebSocket streaming + pause/resume + pagination)
- `Section`/`SectionHeader` wrapper pattern

These will be adapted (not directly reused) since the data source and filter options differ.

## R6: Error Retention & Purge Strategy

**Decision**: Use a scheduled cron job (already runs every 5 minutes) to purge expired errors from the observability D1 database.

**Rationale**: The existing cron handler in `apps/api/src/index.ts` already runs background maintenance (node cleanup sweep). Adding an error purge step is trivial and keeps all maintenance in one place. Configurable via `OBSERVABILITY_ERROR_RETENTION_DAYS` (default 30) and `OBSERVABILITY_ERROR_MAX_ROWS` (default 100,000).

**Alternatives considered**:
- **Purge on write (check count after each insert)**: Adds latency to every error ingestion request. Rejected.
- **D1 TTL/auto-expiry**: D1 doesn't support automatic row TTL. Not available.
- **Separate cron schedule**: Unnecessary complexity when the existing cron runs frequently enough.
