# Fix Trigger Execution Lifecycle Bugs

## Problem

Trigger executions can get permanently stuck in 'queued' or 'running' status, blocking all future runs for that trigger because the concurrent execution limit (default: 1) counts them as active. There is no automated recovery for stuck 'queued' executions, and no manual way for users to clean up stuck executions from the UI.

## Research Findings

### 1. Stale cleanup only handles 'running' executions
`apps/api/src/scheduled/trigger-execution-cleanup.ts:107` queries only `status = 'running'`. If an execution gets orphaned in 'queued' (e.g., Worker timeout during `submitTriggeredTask`), it stays there forever.

### 2. Inconsistent concurrent limit checks
- **Manual "Run Now"** (`apps/api/src/routes/triggers/crud.ts:616`): counts `status IN ('queued', 'running')` via `inArray`
- **Cron sweep** (`apps/api/src/scheduled/cron-triggers.ts:149-154`): counts only `status = 'running'` via `eq`
- These should be consistent — both should count 'queued' + 'running'

### 3. No manual cleanup tools
No API endpoint or UI control exists to delete/force-fail stuck trigger executions. Users have no way to recover.

### 4. Existing test infrastructure
`apps/api/tests/unit/services/trigger-execution-cleanup.test.ts` has a comprehensive mock DB pattern for testing the cleanup module. New tests should follow this pattern.

### 5. Shared constants
Constants live in `packages/shared/src/constants/triggers.ts` and are re-exported from `packages/shared/src/constants/index.ts`. New constants follow the same pattern (`DEFAULT_TRIGGER_*`).

### 6. Env interface
`apps/api/src/index.ts` lines 472-475 already have env vars for trigger cleanup config. New env vars go here.

## Implementation Checklist

### Backend
- [ ] Add `DEFAULT_TRIGGER_STALE_QUEUED_TIMEOUT_MS` constant (default: 300000 = 5 min) to `packages/shared/src/constants/triggers.ts`
- [ ] Export new constant from `packages/shared/src/constants/index.ts`
- [ ] Add `TRIGGER_STALE_QUEUED_TIMEOUT_MS` to Env interface in `apps/api/src/index.ts`
- [ ] Add stale 'queued' recovery pass to `trigger-execution-cleanup.ts` — separate from the running pass, with its own configurable timeout
- [ ] Update `TriggerExecutionCleanupStats` to include `staleQueuedRecovered` count
- [ ] Fix concurrent limit check in `cron-triggers.ts` to use `inArray(['queued', 'running'])` matching the manual run endpoint
- [ ] Add `DELETE /:triggerId/executions/:executionId` endpoint to `crud.ts` — delete a single execution record (only non-running)
- [ ] Add `POST /:triggerId/executions/cleanup` endpoint to `crud.ts` — force-fail all stuck executions for a trigger

### Frontend
- [ ] Add `deleteExecution()` and `cleanupStuckExecutions()` client functions to `apps/web/src/lib/api/triggers.ts`
- [ ] Add delete button on individual execution rows in `ExecutionHistory.tsx` (for non-running stuck executions)
- [ ] Add "Clear stuck executions" action button in `ExecutionHistory.tsx` (visible when stuck executions exist)

### Tests
- [ ] Add unit tests for stale 'queued' recovery in `trigger-execution-cleanup.test.ts`
- [ ] Add unit tests for cleanup and delete API endpoints
- [ ] Add test verifying concurrent limit consistency (both paths count queued + running)

## Acceptance Criteria

- [ ] Stale 'queued' executions (>5 min) are automatically recovered to 'failed' by the cron sweep
- [ ] Stale 'running' executions continue to be recovered (existing behavior preserved)
- [ ] Cron sweep concurrent limit check counts both 'queued' and 'running' executions
- [ ] Users can delete individual stuck execution records via API/UI
- [ ] Users can bulk-cleanup all stuck executions for a trigger via API/UI
- [ ] All new constants are configurable via environment variables
- [ ] Existing cleanup tests continue to pass
- [ ] New tests cover all new code paths

## Key Files
- `packages/shared/src/constants/triggers.ts`
- `packages/shared/src/constants/index.ts`
- `apps/api/src/index.ts` (Env interface)
- `apps/api/src/scheduled/trigger-execution-cleanup.ts`
- `apps/api/src/scheduled/cron-triggers.ts`
- `apps/api/src/routes/triggers/crud.ts`
- `apps/web/src/components/triggers/ExecutionHistory.tsx`
- `apps/web/src/lib/api/triggers.ts`
- `apps/api/tests/unit/services/trigger-execution-cleanup.test.ts`
