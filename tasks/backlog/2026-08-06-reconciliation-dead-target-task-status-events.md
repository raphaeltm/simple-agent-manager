# Emit task status events from reconciliation dead-target failures

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** the code fix, in 689e1142f (PR #1916) and 510d9d9f9 (PR #2015).
>   - `reconciliation-dead-target.ts:58-68` now fails the task through the shared
>     `transitionTaskToTerminal` helper. The unscoped legacy fallback was deleted.
>   - That helper rejects a missing or foreign project
>     (`services/task-terminal-transition.ts:151-163`), writes the task update and one status
>     event in a single D1 batch (`:271-318`), and syncs trigger executions (`:344`). An
>     already-terminal task returns early with no second event (`:185-186`).
>   - `project-data/reconciliation.ts:90-113` refuses a candidate whose task project differs
>     from the Durable Object's project.
>   - Tests cover a successful transition and a repeat pass that still yields one status event
>     (`apps/api/tests/unit/durable-objects/reconciliation.test.ts:1391-1399`).
> - **Still open:** tests only.
>   - A real-SQL test where the task row belongs to a foreign project: the transition returns
>     `scope_mismatch`, writes no event and stops no workspace. Pair it with an owner-path control.
>   - A helper-level test for `projectId: null`.
>   - A test that reaches the `reconciliation.project_identity_mismatch` branch
>     (`project-data/reconciliation.ts:98`). No test does today.

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
