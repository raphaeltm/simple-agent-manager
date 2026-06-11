# Fix SAM-chat dispatch lineage gap

## Problem

Tasks dispatched from SAM chat sessions (`sam-session` DO tool `dispatch_task`) never get parent/child lineage in the UI because:

1. The SAM dispatch tool hardcodes `dispatch_depth = 0` and never sets `parent_task_id`
2. Both are set to `triggered_by = 'mcp'`, but without `parent_task_id`, the UI lineage system has nothing to build hierarchy from

The workspace MCP dispatch path (`apps/api/src/routes/mcp/dispatch-tool.ts`) correctly writes `parent_task_id = tokenData.taskId` and `dispatch_depth = parentDepth + 1`, producing working hierarchy in the sidebar tree and hierarchy modal.

## Research Findings

### Key files
- `apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts` — SAM dispatch tool (needs fix)
- `apps/api/src/routes/mcp/dispatch-tool.ts` — MCP dispatch tool (reference implementation)
- `apps/web/src/pages/project-chat/useTaskGroups.ts` — `TaskInfo` type and `buildTaskInfoMap`
- `apps/web/src/pages/project-chat/lineageUtils.ts` — `isRetryOrFork()` classification
- `apps/web/src/pages/project-chat/sessionTree.ts` — `buildSessionTree()` hierarchy builder
- `apps/web/src/components/task-hierarchy/buildHierarchyTree.ts` — `hasHierarchy()` + hierarchy modal tree

### UI lineage classification
- `isRetryOrFork()` returns `false` (= subtask, shown as child) when `triggeredBy === 'mcp'` OR `dispatchDepth > 0`
- `hasHierarchy()` checks for `parentTaskId && !isRetryOrFork(info)` — true for genuine subtasks
- Both sidebar tree and hierarchy modal use the same classification

### SAM dispatch tool context
- `ToolContext` has `userId` and optional `projectId` but no `taskId`
- SAM sessions can dispatch tasks without a parent task context (user-initiated)
- The SAM tool already sets `triggered_by = 'mcp'` in the INSERT

### `task_dependencies` table
- Written by orchestration tools (`orchestration-tools.ts`), NOT by SAM dispatch
- Used for scheduling/ordering, not lineage
- Decision: `parent_task_id` remains the single canonical lineage field; `task_dependencies` stays reserved for scheduling semantics

### Existing test patterns
- `apps/api/tests/unit/durable-objects/sam-dispatch-task-mode-visibility.test.ts` — mocks drizzle, services; tests SAM dispatch directly

## Implementation Checklist

- [ ] 1. Add `parentTaskId` optional input to `dispatchTaskDef.input_schema` and `DispatchTaskInput` interface
- [ ] 2. When `parentTaskId` is provided, look up parent task's `dispatch_depth` from D1 and compute `newDepth = parentDepth + 1`; validate parent task belongs to same project/user
- [ ] 3. Pass `parent_task_id` and computed `dispatch_depth` into the INSERT statement (replacing the hardcoded `0`)
- [ ] 4. When no `parentTaskId` is provided, keep `dispatch_depth = 0` and `parent_task_id = NULL` (backward compatible)
- [ ] 5. Write vertical slice test: dispatch with realistic D1 state (parent task row, project), assert created task has correct `parent_task_id`, `dispatch_depth`, `triggeredBy`
- [ ] 6. Write regression test: construct SAM-chat dispatch → UI task list fetch lifecycle, assert lineage arrives in `taskInfoMap`

## Acceptance Criteria

- [ ] SAM-chat dispatched tasks with `parentTaskId` input get `parent_task_id` and correct `dispatch_depth` in D1
- [ ] `triggeredBy` remains `'mcp'` — consistent with workspace MCP path
- [ ] `isRetryOrFork()` returns false for SAM-dispatched subtasks (shown as children, not retries)
- [ ] `hasHierarchy()` returns true for tasks with the parent/child relationship
- [ ] Tasks dispatched without `parentTaskId` continue to work as before (depth 0, no parent)
- [ ] Vertical slice test proves lineage propagation end-to-end
- [ ] No changes needed to UI code — existing lineage utils already handle the data correctly

## Decision: `task_dependencies` vs `parent_task_id`

`parent_task_id` remains the **single canonical lineage field** consumed by the UI for hierarchy display. `task_dependencies` is reserved for orchestration scheduling semantics (ordering constraints between tasks in missions). They serve different purposes:
- `parent_task_id` = "who spawned me" (lineage/hierarchy)
- `task_dependencies` = "what must complete before I can start" (scheduling)

No UI changes needed to consume `task_dependencies` for lineage — this would conflate two different relationship types.
