# Fix stuck-task supersession TOCTOU race

## Problem

The stuck-task sweep can classify an `in_progress` task as conclusively dead, then write
the terminal status later using only `WHERE id = ? AND status = ?`. Session recovery can
create a live successor between those two points without changing the predecessor's
status, so the stale classification still kills the predecessor.

That false terminalization revokes `sourceTaskGuardCondition` for the recovery successor,
which requires the source task to be non-terminal, causing a double-kill cascade.

## Research findings

- `apps/api/src/scheduled/stuck-tasks.ts` caches `getTaskRuntimeLiveness()` per candidate
  and writes the final terminal status with a status-only optimistic lock.
- `apps/api/src/services/task-runtime-liveness.ts` already defines supersession family
  semantics in `loadTaskSupersession`: same project, newer `session-recovery` task,
  non-terminal live successor, family keyed by `COALESCE(recovery_source_task_id, id)`.
- `apps/api/src/services/session-recovery.ts:createRecoveryTask` nulls predecessor
  `chat_session_id` but intentionally leaves predecessor status non-terminal.
- `.claude/rules/66-ownership-handoff-must-record-the-supersession.md` requires exact
  lineage checks, live-successor preservation, middle-link coverage, and capability
  tests for the guard that was revoked.
- `.claude/rules/28-credential-resolution-fallback-tests.md` applies to SQL guards:
  the `NOT EXISTS` predicate must be tested against a real SQL engine, not a mock.

## Implementation checklist

- [x] Add an atomic `NOT EXISTS` live-successor guard to the stuck-task terminal UPDATE.
- [x] Preserve existing status optimistic locking.
- [x] Add a distinct `stuck_task.skipped_supersession_guard` log when the atomic guard,
  not a status race, blocks the write.
- [x] Add a TOCTOU regression test that probes before a successor exists, inserts the
  successor before the terminal write, and proves the predecessor remains non-terminal.
- [x] Add a control test proving an equivalent dead task without a successor still fails.
- [x] Add a family-chain test proving root-collapsed `recovery_source_task_id` matches
  successors beyond depth two.
- [x] Add a cascade/capability test proving the successor's source guard remains valid
  when the predecessor kill is blocked.

## Acceptance criteria

- A live `session-recovery` successor created between liveness probe and kill write
  atomically prevents predecessor terminalization.
- Non-superseded dead tasks are still terminalized.
- Live successor matching works for root-collapsed recovery families.
- The blocked write is diagnosable via `stuck_task.skipped_supersession_guard`.
- Tests execute the SQL guard against a real SQLite/D1-compatible engine.

## Validation

- Passed: `pnpm --filter @simple-agent-manager/api test -- tests/unit/stuck-task-superseded-termination.test.ts`
  - 12 tests passed.
- Passed: `pnpm --filter @simple-agent-manager/api test -- tests/unit/stuck-task-slept-session-liveness.test.ts tests/unit/services/task-runtime-liveness.test.ts`
  - 74 tests passed.
- Passed: `pnpm --filter @simple-agent-manager/api typecheck`.
- Passed: `pnpm --filter @simple-agent-manager/api lint`.
- Passed: staging deploy run `32835290023`
  - Deploy to Cloudflare completed successfully.
  - Health Check completed successfully.
  - Smoke tests completed successfully.
- Inconclusive local runner: `pnpm --filter @simple-agent-manager/api test:workers -- tests/workers/scheduled-stuck-tasks.test.ts`
  was interrupted after producing no terminal result for more than two minutes.
- Inconclusive local runner: `pnpm --filter @simple-agent-manager/api test`
  was interrupted after producing no terminal result for more than two minutes.

## Specialist review evidence

| Reviewer | Status | Outcome |
| --- | --- | --- |
| task-completion-validator | PASS | Checklist, diff, and acceptance criteria align. Tests cover every requested race/control/family/cascade case. |
| cloudflare-specialist | PASS | D1 guard uses one parameterized UPDATE and a correlated `NOT EXISTS`; no migration or binding change required. Predicate matches the existing indexed supersession semantics. |
| test-engineer | PASS | Regression tests use the real SQLite-backed D1 adapter, force the race at the write boundary, and include discriminating controls. |
| constitution-validator | PASS | No new configurable timeout, URL, deployment identifier, or business limit was introduced. SQL status literals are domain enum constants. |

## Post-mortem

### What broke

Recovered conversations could lose both predecessor and successor tasks when the sweep
terminalized a predecessor after session recovery had already created a successor.

### Root cause

The sweep trusted a cached supersession/liveness result at write time. The final UPDATE
was atomic only with respect to task status, not with respect to recovery lineage.

### Why it was not caught

Existing tests covered the classifier and normal sweep outcomes, but not the interval
between classification and terminal write.

### Class of bug

TOCTOU between a read-side lifecycle classifier and a write-side destructive transition.

### Process fix

For destructive sweep/reaper updates, encode critical "still safe to destroy" predicates
in the mutation itself and add a real-SQL race regression around the write boundary.
