# Trigger API Optimizations

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - The `executionStats` N+1 is gone; the list route batch-loads configs with `inArray`
>     (`apps/api/src/routes/triggers/crud.ts:331–352`; removed in 47041f099, PR #1581).
>   - Execution log purge using `TRIGGER_EXECUTION_LOG_RETENTION_DAYS`
>     (`apps/api/src/scheduled/trigger-execution-cleanup.ts:332–365`, called at `:473` from the
>     cron in `scheduled/handler.ts:163`; PR #671 cdfb80413).
>   - skipIfRunning and maxConcurrent share one atomic count (`CASE WHEN skip_if_running`) in
>     the reservation INSERT (`apps/api/src/services/trigger-admission.ts:193–211`; PR #1581).
>   - The DELETE route relies on the cascade, with no manual execution delete
>     (`crud.ts:528–540`).
> - **Still open:**
>   - MCP `handleCreateTrigger` still uses raw SQL
>     (`apps/api/src/routes/mcp/trigger-create-tool.ts:147,157,178,196`).
>   - `CRON_SWEEP_ENABLED`, `CRON_MAX_FIRE_PER_SWEEP` and `TRIGGER_AUTO_PAUSE_AFTER_FAILURES`
>     are not in `wrangler.toml [vars]` (code defaults exist: `scheduled/cron-triggers.ts:25,42`,
>     `trigger-admission.ts:172`).
>   - The consecutive-failure query still runs before the reservation
>     (`trigger-admission.ts:170–186`). The skip checks now live inside the atomic INSERT, so
>     first decide whether reordering still makes sense.

**Created**: 2026-04-09
**Source**: Cloudflare-specialist review of PR #645 (event-driven triggers)

## Problem

The triggers feature (PR #645) shipped with several performance and maintainability issues identified by the cloudflare-specialist review that were not correctness bugs but should be addressed:

1. **N+1 query in GET /triggers list** — `crud.ts:242-259` issues 2 D1 queries per trigger to build `executionStats`, but the stats are never included in the response (dead code). Either wire into response or remove.
2. **No execution log retention purge** — `trigger_executions` grows unbounded. `DEFAULT_TRIGGER_EXECUTION_LOG_RETENTION_DAYS = 90` is defined but never wired to a purge job.
3. **MCP handler uses raw SQL** — `trigger-tools.ts:78-131` uses `env.DATABASE.prepare()` instead of Drizzle ORM, diverging from the CRUD routes pattern.
4. **Missing wrangler.toml [vars]** — `CRON_SWEEP_ENABLED`, `CRON_MAX_FIRE_PER_SWEEP`, `TRIGGER_AUTO_PAUSE_AFTER_FAILURES` not in `[vars]` block.
5. **Query optimization** — `getConsecutiveFailureCount` runs before skip checks; `skipIfRunning` and `maxConcurrent` could share a single count query.
6. **Manual cascade delete** — DELETE route manually deletes executions before trigger, but D1 has `ON DELETE CASCADE` enabled by default.

## Acceptance Criteria

- [ ] Remove or wire `executionStats` in GET /triggers list endpoint
- [ ] Add execution log purge to cron sweep (using `TRIGGER_EXECUTION_LOG_RETENTION_DAYS`)
- [ ] Refactor MCP `handleCreateTrigger` to use Drizzle ORM
- [ ] Add missing trigger env vars to `wrangler.toml [vars]`
- [ ] Move consecutive failure check after skip checks in sweep
- [ ] Consolidate skipIfRunning + maxConcurrent into single count query
- [ ] Remove redundant manual cascade delete in DELETE route
