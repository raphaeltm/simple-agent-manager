# Fix Trigger Execution Status Sync

## Problem

Cron triggers permanently stop firing because `triggerExecutions.status` stays stuck at `running` even after the associated task completes. The cron sweep's `skipIfRunning` check sees the stale `running` execution and creates a `skipped` record on every subsequent fire, permanently blocking the trigger.

### Root Cause

The trigger execution status is only synced when tasks transition via `setTaskStatus()` in `apps/api/src/routes/tasks/_helpers.ts:237-260`. However, **four code paths** transition task status using raw SQL without calling `setTaskStatus()`:

1. **MCP `complete_task` (task mode)** — `apps/api/src/routes/mcp/task-tools.ts:240-249`: Sets task to `completed` but never syncs `triggerExecutions`
2. **TaskRunner DO `failTask()`** — `apps/api/src/durable-objects/task-runner/state-machine.ts:195-197`: Sets task to `failed` but never syncs `triggerExecutions`
3. **Idle cleanup `completeTaskInD1()`** — `apps/api/src/durable-objects/project-data/idle-cleanup.ts:317-328`: Sets task to `completed` but never syncs `triggerExecutions`
4. **Stuck task recovery** — `apps/api/src/scheduled/stuck-tasks.ts:402-405`: Sets task to `failed` but never syncs `triggerExecutions`

The **only path that DOES sync** is `setTaskStatus()` in `_helpers.ts`, used by REST API `PATCH /tasks/:taskId` and workspace callback.

### Sequence That Causes the Bug

1. Cron trigger fires → `triggerExecutions` row created with `status = 'running'`
2. Task runs, agent calls MCP `complete_task` → D1 tasks row set to `completed`
3. `triggerExecutions.status` remains `running` (never updated!)
4. Next cron sweep: `skipIfRunning` check sees `running` → creates `skipped` execution
5. Trigger never fires again

## Research Findings

### Key Files
- `apps/api/src/routes/tasks/_helpers.ts:237-260` — The canonical sync logic (lines 238-260)
- `apps/api/src/routes/mcp/task-tools.ts:134-324` — MCP complete_task handler
- `apps/api/src/durable-objects/task-runner/state-machine.ts:167-278` — TaskRunner failure path
- `apps/api/src/durable-objects/project-data/idle-cleanup.ts:317-329` — Idle cleanup
- `apps/api/src/scheduled/stuck-tasks.ts:398-425` — Stuck task recovery
- `apps/api/src/scheduled/cron-triggers.ts:126-160` — Skip check logic
- `apps/api/src/db/schema.ts:1027-1055` — triggerExecutions table schema

### triggerExecutions Schema
- `id`, `triggerId`, `projectId`, `status` (queued/running/completed/failed/skipped), `skipReason`, `taskId`, `errorMessage`, `scheduledAt`, `startedAt`, `completedAt`
- Active index on `(triggerId, status) WHERE status IN ('queued', 'running')`

### Tasks Schema (FK fields)
- `triggerExecutionId` — links to the specific execution
- `triggerId` — links to the trigger
- `triggeredBy` — source: 'user' | 'cron' | 'webhook' | 'mcp'

## Implementation Checklist

- [x] **1. Extract reusable `syncTriggerExecutionStatus()` helper**
  - Created `apps/api/src/services/trigger-execution-sync.ts`
  - Works with raw D1Database (not Drizzle) since all broken paths use raw SQL
  - Best-effort: catches and logs errors, never fails the parent operation

- [x] **2. Add sync to MCP `complete_task` handler (task mode)**
  - Added in `apps/api/src/routes/mcp/task-tools.ts` after successful task completion

- [x] **3. Add sync to TaskRunner DO `failTask()`**
  - Added in `apps/api/src/durable-objects/task-runner/state-machine.ts` after task failure

- [x] **4. Add sync to idle cleanup `completeTaskInD1()`**
  - Added in `apps/api/src/durable-objects/project-data/idle-cleanup.ts` after task completion

- [x] **5. Add sync to stuck task recovery**
  - Added in `apps/api/src/scheduled/stuck-tasks.ts` after task failure
  - Helper queries task for triggerExecutionId internally, no need to change SELECT

- [x] **6. Write tests**
  - `apps/api/tests/unit/services/trigger-execution-sync.test.ts` — 9 tests covering:
    - completed/failed/cancelled sync
    - no-op when task has no trigger execution
    - no-op when task not found
    - best-effort (doesn't throw on SELECT/UPDATE errors)
    - default error messages

- [x] **7. Update documentation**
  - Task file updated with implementation notes

## Acceptance Criteria

- [ ] Cron triggers continue to fire after a triggered task completes via MCP `complete_task`
- [ ] Cron triggers continue to fire after a triggered task fails via TaskRunner DO
- [ ] Cron triggers continue to fire after a triggered task is completed by idle cleanup
- [ ] Cron triggers continue to fire after a triggered task is failed by stuck task recovery
- [ ] Trigger execution sync failures do not block task status transitions (best-effort)
- [ ] All paths that transition task to terminal status sync trigger executions consistently
- [ ] Tests cover each path

## References

- Chat session `aed5a337-2fa7-4740-b4cf-3ab8d0c789a5` — original investigation
- Failed task `01KNWREES7F853PRF9S78Z3BS7` — previous attempt
