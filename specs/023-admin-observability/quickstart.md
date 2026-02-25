# Quickstart: Admin Observability Dashboard

**Feature Branch**: `023-admin-observability`
**Date**: 2026-02-25

## Prerequisites

- Existing SAM development environment (`pnpm install` complete)
- Cloudflare Workers Paid plan (for Workers Observability API access)
- `CF_API_TOKEN` and `CF_ACCOUNT_ID` configured as Worker secrets

## Implementation Order

Build in dependency order. Each phase delivers independently testable value.

### Phase 1: Error Storage Foundation (P1 - FR-001 through FR-004)

**Goal**: Persist errors to a dedicated D1 database.

1. **Infrastructure**: Add `observabilityDatabase` to Pulumi (`infra/resources/database.ts`)
2. **Wrangler config**: Add `OBSERVABILITY_DATABASE` binding to `wrangler.toml`
3. **Env interface**: Add `OBSERVABILITY_DATABASE: D1Database` and `CF_ACCOUNT_ID: string` to `Env`
4. **Schema**: Create `apps/api/src/db/observability-schema.ts` with `platform_errors` table
5. **Migration**: Create `apps/api/src/db/migrations/observability/0000_init.sql`
6. **Service**: Create `apps/api/src/services/observability.ts` with `persistError()` and `queryErrors()`
7. **Modify endpoints**: Update `POST /api/client-errors` and `POST /api/nodes/:id/errors` to write to D1
8. **Logger instrumentation**: Update `apps/api/src/lib/logger.ts` to capture API errors
9. **Cron purge**: Add retention purge step to scheduled handler

**Verify**: Deploy to staging, trigger errors from all three sources, confirm they appear in D1.

### Phase 2: Admin Dashboard UI (P1 - FR-005 through FR-009)

**Goal**: Admin can view health summary and error list.

1. **API routes**: Add observability endpoints to `apps/api/src/routes/admin.ts`
2. **Admin tabs**: Refactor `Admin.tsx` to use `Tabs` component with "Users" and "Observability" tabs
3. **Health overview**: Create `HealthOverview.tsx` with summary cards
4. **Error list**: Create `ErrorList.tsx` with filtering, search, and pagination
5. **Shared types**: Add observability types to `packages/shared`
6. **API client**: Add fetch functions to `apps/web/src/lib/api.ts`

**Verify**: Log in as superadmin, navigate to Admin > Observability, see health cards and error list.

### Phase 3: Historical Log Viewer (P2 - FR-010 through FR-015)

**Goal**: Admin can query Cloudflare Workers Observability API logs in-app.

1. **CF API proxy**: Add `POST /api/admin/observability/logs/query` endpoint
2. **Rate limiting**: Add per-admin rate limiting for CF API queries
3. **Log viewer UI**: Create `LogViewer.tsx` with filters and pagination
4. **Hook**: Create `useAdminLogQuery.ts` for query state management

**Verify**: Open log viewer tab, query for recent logs, confirm they match CF dashboard.

### Phase 4: Real-Time Log Stream (P2 - FR-016 through FR-020)

**Goal**: Admin can subscribe to live platform logs.

1. **AdminLogs DO**: Create `apps/api/src/durable-objects/admin-logs.ts` with hibernatable WebSockets
2. **Tail Worker**: Create `apps/tail-worker/` that forwards events to AdminLogs DO
3. **Stream endpoint**: Add `GET /api/admin/observability/logs/stream` WebSocket upgrade
4. **Stream UI**: Create `LogStream.tsx` with connection status, pause/resume, filters
5. **Hook**: Create `useAdminLogStream.ts` for WebSocket management

**Verify**: Open stream tab, trigger API requests, see entries appear in real time.

### Phase 5: Error Trends (P3 - FR-021 through FR-022)

**Goal**: Admin can visualize error trends over time.

1. **Trends API**: Add `GET /api/admin/observability/errors/trends` endpoint
2. **Trends UI**: Create `ErrorTrends.tsx` with time-series chart
3. **Time range selector**: Add range controls (1h, 24h, 7d, 30d)

**Verify**: Generate errors over time, confirm chart accurately reflects distribution.

## Key Configuration Variables

Set these in your `.dev.vars` for local development:

```bash
# Required for historical log viewer (Phase 3)
CF_ACCOUNT_ID=your_cloudflare_account_id

# Optional overrides (defaults are fine for development)
OBSERVABILITY_ERROR_RETENTION_DAYS=30
OBSERVABILITY_ERROR_MAX_ROWS=100000
OBSERVABILITY_LOG_QUERY_RATE_LIMIT=30
```

## Testing Strategy

- **Unit tests**: Service functions (error persistence, query building, retention purge)
- **Integration tests**: API endpoints with Miniflare (D1 + DO bindings)
- **E2E tests**: Playwright against staging (admin login, view errors, query logs)
- **Manual verification**: Trigger real errors, verify end-to-end flow

## Files to Update (Existing)

| File | Change |
|------|--------|
| `apps/api/src/index.ts` | Env interface, DO export, cron step |
| `apps/api/src/routes/admin.ts` | Observability sub-routes |
| `apps/api/src/lib/logger.ts` | Optional D1 error capture |
| `apps/api/wrangler.toml` | D1 binding, tail_consumers, DO binding |
| `apps/web/src/pages/Admin.tsx` | Tab navigation |
| `apps/web/src/lib/api.ts` | Admin observability API functions |
| `packages/shared/src/types/admin.ts` | Observability types |
| `infra/resources/database.ts` | Observability D1 resource |
| `infra/index.ts` | Export observability DB outputs |
| `scripts/deploy/sync-wrangler-config.ts` | Sync both D1 bindings |
| `scripts/deploy/run-migrations.ts` | Run both migration sets |
| `docs/guides/self-hosting.md` | Document new D1 DB + CF_ACCOUNT_ID |
