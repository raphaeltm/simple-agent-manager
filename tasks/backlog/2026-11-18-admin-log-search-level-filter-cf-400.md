# Admin → Logs search with a level filter returns 502 (Cloudflare Observability 400)

## Problem

`POST /api/admin/observability/logs/query` with a non-empty `levels` filter (for example
`["error"]`) returns `502 CF_API_ERROR` because the Cloudflare Workers Observability telemetry API
answers `400`. The same request without `levels` returns `200` with log rows. The API's error
message truncates Cloudflare's response body, so the rejected field is not visible from the client.

## Context

Found 2026-11-18 on staging2 while verifying PR #2889 (L20). That PR changed only the credentials
check in `apps/api/src/services/worker-log-query.ts` (`hasCloudflareAccountApi`); the query
building in `queryCloudflareLogs()` (`apps/api/src/services/observability-logs.ts`) is unchanged,
so this predates it. The Admin → Logs level chips send exactly this shape.

## Acceptance Criteria

- [ ] Reproduce against the real API and identify the rejected filter shape (log the Cloudflare
      error body server-side, untruncated, without secrets)
- [ ] Level-filtered searches return 200 on staging
- [ ] A contract test pins the level filter's request shape to what the API accepts
