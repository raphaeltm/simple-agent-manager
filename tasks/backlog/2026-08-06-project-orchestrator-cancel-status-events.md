# Emit task status events when cancelling an orchestrator mission

> **Reconciliation 2026-09-30:** still open. `ProjectOrchestrator.cancelMission()`
> (`durable-objects/project-orchestrator/index.ts:175-206`) still cancels by `mission_id` alone,
> with no status events and no trigger sync. PR #1916 moved the dead-target and attention-expiry
> writers onto `transitionTaskToTerminal` (`services/task-terminal-transition.ts`); the other raw
> terminal writers this audit found insert their own event. That leaves this the only one that
> appends no `task_status_events` row. The natural fix is to route each non-terminal mission task
> through that helper with status `cancelled`.

**Status**: backlog
**Created**: 2026-08-06
**Source**: idle-cleanup silent-terminalization recovery

## Problem

`ProjectOrchestrator.cancelMission()` bulk-updates non-terminal mission tasks to `cancelled` but
does not append `task_status_events` for the individual transitions. It also scopes the task write
by mission only even though the caller supplies `projectId`. Consumers and incident responders can
see the final state without a per-task cancellation transition.

This terminal writer is separate from the idle-cleanup sweep and remains a scoped follow-up.

## Acceptance Criteria

- [ ] The cancellation update requires both `mission_id` and `project_id`.
- [ ] Each task actually changed to `cancelled` receives exactly one system status event containing
      its prior status and a mission-cancellation reason.
- [ ] Task transitions, events, and mission cancellation use an atomic or explicitly recoverable
      consistency design suitable for D1 batch limits.
- [ ] Trigger execution state is synchronized for cancelled trigger-backed tasks when applicable.
- [ ] Tests cover multiple task statuses, project mismatch, repeat cancellation, and event cardinality.
