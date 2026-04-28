# Fix: 4-Hour Task Timeout Bypass via Node Heartbeat

## Problem

Tasks can run indefinitely (8+ hours observed) because the stuck-task cron job's `in_progress` handler unconditionally skips recovery when the node has a recent heartbeat — even if the task has been running far past the 4-hour limit.

**Root cause**: `stuck-tasks.ts` lines 242-284. When `executionMs > maxExecutionMs` (4h), the code checks `isNodeHeartbeatRecent()` and `break`s out of the switch if true (line 276). Since VM agents heartbeat every ~60s as long as the node is alive, a stalled task on a healthy node is never terminated.

**Design flaw**: The heartbeat check conflates "is the node alive?" with "is the task making progress?" A healthy node heartbeat does NOT mean the task is progressing.

## Research Findings

- `stuck-tasks.ts`: The `in_progress` case (line 242) checks `executionMs > maxExecutionMs` then checks heartbeat. Fresh heartbeat → skip recovery entirely.
- `task-execution.ts`: `DEFAULT_TASK_RUN_MAX_EXECUTION_MS` = 4 hours. No hard timeout constant exists.
- `env.ts`: `TASK_RUN_MAX_EXECUTION_MS` exists as optional string env var (line 143). No hard timeout env var.
- `stuck-tasks.test.ts`: 6 existing tests. Test "skips in_progress tasks when node heartbeat is recent" (line 97) confirms the bypass behavior. No test for a hard ceiling.
- Previous session (ae434a34) analyzed this correctly but never committed changes.

## Implementation Checklist

- [ ] Add `DEFAULT_TASK_RUN_HARD_TIMEOUT_MS` (8 hours) to `packages/shared/src/constants/task-execution.ts`
- [ ] Export from `packages/shared/src/constants/index.ts`
- [ ] Add `TASK_RUN_HARD_TIMEOUT_MS` to `apps/api/src/env.ts` Env interface
- [ ] Modify `stuck-tasks.ts`: import hard timeout, parse env var, enforce hard timeout BEFORE heartbeat check in the `in_progress` case
- [ ] Add test: task past hard timeout is killed even with fresh heartbeat
- [ ] Add test: task between soft and hard timeout with fresh heartbeat is still skipped (preserves existing behavior)
- [ ] Build shared package and run all tests

## Acceptance Criteria

- [ ] A task running > 8 hours is terminated regardless of node heartbeat status
- [ ] A task running 4-8 hours with a fresh heartbeat is still skipped (grace period preserved)
- [ ] A task running 4-8 hours with a stale heartbeat is terminated (existing behavior)
- [ ] The hard timeout is configurable via `TASK_RUN_HARD_TIMEOUT_MS` env var
- [ ] All existing tests continue to pass
- [ ] New tests prove the hard timeout enforcement

## References

- Bug analysis: Session ae434a34-cfe1-4b1b-81c1-752eee04ef64
- Previous investigation: Task 01KQ98574Q0JA1DMH40N0SGMSZ (scheduler reliability)
- Key file: `apps/api/src/scheduled/stuck-tasks.ts`
