# Fix SAM-Chat Dispatch Lineage Gap

## Problem

Tasks dispatched from SAM chat sessions (`sam-session` DO tool) never get `parent_task_id` or correct `dispatch_depth`, so they produce no sidebar session grouping and no hierarchy button in the project chat UI — while workspace-MCP-dispatched tasks get both.

**Root cause**: `apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts` hardcodes `dispatch_depth = 0` and does not write `parent_task_id`. The MCP workspace dispatch path (`apps/api/src/routes/mcp/dispatch-tool.ts`) correctly sets both.

## Research Findings

### Two dispatch paths, one UI consumer
1. **MCP dispatch** (`dispatch-tool.ts`): Sets `parent_task_id = tokenData.taskId`, `dispatch_depth = currentTask.dispatchDepth + 1`, `triggered_by = 'mcp'`
2. **SAM-session dispatch** (`dispatch-task.ts`): Sets `dispatch_depth = 0`, `triggered_by = 'mcp'`, no `parent_task_id`

### UI consumption
- `useTaskGroups.ts` -> `buildTaskInfoMap()` reads `parentTaskId`, `triggeredBy`, `dispatchDepth`
- `sessionTree.ts` uses `isRetryOrFork()` to decide nesting: tasks with `triggeredBy='mcp'` OR `dispatchDepth > 0` are subtasks
- `buildHierarchyTree.ts:hasHierarchy()` checks if a task has parent or children that are genuine subtasks
- Both require `parentTaskId` to be set for any grouping

### SAM-session ToolContext
- `ToolContext` has `env`, `userId`, `projectId?` — NO `taskId`
- SAM-session dispatch needs an optional `parentTaskId` input parameter
- The SAM session is user-level, but can dispatch multiple tasks that logically relate

### task_dependencies table
- NOT written by SAM dispatch (contrary to task description)
- Written by orchestrator/mission tools for scheduling dependencies
- Consumed only by orchestrator scheduling, NOT by UI
- **Decision**: Keep `parent_task_id` as the single canonical lineage field. `task_dependencies` serves scheduling, not UI lineage. Document in PR.

## Implementation Checklist

- [x] Add `parentTaskId` to SAM dispatch tool schema and `DispatchTaskInput`
- [x] When `parentTaskId` provided, look up parent task to get its `dispatch_depth`
- [x] Set `parent_task_id` and `dispatch_depth = parent.dispatch_depth + 1` in INSERT
- [x] When no `parentTaskId`, keep current behavior (`dispatch_depth = 0`, no parent)
- [x] Validate parent task exists and belongs to same project + user
- [x] Keep `triggered_by = 'mcp'` (already correct for subtask classification)
- [x] Write vertical slice test: SAM dispatch with parentTaskId -> verify task row has correct lineage
- [x] Write regression test: dispatch lifecycle -> list tasks -> verify taskInfoMap has hierarchy
- [x] Update comment at top of file (remove "no parent task or depth constraints")

## Acceptance Criteria

- [ ] SAM-chat dispatched task with `parentTaskId` gets correct `parent_task_id` and `dispatch_depth` in DB
- [ ] `listProjectTasks` returns the lineage fields so `buildTaskInfoMap` produces correct `TaskInfo`
- [ ] `hasHierarchy(parentTaskId)` returns `true` when child task is dispatched from SAM
- [ ] `isRetryOrFork()` returns `false` for SAM-dispatched subtasks (treated as subtask, not retry)
- [ ] SAM dispatch without `parentTaskId` still works (dispatch_depth=0, no parent)
- [ ] Vertical slice test covers the happy path
- [ ] Regression test covers the propagation lifecycle
- [ ] PR documents the lineage design decision (parent_task_id vs task_dependencies)

## References

- MCP dispatch: `apps/api/src/routes/mcp/dispatch-tool.ts:462`
- SAM dispatch: `apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts`
- Lineage utils: `apps/web/src/pages/project-chat/lineageUtils.ts`
- Task groups: `apps/web/src/pages/project-chat/useTaskGroups.ts`
- Session tree: `apps/web/src/pages/project-chat/sessionTree.ts`
- Hierarchy: `apps/web/src/components/task-hierarchy/buildHierarchyTree.ts`
