# Fix Tail-Worker Observability Ingest Authentication

## Problem

Production Cloudflare Workers telemetry shows repeated 401 errors on `POST /api/admin/observability/logs/ingest`. The tail worker forwards batched logs via the API Worker service binding, but the ingest route sits inside `adminRoutes` which has a blanket `use('/*', requireAuth(), requireApproved(), requireSuperadmin())` middleware. Service binding requests carry no browser session → 401.

## Root Cause

`apps/api/src/routes/admin.ts` line 18:
```typescript
adminRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());
```

This applies to ALL admin routes including the ingest endpoint at line 398, which is only called internally by the tail worker via service binding.

## Research Findings

1. **Tail worker sends to**: `https://internal/api/admin/observability/logs/ingest` via `env.API_WORKER.fetch()` (service binding)
2. **Service binding requests** in Cloudflare Workers use synthetic URLs with hostname `internal` — they never traverse the public internet
3. **Per `.claude/rules/06-api-patterns.md`**: NEVER use wildcard `use('/*', ...)` middleware on subrouters that share a base path with other subrouters using different auth models
4. **The ingest endpoint** only forwards JSON to the AdminLogs DO — no sensitive data access, no DB queries
5. **Query and stream endpoints** (`/observability/logs/query`, `/observability/logs/stream`) must REMAIN superadmin-protected
6. **Cloudflare service binding hostnames** are synthetic and dotless (e.g. `internal`). External HTTP always arrives via real DNS hostnames with dots (e.g. `api.example.com`). Cloudflare edge routing ensures external traffic cannot reach a Worker with a dotless hostname.

## Solution

**Design pivot**: The task file originally described a shared-secret approach (`X-Tail-Worker-Secret` header + `TAIL_WORKER_INGEST_SECRET` env var). During implementation, this was replaced with a simpler hostname-based approach that requires no new env vars or secrets.

**Final implemented approach**: Extract the ingest route from `adminRoutes` into a separate `observabilityIngestRoutes` subrouter in `apps/api/src/routes/observability-ingest.ts`. The subrouter has middleware that checks `url.hostname.includes('.')`:
- **Dotless hostname** (e.g. `internal`, `fake-host`): service binding call → allow through
- **Hostname with dots** (e.g. `api.example.com`): external HTTP → reject with 401

This works because Cloudflare edge routing prevents external traffic from arriving at a Worker with a dotless hostname — there is no DNS record or route to match. The hostname check is unforgeable from outside the Cloudflare account boundary.

**Why not shared secret**: The hostname approach is simpler (no new env vars, no secret rotation, no wrangler.toml changes) and equally secure within the Cloudflare platform. Service bindings can only be acquired via explicit wrangler.toml config within the same account.

## Implementation Checklist

- [x] Remove the ingest route from `adminRoutes` in `apps/api/src/routes/admin.ts`
- [x] Create `observabilityIngestRoutes` subrouter in `apps/api/src/routes/observability-ingest.ts`
  - Middleware checks URL hostname for dots (service binding = dotless = allow)
  - Same handler logic as original ingest route (forwards to AdminLogs DO)
- [x] Mount `observabilityIngestRoutes` in `apps/api/src/index.ts` BEFORE `adminRoutes`
- [x] Add regression tests (`observability-ingest-auth.test.ts`, 8 tests):
  - Service binding (dotless hostname) succeeds
  - Alternative dotless hostname succeeds (guard not hardcoded to "internal")
  - External hostname with dots rejected (401)
  - Staging hostname with dots rejected (401)
  - No session auth headers needed for service binding
  - Query route still requires superadmin (401 without auth)
  - Stream route still requires superadmin (401 without auth)
  - Query route returns 403 without superadmin role
- [x] Update existing `admin-observability.test.ts` to mount both routes
- [x] Run local typecheck/lint/test — all pass
- N/A: `requireInternalSecret()` middleware — replaced by hostname-based approach
- N/A: `TAIL_WORKER_INGEST_SECRET` env var / wrangler.toml / Env type — no secret needed
- N/A: Tail worker changes — no header needed, existing `https://internal/...` URL is sufficient
- N/A: CLAUDE.md update — no new env vars added

## Acceptance Criteria

- [x] Tail-worker/service-binding ingest succeeds (dotless hostname passes auth)
- [x] External unauthenticated calls to the ingest endpoint fail (401)
- [x] `/api/admin/observability/logs/query` still requires superadmin auth
- [x] `/api/admin/observability/logs/stream` still requires superadmin auth
- [x] Regression tests pass for internal ingest auth behavior
- [x] Local tests/typecheck pass
- [ ] Staging deploy succeeds and no more 401 ingest errors in logs (Phase 6)
