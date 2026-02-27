# TDF-1: Task State Machine — Hardened State Transitions & Execution Step Tracking

**Created**: 2026-02-27
**Priority**: High (Foundation — blocks TDF-2, TDF-7)
**Classification**: `business-logic-change`
**Dependencies**: None (this is the foundation)
**Blocked by**: Nothing
**Blocks**: TDF-2 (Orchestration Engine), TDF-7 (Recovery & Resilience)

---

## Context

The task delegation system has a multi-state lifecycle for tasks (draft → queued → delegated → in_progress → completed/failed/cancelled) and a separate execution step breadcrumb trail (node_selection → node_provisioning → ... → running → awaiting_followup). These two dimensions of state are the foundation everything else builds on.

Our research identified several problems with the current implementation:
- Race conditions between the async task runner and the stuck-task cron, currently mitigated by optimistic locking but not thoroughly tested
- Execution steps are persisted as strings with no compile-time validation
- State transition validation exists but lacks comprehensive test coverage for edge cases
- Concurrent transition attempts need formal guarantees

### Research References

- **Flow map**: `docs/task-delegation-flow-map.md` — Section "State Machines" for full state diagrams
- **Analysis**: `docs/notes/task-delegation-system-analysis.md` — Section "Task State Machine"
- **Current implementation**: `apps/api/src/services/task-status.ts`
- **DB schema**: `apps/api/src/db/schema.ts` — task status enum, execution_step column

---

## Problem Statement

The task state machine is the contract that every other subsystem depends on. If a transition is allowed that shouldn't be, or blocked when it should succeed, the entire pipeline breaks. The current implementation works but:

1. **No exhaustive transition tests** — we don't have tests proving every invalid transition is rejected
2. **Execution steps are stringly-typed** — no compile-time guarantee that steps are valid or in order
3. **Optimistic locking is assumed correct but not stress-tested** — concurrent transitions (runner vs. cron) need formal verification
4. **No property-based tests** — we can't prove that from ANY reachable state, only valid transitions succeed
5. **Transition side effects (status events, timestamps) lack atomic guarantees** — a transition could succeed but its status event could fail to record

---

## Scope

### In Scope

- Harden the task status transition validation with exhaustive tests
- Harden the execution step progression with type-safe validation
- Add comprehensive tests for optimistic locking under concurrent access
- Ensure transition + side effects (status events, timestamp updates) are atomic
- Add property-based tests proving the state machine invariants hold
- Document the state machine contract as a testable specification

### Out of Scope

- Changing which transitions are valid (that's a design decision for TDF-2)
- The orchestration engine itself (TDF-2)
- Recovery logic for stuck tasks (TDF-7)

---

## Acceptance Criteria

- [ ] Every valid state transition has a passing unit test
- [ ] Every INVALID state transition has a test proving it throws/rejects
- [ ] Execution steps have a typed enum (not raw strings) with compile-time validation
- [ ] Execution step ordering is enforced — cannot skip steps or go backwards
- [ ] Optimistic locking tests: two concurrent transitions to the same task, only one succeeds
- [ ] Optimistic locking tests: cron fails a task while runner tries to advance it — runner detects and aborts
- [ ] Property-based tests: from any reachable state, only transitions in the allowed set succeed
- [ ] Status event recording is atomic with the transition (both succeed or both fail)
- [ ] Transition timestamps (startedAt, completedAt, updatedAt) are set correctly for each transition
- [ ] All tests pass in CI

---

## Testing Requirements

### Unit Tests

| Test Category | What to Test |
|--------------|-------------|
| Valid transitions | Every edge in the state diagram succeeds |
| Invalid transitions | Every non-edge in the state diagram rejects |
| Execution step validation | Valid step progressions succeed, invalid ones reject |
| Execution step ordering | Cannot skip steps, cannot go backwards |
| Timestamp correctness | startedAt set on queued→delegated, completedAt set on terminal states |
| Status event recording | Each transition creates the correct status event record |

### Integration Tests (Miniflare + D1)

| Test Category | What to Test |
|--------------|-------------|
| Optimistic locking | Two concurrent UPDATE WHERE status=X, one returns 0 rows |
| Atomic transitions | Transition + status event in same transaction |
| Race condition: runner vs. cron | Cron fails task while runner tries delegated→in_progress |
| Race condition: concurrent submits | Two agents try to claim same task |

### Property-Based Tests

| Property | Description |
|----------|-------------|
| Reachability | From the initial state, all non-terminal states are reachable via valid transitions |
| Terminal finality | From any terminal state (completed, failed, cancelled), no transitions succeed except retry/reactivate |
| Monotonic progress | The execution step index never decreases during normal execution |
| Idempotent failure | Calling failTask() on an already-failed task is a no-op |

---

## Key Files

| File | Action |
|------|--------|
| `apps/api/src/services/task-status.ts` | Harden transition validation, add typed execution steps |
| `apps/api/src/db/schema.ts` | Ensure execution step enum is typed |
| `packages/shared/src/types.ts` | Export typed execution step enum for cross-package use |
| `apps/api/tests/unit/task-status.test.ts` | Exhaustive unit tests (create or expand) |
| `apps/api/tests/integration/task-transitions.test.ts` | Miniflare integration tests for locking |
