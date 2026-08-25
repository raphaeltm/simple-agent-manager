# TaskRunner handoff mismatch bookkeeping

SAM task: `01M0TY33ERGTBJ5ZRDZHYHS0QJ` · Output branch: `sam/fix-remaining-tasksession-lifecycle-yhs0qj`

## Problem

`recoverStuckTasks()` still persists high-volume warnings that say:

> TaskRunner DO completed but task still in 'in_progress' — possible D1 update failure

Current production evidence shows this is usually not a D1 terminal-state failure. The
TaskRunner DO sets `completed=true` after successful orchestration handoff while the D1 task
row intentionally remains active until the agent/user lifecycle reaches an explicit terminal
state. Persisting that normal tuple as a warning leaves healthy or restorable task/session
workbook state displayed as a possible failure.

## Production evidence

Read-only production queries on 2026-08-24 after PR #1896 production deploy
(`2026-08-24T11:33:05Z`, merge `03595efd4`) found:

- `0` new tasks failed with `workspace_deleted`.
- `0` `ceiling_supersession_query_failed` rows.
- `276` `do_task_status_mismatch` warnings across `24` task IDs.
- All sampled post-deploy mismatch rows had TaskRunner `completed=true`,
  `doCurrentStep='running'`, and a non-terminal task whose liveness was one of:
  - `workspace_deleted_snapshot_resumable`: `197` rows / `17` tasks
  - `workspace_deleted_superseded_by_live_wake`: `54` rows / `5` tasks
  - `task_acp_session_live`: `24` rows / `13` tasks
  - `workspace_sleeping_resumable`: `1` row / `1` task

This matches draft idea `01KT90PKF6167SXZ9YZY0R26MM`'s 2026-08-24 update: the original
TaskRunner/D1 drift finding is now mostly misleading telemetry from normal handoff, not a
demonstrated D1 write defect.

## Research findings

- PR #1896 / merge `03595efd4` is on current `main`; the dominant superseded-predecessor
  false-failure path is already fixed and must not be reimplemented.
- `apps/api/src/scheduled/stuck-tasks.ts` already uses task-scoped liveness to reconcile
  genuinely dead TaskRunner/D1 drift, and existing tests cover missing/error TaskRunner
  status with dead runtime convergence.
- The remaining noisy branch is the `doStatus?.completed` diagnostic path in
  `stuck-tasks.ts`: it persists `do_task_status_mismatch` for every completed TaskRunner
  while D1 remains active, even when `currentStep='running'` represents successful
  orchestration handoff and liveness is live/resumable/superseded.
- The existing 30-minute dedupe intentionally repeats these warnings forever for preserved
  candidates. A genuine pre-handoff completed-DO inconsistency should be durable diagnostic
  evidence, but one row per task is enough; repeating it does not help convergence.

## Implementation checklist

- [x] Classify TaskRunner `completed=true` + `currentStep='running'` + active D1 task as normal
      handoff, not a persisted D1 mismatch warning.
- [x] Keep conclusive dead-runtime reconciliation unchanged.
- [x] Preserve a durable warning for genuine completed-DO/pre-handoff active-task
      inconsistencies.
- [x] Change mismatch dedupe from a 30-minute repeat window to one durable diagnostic per task.
- [x] Add deterministic regression tests for:
  - [x] live normal handoff (`task_acp_session_live`) emits no persisted mismatch warning;
  - [x] restorable/superseded preserved normal handoff emits no persisted mismatch warning;
  - [x] genuine pre-handoff completed-DO inconsistency emits one durable fact-based diagnostic;
  - [x] an existing diagnostic suppresses repeats.
- [x] Update source-contract tests that currently encode the old repeated warning behavior.
- [x] Run focused tests and required quality checks.
- [x] Perform required specialist reviews.
- [x] Create/push a focused PR; do not deploy to staging and do not merge.

## Acceptance criteria

- Normal TaskRunner handoff no longer creates `do_task_status_mismatch` rows for live,
  resumable, or live-superseded work.
- A genuinely inconsistent completed TaskRunner before handoff still produces a bounded,
  accurately named warning with diagnostic context.
- The sweep does not repeat the same mismatch warning every 30 minutes.
- No status terminalization semantics change, and the canonical idleness rule remains intact:
  child tasks/durable waits do not keep parent sessions awake.

## References

- SAM idea `01M0SG7ZEE1XARK4QDG7V6HDPN`
- SAM idea `01KT90PKF6167SXZ9YZY0R26MM`
- PR #1896: https://github.com/raphaeltm/simple-agent-manager/pull/1896
- PR #1899: https://github.com/raphaeltm/simple-agent-manager/pull/1899
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/66-ownership-handoff-must-record-the-supersession.md`

## Workflow exception

The `/do` workflow normally commits the task file to `main` before implementation. This
repository auto-deploys production from `main`, and this task explicitly says not to merge or
enter the shared staging/deployment wave yet. The task file therefore lives on the output
branch and will be reviewed with the code PR.

## Validation evidence

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/stuck-tasks.test.ts` — 52 passed.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/recovery-resilience.test.ts` — 69 passed.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed.
- `pnpm typecheck` — 19 tasks passed.
- `pnpm lint` — 13 tasks passed; warning-only pre-existing a11y/hooks findings outside this diff.
- `pnpm test` — 604 test files / 8,230 tests passed; 21 tasks passed.
- `pnpm build` — 9 tasks passed; warning-only existing Turbo output warning for API build outputs.
- `git diff --check origin/main...HEAD` — passed.

## Specialist review evidence

- `test-engineer` — PASS. New deterministic regression tests call `recoverStuckTasks()`
  through the scheduled-sweep entry point and model the relevant D1, TaskRunner DO,
  ProjectData/ACP, snapshot, and supersession boundaries with concrete rows.
- `cloudflare-specialist` — PASS. No migration or binding changes. The hot production
  path no longer writes to `OBSERVABILITY_DATABASE`; the remaining diagnostic lookup
  is task-scoped and uses the existing `idx_platform_errors_task_id` index before
  applying the JSON-context substring filter.
- `constitution-validator` — PASS. No URLs, timeouts, limits, secrets, or
  deployment-specific identifiers were added. The new handoff sentinel is typed as
  shared `TaskExecutionStep` protocol vocabulary.
- `task-completion-validator` — PASS. Research findings and acceptance criteria map to
  the implemented diff and tests; UI/backend and multi-resource checks are not
  applicable for this scheduled API bookkeeping change.
