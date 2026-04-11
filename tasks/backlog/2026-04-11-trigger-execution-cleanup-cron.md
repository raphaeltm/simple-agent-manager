# Trigger Execution Cleanup Cron Sweep

## Problem

When a trigger-linked task is manually deleted (or fails without syncing back), the `trigger_executions` row stays stuck with `status = 'running'` forever. Since `skipIfRunning` defaults to `true`, the trigger permanently stops firing — even though nothing is actually running.

**Root cause**: `syncTriggerExecutionStatus()` (`apps/api/src/services/trigger-execution-sync.ts`) queries the task's `trigger_execution_id` column. If the task was deleted, the query returns null and the sync silently no-ops. The execution stays "running" indefinitely.

PR #668 fixed all 5 task-terminal code paths to call `syncTriggerExecutionStatus()`, but it doesn't handle:
- Task manually deleted after trigger fires
- Task failed before `trigger_execution_id` was ever set (submission failure)
- Race conditions where sync was skipped

## Research Findings

### Key Files
- **Schema**: `apps/api/src/db/schema.ts` — `triggerExecutions` table (status: queued/running/completed/failed/skipped)
- **Sync service**: `apps/api/src/services/trigger-execution-sync.ts` — best-effort sync on task terminal transitions
- **Skip logic**: `apps/api/src/scheduled/cron-triggers.ts:125-142` — checks `trigger_executions.status = 'running'` to skip
- **Cron handler**: `apps/api/src/index.ts:839-913` — 5-minute sweep calling existing cleanup functions
- **Constants**: `packages/shared/src/constants/triggers.ts` — `DEFAULT_TRIGGER_EXECUTION_LOG_RETENTION_DAYS = 90` (defined but unused)
- **Existing pattern**: `apps/api/src/scheduled/stuck-tasks.ts` — follows same import/parseMs/sweep pattern

### Env Type
- Lives at `apps/api/src/index.ts` (Env interface, ends at line ~470)
- Trigger vars are at lines 460-469
- Need to add 3 new optional vars

### Constants Index
- `packages/shared/src/constants/index.ts` — re-exports from `./triggers` at lines 190-204
- Need to add new constant to the re-export list

## Implementation Checklist

- [ ] Add `DEFAULT_TRIGGER_STALE_EXECUTION_TIMEOUT_MS = 1_800_000` (30 min) to `packages/shared/src/constants/triggers.ts`
- [ ] Add to `TRIGGER_DEFAULTS` aggregate object
- [ ] Re-export new constant from `packages/shared/src/constants/index.ts`
- [ ] Add 3 env vars to `Env` interface in `apps/api/src/index.ts`:
  - `TRIGGER_STALE_EXECUTION_TIMEOUT_MS?: string`
  - `TRIGGER_EXECUTION_LOG_RETENTION_DAYS?: string`
  - `TRIGGER_EXECUTION_CLEANUP_ENABLED?: string`
- [ ] Create `apps/api/src/scheduled/trigger-execution-cleanup.ts` with:
  - `recoverStaleTriggerExecutions()` — find running executions past stale threshold, check linked task status, transition to failed with reason
  - `purgeOldTriggerExecutions()` — delete completed/failed/skipped executions older than retention period
  - `runTriggerExecutionCleanup()` — orchestrator function returning stats
- [ ] Wire `runTriggerExecutionCleanup()` into cron handler in `apps/api/src/index.ts`
- [ ] Add cleanup stats to cron log output
- [ ] Rebuild shared package
- [ ] Add unit tests for stale recovery (task deleted, task terminal, task stuck, no task)
- [ ] Add unit tests for retention purge
- [ ] Add unit test for kill switch (disabled via env var)

## Acceptance Criteria

- [ ] Trigger executions stuck in `running` for >30min with deleted tasks are recovered to `failed`
- [ ] Trigger executions stuck in `running` for >30min with terminal-state tasks are recovered to `failed` (sync missed)
- [ ] Trigger executions stuck in `running` for >30min with no linked task are recovered to `failed`
- [ ] Old completed/failed/skipped executions beyond retention period are purged
- [ ] Cleanup can be disabled via `TRIGGER_EXECUTION_CLEANUP_ENABLED=false`
- [ ] All timeouts/limits configurable via env vars (Constitution Principle XI)
- [ ] Cleanup stats logged in cron output
- [ ] Unit tests cover all recovery cases and retention purge
