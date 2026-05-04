# Fix Subtask Display as Retry Attempts

## Problem

MCP-dispatched subtasks (tasks created by agents via the `dispatch_task` MCP tool) are displayed in the project chat sidebar as top-level "attempt N" entries instead of being nested under their parent task in a dropdown.

### Root Cause

The MCP `dispatch_task` handler (`apps/api/src/routes/mcp/dispatch-tool.ts`) inserts tasks with `parent_task_id` set correctly but does NOT include `triggered_by` in the SQL INSERT columns. The column defaults to `'user'` per the schema default.

The frontend `isRetryOrFork()` function (`apps/web/src/pages/project-chat/lineageUtils.ts`) checks `triggeredBy !== 'mcp'` to decide if a task is a retry/fork (promoted to root level) vs a subtask (nested as child). Since MCP-dispatched tasks have `triggeredBy = 'user'`, they are classified as retries and shown as "↩ attempt N".

### Affected Files

**Backend:**
- `apps/api/src/routes/mcp/dispatch-tool.ts` — missing `triggered_by` in INSERT

**Frontend:**
- `apps/web/src/pages/project-chat/lineageUtils.ts` — `isRetryOrFork()` classification
- `apps/web/src/pages/project-chat/useTaskGroups.ts` — `TaskInfo` missing `dispatchDepth`

**Tests:**
- `apps/web/tests/unit/sessionTree.test.ts` — existing tree tests (need new cases)

## Research Findings

1. The MCP dispatch INSERT (line 432-466) sets `parent_task_id` to `tokenData.taskId` but omits `triggered_by` column entirely
2. The schema default for `triggered_by` is `'user'` (schema.ts line 496)
3. Frontend `isRetryOrFork()` only checks `triggeredBy !== 'mcp'` — no fallback for bad data
4. `dispatchDepth > 0` is a reliable signal for agent-dispatched tasks but is not in `TaskInfo`
5. Existing tasks in production have wrong `triggered_by` values — need frontend fallback

## Implementation Checklist

- [ ] Add `triggered_by` column with value `'mcp'` to the MCP dispatch_task INSERT in `dispatch-tool.ts`
- [ ] Add `dispatchDepth` to `TaskInfo` interface in `useTaskGroups.ts`
- [ ] Update `buildTaskInfoMap()` to include `dispatchDepth`
- [ ] Update `isRetryOrFork()` in `lineageUtils.ts` to treat `dispatchDepth > 0` as a subtask (fallback for existing bad data)
- [ ] Add unit tests for the new classification logic
- [ ] Verify existing `sessionTree.test.ts` tests still pass

## Acceptance Criteria

- [ ] Agent-dispatched subtasks appear nested under their parent in the chat sidebar
- [ ] User-initiated retries/forks still appear as top-level "attempt N" entries
- [ ] Existing tasks with wrong `triggered_by` but `dispatchDepth > 0` are correctly nested
- [ ] No regressions in existing session tree behavior
