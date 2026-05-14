# Post-Mortem: Conversation-Mode Tasks Not Completed on Workspace Idle Timeout

**Date**: 2026-05-13
**Severity**: Medium (tasks stay in_progress longer than intended, but eventually cleaned up by 8h hard timeout)
**Impact**: Conversation-mode tasks remain `in_progress` with `execution_step=awaiting_followup` for up to 8 hours after the workspace is deleted, instead of being completed after ~2 hours of idle time.

## What Broke

Conversation-mode tasks were not being marked as `completed` in D1 when the workspace idle timeout fired. The workspace and session were correctly stopped/deleted, but the task stayed `in_progress` until the 8-hour hard timeout in `stuck-tasks.ts` cron caught it.

Production evidence: 6 conversation-mode tasks found stuck in `in_progress`/`awaiting_followup` with their workspaces already `deleted`.

## Root Cause

`checkWorkspaceIdleTimeouts()` in `idle-cleanup.ts` stopped the session, deleted the workspace, and cleaned up workspace activity — but never queried D1 for the associated task or called `completeTaskInD1()`.

For task-mode sessions, this isn't a problem because the 15-minute session idle cleanup (`processExpiredCleanups()`) handles task completion. But conversation-mode sessions are explicitly excluded from that path (line 127 of `callback.ts`: `task.taskMode !== 'conversation'`). This exclusion is by design — conversation-mode sessions should stay alive as long as the workspace is alive. The workspace idle timeout (2 hours) is the **only** cleanup mechanism for conversation mode.

The bug: the only cleanup mechanism for conversation-mode tasks didn't actually complete the task.

## Timeline

- **Unknown**: Bug introduced when conversation mode was added. The `checkWorkspaceIdleTimeouts` function was written before conversation mode existed and was never updated to handle task completion.
- **2026-05-13**: Bug discovered during audit. Production D1 query confirmed 6 stuck tasks.
- **2026-05-13**: Fix implemented — added D1 task query + `completeTaskInD1` call in `checkWorkspaceIdleTimeouts`.

## Why It Wasn't Caught

1. **Two separate cleanup paths**: The 15-min idle cleanup (`processExpiredCleanups`) correctly completes tasks. The 2-hour workspace idle timeout (`checkWorkspaceIdleTimeouts`) did not. The existence of one correct path masked the absence of the other.
2. **Conversation mode exclusion is subtle**: The exclusion at `callback.ts:127` is well-commented, but the downstream implication (workspace idle timeout must handle task completion) was not enforced by any test.
3. **8-hour safety net masks the bug**: The `stuck-tasks.ts` cron eventually catches these tasks, so the symptom is "tasks take 8 hours to complete" rather than "tasks never complete." This makes the bug less visible.

## Class of Bug

**Incomplete lifecycle cleanup across parallel code paths.** When a lifecycle event (workspace deletion) has two independent cleanup paths for different modes, and a new responsibility (task completion) is added to one path but not the other.

## Process Fix

The test file `conversation-idle-timeout.test.ts` now explicitly tests that `checkWorkspaceIdleTimeouts` queries D1 for tasks and calls `completeTaskInD1`. This test would have caught the bug if it existed before conversation mode was added.

The activity event and broadcast payload now include `completedTaskId`, making it observable whether task completion occurred during workspace idle timeout cleanup.
