# Tail Worker (apps/tail-worker)

## Purpose

Cloudflare Tail Worker that receives log events from the API Worker and forwards them to the `AdminLogs` Durable Object for real-time WebSocket broadcasting. Part of the observability stack (spec 023).

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Sole source file — tail handler, event filtering, DO forwarding |
| `wrangler.toml` | Worker config (name, compatibility date, service bindings) |
| `tests/` | Vitest unit tests |

## Commands

```bash
pnpm --filter @simple-agent-manager/tail-worker test       # Run tests
pnpm --filter @simple-agent-manager/tail-worker typecheck  # Type check
pnpm --filter @simple-agent-manager/tail-worker dev        # Local dev (limited — needs API Worker)
```

## Conventions

- Single-file worker — keep all logic in `src/index.ts`
- Filters to `error`, `warn`, `info` levels only (skips debug/trace)
- Parses structured JSON from `log.message.join(' ')` before forwarding
- Uses service binding (`API_WORKER`) to reach the AdminLogs DO in the API Worker

## Gotchas

- `tail_consumers` in the API Worker's wrangler config is generated at deploy time by `sync-wrangler-config.ts` — it is only added if the tail worker already exists
- Tail workers do NOT work in local dev with Miniflare/Vitest — the `tail_consumers` binding breaks the test harness, so it is excluded from top-level wrangler config
- Deploying this worker before the API Worker causes the service binding to fail — deploy API Worker first
- The `Env.API_WORKER` binding is optional (`?`) because it may not exist in all environments
