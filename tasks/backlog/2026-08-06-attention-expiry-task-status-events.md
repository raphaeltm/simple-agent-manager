# Emit task status events from attention-expiry failures

**Status**: backlog
**Created**: 2026-08-06
**Source**: idle-cleanup silent-terminalization recovery

## Problem

`apps/api/src/durable-objects/project-data/attention-expiry.ts` changes active tasks to `failed`
when reconciliation attention expires, but it does not append the corresponding
`task_status_events` row. The task row therefore records a terminal state without a complete audit
trail, which weakens incident reconstruction and status-transition consumers.

This follow-up is intentionally separate from the idle-cleanup fix so that the recovery PR does not
expand into unrelated terminal writers.

## Acceptance Criteria

- [ ] The task failure and its `task_status_events` system row are written atomically or with an
      explicitly recoverable consistency design.
- [ ] The event records the prior status, `to_status='failed'`, `actor_type='system'`, and the same
      diagnostic reason stored on the task.
- [ ] The task mutation is project-scoped; missing project identity is rejected rather than falling
      back to an unscoped write.
- [ ] Trigger execution state is synchronized when the failed task belongs to a trigger execution.
- [ ] Stateful tests prove one event per real transition and no event when the guarded task update
      does not match.
