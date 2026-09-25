# A retried wake step restores the session but can never commit it

## Problem

`apps/api/src/durable-objects/task-runner/agent-session-step.ts` marks the snapshot recovery
failed (`failSessionSnapshotRecovery`, around lines 120-129) on the step's first error, then the
TaskRunner retries the step with backoff. A retry can restore the session successfully, but
`completeSessionSnapshotRecovery` only commits a row whose `recovery_status` is `waking` or
`restored`, so it throws "Strict session restore succeeded but lifecycle recovery commit failed".
The recovery task fails, one of the conversation's wake attempts is spent, and the queued prompt
that asked for the wake is dropped.

## Context

Found while verifying failed-task preservation on staging (branch
`sam/preserve-failed-tasks-work-fn8ba7`, 2026-09-25): recovery task
`01M3CAGD70J963C17CG51KPPYJ` — step error 524 at 13:13:02 (see
`tasks/backlog/2026-09-25-wake-agent-install-bound-to-request.md`), retry at 13:13:15 logged
`task_runner_do.step.agent_session_started`, then 13:13:16 "lifecycle recovery commit failed".
Production shows the same error once (2026-08-26).

## Acceptance Criteria

- [ ] A transient `agent_session` error does not mark the snapshot recovery failed while the step
      still has retries, or a retry of the same recovery task can re-arm it before committing
      (compare-and-set on `recovery_task_id`).
- [ ] A regression test drives the real step: first attempt fails transiently, retry succeeds, the
      recovery commits and the conversation wakes.
- [ ] When retries are exhausted the recovery still ends failed, as today.
