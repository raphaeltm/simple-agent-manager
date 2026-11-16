# Request I/O and Client Bundle Budgets

## When This Applies

Any change that adds D1 queries, Durable Object RPCs, or external fetches to an
API request path; any change that adds client-side dependencies or data-fetching
hooks to `apps/web/`.

## Why This Rule Exists

The auth middleware accumulated 39 D1 queries per request across three independent
PRs, each locally reasonable. The web app has zero route-level code splitting
(~90 statically imported pages). 54 of 61 data-fetching hooks use hand-rolled
`useState + useEffect` instead of TanStack Query, losing stale-while-revalidate,
dedup, and cache persistence. No rule set a budget or required measurement, so
the cost grew unchecked.

## Server-Side Budgets

### D1 + DO RPC Round-Trip Budget

Every API endpoint has an I/O round-trip budget. Count each D1 `prepare().run/all/first`,
each DO `stub.method()` RPC, and each external `fetch()` as one round-trip.

| Endpoint class | Budget | Example |
|---|---|---|
| Read-only GET | ≤ 8 | `GET /projects/:id` |
| Mutation POST/PUT/DELETE | ≤ 12 | `POST /projects/:id/tasks` |
| Aggregation / dashboard | ≤ 20 | `GET /admin/overview` |
| Background sweep / cron | ≤ 30 per tick | scheduled handler |

When a PR adds I/O to a route, state the new total in the PR description. If
over budget, consolidate queries (batch, join, cache) before merging.

### Per-Isolate Caching for Stable Config

Data that changes at most once per deploy (platform config, feature flags,
model catalogs) MUST be cached in module-scope variables with a TTL, not
re-fetched on every request. Use the pattern:

```typescript
let cached: T | null = null;
let cachedAt = 0;
const TTL = env.PLATFORM_CONFIG_CACHE_TTL_MS ?? 300_000; // 5 min default

async function getCachedConfig(env: Env): Promise<T> {
  if (cached && Date.now() - cachedAt < TTL) return cached;
  cached = await loadFromD1(env);
  cachedAt = Date.now();
  return cached;
}
```

### Shared-Path Deduplication

When the same data is needed by multiple middleware layers or helpers within a
single request, resolve it once and thread it via Hono context (`c.set/c.get`)
or function arguments. Do not call the same resolver multiple times per request.

## Client-Side Budgets

### Route-Level Code Splitting

Every top-level page in `apps/web/src/pages/` MUST be imported via `React.lazy`.
Static imports of page components from `App.tsx` or router config are banned
for pages not in the initial landing set (dashboard, login).

### Data-Fetching Pattern

New data-fetching surfaces in `apps/web/` MUST use TanStack Query (already
configured — see `apps/web/src/lib/query-client.ts`). Hand-rolled
`useState + useCallback + useEffect` loader triplets are banned for new code.
See rule 48 for stale-while-revalidate rendering requirements.

### Polling Hygiene

Polling intervals MUST be env-configurable with a `DEFAULT_*` constant.
Components MUST stop polling when the browser tab is not visible
(`document.hidden`). Prefer server-pushed updates (WebSocket, SSE) over
polling when the infrastructure already exists (it does — see ProjectData DO
WebSocket broadcast).

## Quick Compliance Check

Before committing API route changes:
- [ ] Counted total D1 + DO + fetch round-trips for affected endpoints
- [ ] Total is within budget (or justified exception documented)
- [ ] Stable config uses per-isolate cache, not per-request fetch
- [ ] Same data is not resolved multiple times per request

Before committing web client changes:
- [ ] New pages use `React.lazy` (not static import in router)
- [ ] New fetch surfaces use TanStack Query (not hand-rolled hooks)
- [ ] Polling intervals are configurable and pause when tab is hidden
