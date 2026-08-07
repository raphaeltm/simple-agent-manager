# D1 Statement Limits Are Row-Evaluated, and Request-Scoped waitUntil Is Not Durable

## When This Applies

1. Any D1 query that binds a **dynamically constructed LIKE/GLOB pattern**
   (`%…${id}…%`), anywhere in `apps/api/`.
2. Any Worker code that starts **multi-second background work** (launches,
   provisioning, uploads, cleanup) under `ctx.waitUntil` instead of a durable
   job context.

## Why This Rule Exists

On 2026-08-06/07 the `stuck_tasks` sweep failed on 311 consecutive runs with
`D1_ERROR: LIKE or GLOB pattern too complex`. The dedup query in
`apps/api/src/scheduled/stuck-tasks.ts` bound
`%do_task_status_mismatch%<26-char-taskId>%` — 52 bytes against D1's
`SQLITE_LIMIT_LIKE_PATTERN_LENGTH` of **exactly 50 bytes** (empirically
verified: 50 passes, 51 fails; local workerd enforces the same limit).

Every test passed because SQLite enforces the limit **inside the `like()`
function, which only runs per row** — against an empty `platform_errors` table
the oversized pattern is never evaluated and the query "succeeds". Production
had rows, so every sweep died — and because the query sat outside the
per-candidate try/catch, one candidate aborted the entire sweep and froze the
scan cursor (rule 53 violation).

The same incident window exposed the second class: the Instant (cf-container)
launch continuation ran under the HTTP request's `ctx.waitUntil`. Cloudflare
cancels unsettled `waitUntil` work ~30s after the response completes (and on
client disconnect), and **cancellation runs no catch blocks** — a 33s clone
stranded task `01KZECB26257JD03VFSNW0J5G6` in `queued` forever with a running,
empty container and zero error anywhere. The TaskRunner DO's own header says it
exists to replace "the unreliable `waitUntil(executeTaskRun())` approach"; the
instant path had reintroduced it.

## Hard Requirements

### D1 LIKE/GLOB patterns

1. **Every bound LIKE/GLOB pattern must be ≤50 bytes.** When matching two
   substrings (a marker + an id), use two `LIKE` conditions or `instr()` —
   never concatenate them into one pattern.
2. **Discriminating tests MUST seed at least one row** in the queried table so
   `like()` actually evaluates. An empty-table test proves nothing about
   pattern limits (or LIKE behavior generally).
3. Prefer a structured column (e.g. a dedicated `task_id` column) over
   LIKE-over-JSON when the query becomes load-bearing.

### Request-scoped waitUntil

4. **`ctx.waitUntil` may only carry work that is safe to silently lose** —
   telemetry, cache warms, best-effort notifications. Anything whose loss
   strands user-visible state (task status, session lifecycle, resource
   teardown) MUST run in a job-owned context: a Durable Object alarm
   (TaskRunner pattern), or an equivalent durable mechanism (rule 43).
5. When handing work to a DO, **persist the job and its alarm in one storage
   transaction**, mark the attempt durably before non-idempotent phases start,
   and classify interrupted attempts on re-entry (fail closed before the
   point-of-no-return milestone; finalize idempotently after it). See
   `apps/api/src/durable-objects/task-runner/instant-launch.ts`.
6. An outer sweep (rule 47 escape path) must still backstop the DO — alarms
   are reliable, not infallible.

## Quick Compliance Check

- [ ] No bound LIKE/GLOB pattern can exceed 50 bytes for any input id/value
- [ ] LIKE-behavior tests seed ≥1 row so the pattern is actually evaluated
- [ ] No multi-second, state-bearing work runs under request-scoped waitUntil
- [ ] DO job handoffs commit state + alarm transactionally with attempt
      classification on re-entry
- [ ] A sweep/cron escape path exists for the states the job can strand

## References

- Task: `tasks/archive/2026-08-07-fix-stuck-sweep-like-limit-and-durable-instant-launch.md`
- `.claude/rules/43-long-running-mcp-tools.md` — job contexts independent of requests
- `.claude/rules/47-control-loop-io-budget.md` — candidate escape paths
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md` — step isolation
- `tasks/backlog/2026-05-06-search-messages-pattern-too-complex.md` — the
  user-content variant of the same D1 LIKE limit
