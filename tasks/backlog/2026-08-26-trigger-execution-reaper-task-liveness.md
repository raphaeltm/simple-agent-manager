# Trigger execution reaper must use task liveness

## Problem

Production evidence in SAM idea `01M0YGN8SSGH6ZJPXM5FSD3DNF` shows that `apps/api/src/scheduled/trigger-execution-cleanup.ts` force-failed trigger execution `01M0YC7MNNM16M9NWV61SGAM1C` exactly 30 minutes after creation while linked task `01M0YC7NY9G38VQCNYAHCETYF4` was still actively working. That wall-clock-only verdict freed the trigger's `maxConcurrent=1` slot, admitted a sibling triage run, recorded a live/successful run as failed, and desynced private incident dispatch handling.

This is a rule-58 failure class: the terminal verdict did not read the task row that actually answers whether the execution's work is still live.

## Research findings

- `apps/api/src/scheduled/trigger-execution-cleanup.ts` selects stale `trigger_executions` by `status` plus `COALESCE(started_at, created_at)` and force-fails every selected row. `buildRecoveryReason()` currently treats any non-terminal linked task as `"stuck ... past stale threshold"`, which is the production bug.
- `apps/api/src/services/trigger-execution-sync.ts` is the canonical terminal sync path. It maps completed tasks to completed executions and failed/cancelled tasks to failed executions, but only updates rows still marked `running`.
- `apps/api/src/services/trigger-admission.ts` enforces `skipIfRunning` and `maxConcurrent` by counting execution rows with status `queued` or `running`. If any cleanup/backstop path stores `failed` while a linked task remains non-terminal, admission currently frees the slot and can admit a colliding sibling.
- `apps/api/src/services/platform-feedback-incidents.ts` reclaims expired incident dispatch leases solely by lease age and attempt count. It does not currently protect a `dispatched` incident whose `dispatched_task_id` still points at a non-terminal task.
- Existing cleanup tests include mocked unit tests and real-D1 worker vertical-slice tests in `apps/api/tests/unit/services/trigger-execution-cleanup.test.ts` and `apps/api/tests/workers/trigger-execution-cleanup.test.ts`. The current worker test explicitly expects a non-terminal linked task to be failed and must be inverted.
- Prior trigger cleanup tasks (`tasks/archive/2026-04-11-trigger-execution-cleanup-cron.md`, `tasks/archive/2026-04-11-fix-trigger-execution-lifecycle.md`, `tasks/archive/2026-04-11-fix-trigger-execution-status-sync.md`) explain why orphaned/missing or terminal-unsynced executions still need bounded recovery.
- Rule 47 requires a bounded escape for selected control-loop candidates. Rule 58 requires terminal verdicts to read the same record as the resumer/owner; failed lookups must withhold destructive verdicts. Rule 62 requires tests to enter through the real sweep/admission paths and prove discriminating behavior.

## Implementation checklist

- [ ] Update running execution cleanup so the normal stale threshold only terminalizes executions whose linked task is missing or terminal; preserve non-terminal linked tasks.
- [ ] Sync terminal-unsynced task rows to the correct execution status: `completed` for completed tasks, `failed` for failed/cancelled tasks.
- [ ] Add an env-configurable hard maximum trigger execution residence-time backstop with a `DEFAULT_*` constant and env docs.
- [ ] Ensure any force-failed execution linked to a non-terminal task cannot free trigger admission concurrency while the task is still live.
- [ ] Update private incident dispatch lease reclaiming to preserve expired dispatch leases while their dispatched task is non-terminal, and release/reject only when the task is terminal or missing.
- [ ] Add/update unit tests for task-liveness-aware cleanup, terminal status sync, hard residence config parsing, admission concurrency with failed execution plus live task, and incident dispatch lease liveness.
- [ ] Add/update real-D1 worker cleanup tests, including the production regression: an `in_progress` linked task past the old 30-minute threshold remains running.
- [ ] Run targeted tests before broader validation.

## Acceptance criteria

- [ ] A running trigger execution linked to an `in_progress` task older than `DEFAULT_TRIGGER_STALE_EXECUTION_TIMEOUT_MS` is not failed by cleanup.
- [ ] A running execution linked to a terminal task is reconciled to the correct execution status.
- [ ] A running execution whose task row is missing is failed by cleanup.
- [ ] Orphaned queued execution cleanup remains bounded.
- [ ] The trigger execution cleanup backstop is env-configurable and has a shared `DEFAULT_*` constant.
- [ ] A live linked task still occupies trigger concurrency even if its execution row has been force-failed by a backstop or legacy cleanup state.
- [ ] Private incident dispatch leases are not reclaimed while the dispatched task is alive, and a genuinely dead/terminal control still reclaims or rejects.
- [ ] Tests are discriminating and exercise the real cleanup/admission/reclaim paths rather than hand-feeding final values.

## References

- SAM idea `01M0YGN8SSGH6ZJPXM5FSD3DNF`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `apps/api/src/scheduled/trigger-execution-cleanup.ts`
- `apps/api/src/services/trigger-execution-sync.ts`
- `apps/api/src/services/trigger-admission.ts`
- `apps/api/src/services/platform-feedback-incidents.ts`
- `packages/shared/src/constants/triggers.ts`
