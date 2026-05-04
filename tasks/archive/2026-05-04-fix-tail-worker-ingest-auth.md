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

## Solution

Extract the ingest route from `adminRoutes` and mount it on a separate route that uses an internal-only auth guard instead of superadmin session auth. The guard validates:
- The request has a shared secret header (`X-Tail-Worker-Secret`) matching `TAIL_WORKER_INGEST_SECRET` env var, OR
- As a simpler approach: move to a dedicated internal route path and use a lightweight shared-secret middleware

**Chosen approach**: Move the ingest POST out of `adminRoutes` into a separate `internalObservabilityRoutes` subrouter mounted at `api/admin/observability/logs/ingest`. This subrouter uses a `requireInternalAuth()` middleware that checks for a `TAIL_WORKER_SECRET` env var in a header. The existing admin routes keep their superadmin middleware unchanged.

Actually, the simplest correct approach: remove the ingest route from adminRoutes, create it on the main app directly with its own auth that checks for a shared secret. But we want to avoid complexity.

**Simplest approach**: Move the ingest route definition BEFORE the wildcard middleware in the subrouter. Wait — Hono processes middleware in registration order, and `use('/*')` affects all routes regardless of order.

**Final chosen approach**: Create a separate `observabilityIngestRoutes` Hono subrouter with NO session auth. Mount it at the same path. Protect it with a shared-secret header check (`X-Tail-Worker-Secret` matching `TAIL_WORKER_INGEST_SECRET` env var). Update the tail worker to send this header. External callers without the secret get 401.

## Implementation Checklist

- [ ] Create `requireInternalSecret()` middleware in `apps/api/src/middleware/internal-auth.ts`
  - Reads `X-Tail-Worker-Secret` header
  - Compares against `c.env.TAIL_WORKER_INGEST_SECRET`
  - Returns 401 if missing or mismatched
- [ ] Remove the ingest route from `adminRoutes` in `apps/api/src/routes/admin.ts`
- [ ] Create a new `observabilityIngestRoutes` subrouter (can be in admin.ts or separate file)
  - Mount at same path `/api/admin/observability/logs/ingest`
  - Use `requireInternalSecret()` middleware
  - Same handler logic as current ingest
- [ ] Mount `observabilityIngestRoutes` in `apps/api/src/index.ts`
- [ ] Add `TAIL_WORKER_INGEST_SECRET` to the Env type in `apps/api/src/env.ts`
- [ ] Update tail worker to send `X-Tail-Worker-Secret` header with `env.TAIL_WORKER_INGEST_SECRET`
- [ ] Add `TAIL_WORKER_INGEST_SECRET` to tail worker Env interface
- [ ] Add `TAIL_WORKER_INGEST_SECRET` to wrangler.toml top-level bindings (both api and tail-worker)
- [ ] Add regression tests for internal ingest auth:
  - Ingest succeeds with correct secret
  - Ingest fails (401) without secret
  - Ingest fails (401) with wrong secret
  - Query route still requires superadmin
  - Stream route still requires superadmin
- [ ] Update tail worker tests to verify secret header is sent
- [ ] Run local typecheck/lint/test
- [ ] Update CLAUDE.md if needed (env var documentation)

## Acceptance Criteria

- [ ] Tail-worker/service-binding ingest succeeds with shared secret
- [ ] External unauthenticated calls to the ingest endpoint fail (401)
- [ ] `/api/admin/observability/logs/query` still requires superadmin auth
- [ ] `/api/admin/observability/logs/stream` still requires superadmin auth
- [ ] Regression tests pass for internal ingest auth behavior
- [ ] Local tests/typecheck pass
- [ ] Staging deploy succeeds and no more 401 ingest errors in logs
