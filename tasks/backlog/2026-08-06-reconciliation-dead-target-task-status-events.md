# Emit task status events from reconciliation dead-target failures

**Status**: backlog
**Created**: 2026-08-06
**Source**: idle-cleanup silent-terminalization recovery

## Problem

`apps/api/src/durable-objects/project-data/reconciliation-dead-target.ts` writes terminal task
failures without appending `task_status_events`. Its legacy missing-project branch also performs an
unscoped task/workspace update. Both behaviors leave weak forensic evidence at a runtime-recovery
boundary.

This writer is out of scope for the idle-cleanup correction and should be hardened independently.

## Acceptance Criteria

- [ ] Every matched task transition to `failed` appends one system status event with the same
      diagnostic reason.
- [ ] Task and workspace mutations require the reporter's project identity and include project
      predicates; the unscoped legacy fallback is removed or converted to a safe rejection.
- [ ] Trigger execution state is synchronized when applicable.
- [ ] The task/event transition is atomic or has an explicitly recoverable consistency design.
- [ ] Tests cover project mismatch, missing project identity, a successful transition, and an
      already-terminal task without producing duplicate events.
