# Fix recovery_attempts lifetime counter (sessions bricked after 3 sleep/wake cycles)

## Problem

`session_snapshots.recovery_attempts` is incremented on every wake claim — including successful ones — but never reset to 0 on success. After 3 sleep/wake cycles, `WHERE recovery_attempts < 3` permanently rejects all future wake attempts. The `task-runtime-liveness.ts` classifier mirrors this predicate (line 143), so it also declares healthy snapshots as non-restorable, leading to tasks being failed as "workspace_deleted" even though the snapshot is perfectly healthy and unexpired.

3 production sessions are currently bricked by this bug.

### Production evidence

Snapshot `01M0A9Y61NH4CHSZPVQWT3RZ9T`:
- `status=available`, `degradation=none`, `expires_at` = 7 days out
- `restore_status=restored`, `restored_at = 2026-08-19T06:21:55.996Z` (last wake succeeded)
- `recovery_attempts = 3`, `recovery_error = null`
- Task `01M0CATKJQADXSWCZK42XDFMMQ` was failed: "conclusively gone (workspace_deleted)"

Production distribution: `recovery_attempts: 0→103, 1→4, 2→3, 3→3` — a monotonic staircase piling up at the cap.

### Root cause

The adjacent `sleepAttempts` field IS reset on success (both success paths set `sleepAttempts: 0`), making it a per-cycle consecutive-failure budget. `recoveryAttempts` forgot the same pattern. It is only set to 0 at row creation (`session-snapshot-artifacts.ts:489`).

## Research Findings

1. **Two success paths omit the reset:**
   - `completeSessionSnapshotRecovery` (session-snapshot-recovery-lifecycle.ts:329) — sets `sleepAttempts: 0` but NOT `recoveryAttempts: 0`
   - `markSessionSnapshotAwakeInPlace` (session-snapshot-recovery-lifecycle.ts:366) — same omission

2. **Re-sleep path also omits reset:** `sleepSessionSnapshot` (session-snapshot-sleep-lifecycle.ts:387) resets `recoveryStatus: null` and `recoveryError: null` but NOT `recoveryAttempts`

3. **Classifier mirrors the predicate:** `task-runtime-liveness.ts:143` — `if (snapshot.recoveryAttempts >= maxRecoveryAttempts) return false` — healthy snapshots are declared non-restorable once counter hits 3

4. **Row creation is the only place it's zeroed:** `session-snapshot-artifacts.ts:489` — `recoveryAttempts: 0`

5. **Next migration number:** 0118

6. **Existing test file:** `apps/api/tests/unit/session-snapshots.test.ts` uses `createSqliteD1` + `createSchemaTables` pattern with real SQL engine

## Implementation Checklist

- [x] Add `recoveryAttempts: 0` to `completeSessionSnapshotRecovery` update set (~line 329)
- [x] Add `recoveryAttempts: 0` to `markSessionSnapshotAwakeInPlace` update set (~line 366)
- [x] Add migration `0118_reset_bricked_recovery_attempts.sql` — UPDATE session_snapshots SET recovery_attempts = 0 WHERE recovery_attempts >= 3 (no restore_status filter — safe for both bug-bricked and genuinely-failed rows)
- [x] Write regression test: 4 claim→complete cycles on same snapshot, assert 4th claim succeeds. Verified test FAILS on pre-fix code (cycle 1 assertion fails: recovery_attempts=1 instead of 0).
- [x] Write regression test for `markSessionSnapshotAwakeInPlace`: verifies recovery_attempts resets to 0 from initial value of 2
- [x] Add process rule about per-cycle vs lifetime budget counters (`.claude/rules/61-per-cycle-budget-counters.md`)
- [x] Add `recoveryAttempts: 0` to `markSessionSnapshotSleepingWithConfig` (~line 388) — re-sleep path resets counter for fresh cycle
- [x] Write exhaustion test: 3 consecutive failed wakes exhaust the budget, 4th claim rejected
- [x] Write re-sleep reset test: entering a new sleep cycle zeroes recovery_attempts

## Acceptance Criteria

- [x] A session can sleep and wake unlimited times without being bricked
- [x] The `recovery_attempts` counter resets to 0 after each successful wake
- [x] Failed wakes still increment the counter (3 consecutive failures still exhaust the budget — claim WHERE clause unchanged)
- [x] The 3 currently bricked production snapshots are unblocked by the migration
- [x] Regression test proves the 4th wake succeeds and is discriminating (fails on pre-fix code)
- [x] `task-runtime-liveness.ts` classifier correctly sees post-reset snapshots as restorable (no code change needed — it already mirrors the claim's predicate)

## Post-Mortem

### What broke
Sessions that slept and woke 3 times were permanently bricked on the 4th wake attempt. The wake UI showed "recovery_attempts_exhausted" and the stuck-task reconciler failed the task as "workspace_deleted".

### Root cause
`recoveryAttempts` was designed as a consecutive-failure budget (like `sleepAttempts`) but was never reset on success. It was incremented in the claim's WHERE clause atomically but the two success paths (`completeSessionSnapshotRecovery`, `markSessionSnapshotAwakeInPlace`) only reset `sleepAttempts: 0`, not `recoveryAttempts: 0`.

### Timeline
- The counter was set to 0 only at row creation since the session snapshot feature was introduced
- Every sleep/wake cycle consumed one attempt permanently
- User hit the cap after 3 successful sleep/wake cycles on a long-running session

### Why it wasn't caught
No test exercised more than one sleep/wake cycle on the same snapshot row. The existing tests verified single claim→complete flows but never tested the counter accumulation across cycles.

### Class of bug
**Per-cycle budget counter that behaves as a lifetime counter due to missing reset on success.** Any counter that gates access and is incremented on attempt must be reset when the gated operation succeeds, unless it is explicitly documented as a lifetime budget.

### Process fix
Add a rule about per-cycle vs lifetime budget counters.

## References

- `apps/api/src/services/session-snapshot-recovery-lifecycle.ts` — the two success paths
- `apps/api/src/services/session-snapshot-artifacts.ts:489` — only place recoveryAttempts is zeroed
- `apps/api/src/services/session-snapshot-sleep-lifecycle.ts:387` — re-sleep path
- `apps/api/src/services/task-runtime-liveness.ts:143` — classifier
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
- `.claude/rules/02-quality-gates.md` — regression test requirements
