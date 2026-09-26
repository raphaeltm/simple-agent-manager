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

- [x] A transient `agent_session` error does not mark the snapshot recovery failed while the step
      still has retries, or a retry of the same recovery task can re-arm it before committing
      (compare-and-set on `recovery_task_id`).
- [x] A regression test drives the real step: first attempt fails transiently, retry succeeds, the
      recovery commits and the conversation wakes.
- [x] When retries are exhausted the recovery still ends failed, as today.

## Resolution (2026-09-25)

Resolved by the reviewed wake prerequisite (`1667a131b`, with earlier restore/retry/lifecycle fixes).
Recovery stays retryable until terminal failure; accepted VM restores own a bounded operation
context, are joined by retries, and have workspace/shutdown ownership. A persisted API deadline
keeps generic step retry exhaustion from revoking an active restore's token.

The real TaskRunner/bootstrap/SQLite slice passes 17 tests, with 24 deadline/configuration controls.
Go request-cancellation and lifecycle tests pass under `-race`; guard-removal mutations fail as
intended. The cancellation test holds accepted work beyond the request lifetime and then proves a
retry joins its successful result; it uses a short deterministic clock rather than sleeping 100 s.
Final staging deployment36184076940 restored the actual failed VM conversation and its uncommitted
file; the agent read it and answered with the matching hash. This live pass did not deliberately
induce a 524 or make install last over100 s. All created workspaces/nodes were deleted.
Full evidence: `tasks/archive/2026-09-25-wake-survives-hetzner-core-quota.md` and
`tasks/archive/2026-09-25-preserve-failed-task-work.md`.
