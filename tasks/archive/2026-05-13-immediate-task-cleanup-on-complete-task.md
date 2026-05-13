# Immediate cleanup after explicit task-mode complete_task

## Problem

Task-mode workspaces linger after the agent calls `complete_task`. The MCP `handleCompleteTask` path correctly marks the task as `completed` in D1 but does NOT:
1. Stop/materialize the ProjectData chat session
2. Call `cleanupTaskRun(taskId, env)` to stop the workspace and trigger node warm-pool

Meanwhile, the VM agent callback for `executionStep = 'awaiting_followup'` schedules idle cleanup (15-60 min timer) for task-mode tasks — treating agent turn completion as an implicit lifecycle boundary. This is wrong: only the explicit `complete_task` MCP call should complete/clean up task-mode work.

## Research Findings

### Key files
- `apps/api/src/routes/mcp/task-tools.ts` — `handleCompleteTask()` (lines 137-361)
- `apps/api/src/routes/mcp/index.ts` — MCP router dispatches to `handleCompleteTask` (line 220)
- `apps/api/src/routes/tasks/callback.ts` — VM callback route, handles `executionStep` and terminal status
- `apps/api/src/services/task-runner.ts` — `cleanupTaskRun()`
- `apps/api/src/services/project-data.ts` — `stopSession()`, `markAgentCompleted()`, `scheduleIdleCleanup()`
- `apps/api/src/durable-objects/project-data/idle-cleanup.ts` — DO-side idle cleanup logic
- `apps/api/tests/unit/routes/mcp.test.ts` — existing MCP tests

### Current behavior
1. **Task-mode `complete_task`**: Updates D1 task status to `completed`, syncs trigger execution, recomputes mission scheduler, records activity, emits notification. Does NOT stop session or call `cleanupTaskRun`.
2. **Conversation-mode `complete_task`**: Remaps to `awaiting_followup`, keeps task active. Correct behavior.
3. **VM callback `awaiting_followup` (task mode)**: Marks session agent-completed, schedules idle cleanup timer, records activity, emits notification. This effectively treats agent turn end as task completion boundary.
4. **Terminal callback (completed/failed/cancelled)**: Stops session, calls `cleanupTaskRun` on completion. This is the reference pattern for cleanup.

### Design decisions
- `handleCompleteTask` needs `executionCtx` (for `waitUntil`) — must be passed from the Hono route handler
- Session stop + cleanup should happen in `waitUntil` (non-blocking) same as the terminal callback pattern
- The `awaiting_followup` block in callback.ts should NOT schedule idle cleanup for task-mode; it should only persist git push/PR fields and emit activity events
- Node warm-pool behavior is unchanged — `cleanupTaskRun` already handles this correctly

## Implementation Checklist

- [ ] 1. Pass `executionCtx` to `handleCompleteTask` from MCP router in `index.ts`
- [ ] 2. In `handleCompleteTask` task-mode path: after D1 update + existing side effects, add `waitUntil` to stop/materialize session and call `cleanupTaskRun`
  - Look up chatSessionId from workspace
  - Call `projectDataService.stopSession(env, projectId, chatSessionId)`
  - Call `cleanupTaskRun(taskId, env)` in background
- [ ] 3. In `callback.ts` `awaiting_followup` handler: remove task-mode idle cleanup scheduling
  - Keep: D1 execution step update, git push result persistence, activity event recording
  - Remove: `markAgentCompleted`, `scheduleIdleCleanup`, `session_ended` notification, `pr_created` notification for task-mode
  - These notifications now come from `handleCompleteTask` (already emits `notifyTaskComplete`)
- [ ] 4. Add tests:
  - Task-mode `complete_task` triggers session stop + cleanup
  - Conversation-mode `complete_task` does NOT trigger cleanup
  - VM `awaiting_followup` callback does NOT schedule cleanup for task mode
  - Trigger status sync still happens on `complete_task` (already tested implicitly)

## Acceptance Criteria

- [ ] Task-mode `complete_task` triggers workspace cleanup immediately (via `cleanupTaskRun` in background)
- [ ] Task-mode `complete_task` stops the ProjectData chat session
- [ ] Task-mode `executionStep = 'awaiting_followup'` alone does NOT complete/schedule cleanup
- [ ] Conversation-mode `complete_task` still produces idle/awaiting-follow-up state (no cleanup)
- [ ] Node warm-pool behavior unchanged
- [ ] Existing trigger sync, mission scheduler, activity, and notification behavior preserved
- [ ] Tests cover all four behavioral assertions
