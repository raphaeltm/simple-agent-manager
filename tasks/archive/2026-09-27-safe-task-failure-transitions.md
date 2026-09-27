# Guard Task Failure Transitions and Persist Completion PR URLs

## Problem

Several asynchronous failure handlers can overwrite a task that another owner has already completed or cancelled. Separately, the MCP `complete_task` handler stores structured completion evidence but does not copy its PR URL into `tasks.output_pr_url`, leaving shipped work without its canonical PR link.

## Research Findings

- Four SAM session dispatch/retry error paths update `tasks.status = 'failed'` by task ID alone.
- The same stale-owner pattern also existed in HTTP task run/submit, chat start, MCP dispatch/Instant/orchestration retry, and session-recovery handoff paths found during the full writer inventory.
- `TaskRunner.failTask` has an atomic terminal guard, but duplicates the terminal status literals instead of using `TERMINAL_STATUSES`.
- node lifecycle provisioning currently permits only `queued`/`in_progress`; it is safe against terminals but also duplicates transition policy.
- `markQueuedTaskFailed` guards only `queued`, records lifecycle events, and is already used by Instant dispatch. It is the natural shared boundary for pre-run failure writers when upgraded to an atomic D1 batch that records the actual prior status and applies the canonical terminal exclusion inside the update.
- `complete_task` already validates and stores `evidence.prUrl`; its winning update simply omits `output_pr_url`.
- The MCP schema mentions `evidence.prUrl`, while public agent docs describe only generic structured evidence.

## Checklist

- [x] Add a canonical SQL guard derived from `TERMINAL_STATUSES`.
- [x] Upgrade the shared task failure helper to atomically fail any observed non-terminal task and record its real prior status.
- [x] Route SAM dispatch and retry session/startup failures through the shared helper.
- [x] Inventory and guard analogous HTTP task, chat-start, MCP dispatch/orchestration, and recovery-handoff failure writers.
- [x] Apply the canonical terminal guard to TaskRunner and node lifecycle provisioning writes.
- [x] Persist validated `evidence.prUrl` in `output_pr_url` through `complete_task`.
- [x] Clarify the tool schema and public agent docs so callers pass `evidence.prUrl`.
- [x] Add real-SQL attack/control tests and real MCP completion coverage.
- [x] Remove the guard once and prove attack tests fail, then restore it.
- [x] Run focused and full validation and specialist review.

## Acceptance Criteria

- Completed and cancelled tasks cannot be changed to failed by any targeted failure path.
- A non-terminal task can still be marked failed by each targeted owner path.
- Failure guards execute inside the SQL `UPDATE` predicate and derive terminal values from `TERMINAL_STATUSES`.
- `complete_task` persists a validated structured evidence PR URL to `tasks.output_pr_url` and it is readable from D1.
- Tests use `createSqliteD1` and `createSchemaTables` or the all-schema equivalent.

## References

- `apps/api/src/services/task-status.ts`
- `apps/api/src/services/task-failure.ts`
- `apps/api/.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
- `apps/api/tests/helpers/sqlite-d1.ts`
