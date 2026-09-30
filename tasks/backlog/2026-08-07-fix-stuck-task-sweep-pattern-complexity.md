# Fix stuck-task sweep pattern complexity failures

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** the fix, in 8eed3b740 (PR #1765). The failing statement was the TaskRunner-mismatch
>   dedupe lookup. It bound `%do_task_status_mismatch%<taskId>%`, 52 bytes with a 26-char ULID,
>   over D1's 50-byte LIKE limit (`apps/api/src/lib/search-query-limits.ts:44`). It now filters on
>   `task_id = ?` and binds a fixed 25-byte pattern (`scheduled/stuck-tasks.ts:1451-1456`). The
>   sweep runs isolated from the other sweeps (`scheduled/handler.ts:133`).
> - **Still open:**
>   - A discriminating regression guard that bound LIKE patterns stay at or under 50 bytes. The
>     existing dedupe test uses a mock D1 that ignores pattern length
>     (`apps/api/tests/unit/stuck-tasks.test.ts:1943-1960`), so it would pass against the old code.
>   - Confirm in production observability that `stuck_tasks` sweeps complete without errors.
>   - Latent risk for the same guard: `services/trigger-execution-sync.ts:58`, which every terminal
>     transition calls (this sweep included), binds `TRIGGER_EXECUTION_HARD_MAX_FAILURE_PREFIX`
>     plus `%`: exactly 50 bytes. One more character in that constant brings the error back. The
>     call is best-effort, so it would silently stop syncing trigger executions, not fail the sweep.

## Problem

Production observability shows the `stuck_tasks` scheduled sweep failing every five
minutes with `D1_ERROR: LIKE or GLOB pattern too complex` since 2026-08-06. This removes
an independent reconciliation safety net for tasks whose Durable Object lifecycle is
stuck or missing.

This was discovered while investigating production session
`696a21e7-84d1-4080-9060-a77302a7ffc9`. It is separate from the incompatible-agent
cleanup race and must not be folded into that urgent hotfix without tracing the exact
failing statement first.

## Research Needed

- Identify the exact D1 statement and input that produces the pattern-complexity error.
- Determine whether the failure shares a cause with
  the archived task “Fix SAM search input limits” or is an independent
  SQL construction bug.
- Verify per-sweep error isolation still allows all later scheduled work to run.

## Acceptance Criteria

- The production-shaped stuck-task candidate set no longer produces a LIKE/GLOB
  pattern-complexity error.
- A regression test fails against the current statement and passes with the fix.
- The sweep remains bounded and preserves active/recoverable tasks.
- Production observability shows successful `stuck_tasks` sweeps after deployment.
