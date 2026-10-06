# Unified Session/Task/Workspace State Machine

> **Reconciliation 2026-10-05:** Pointer correction only. The 2026-09-30 block cites `session-sleep-execution.ts:367` for the sleep-time ACP `interrupted` call; #2223 moved it to `apps/api/src/services/session-sleep-teardown.ts:316-333`. Gap 5 is still open: the stop paths update `chat_sessions` only (`apps/api/src/durable-objects/project-data/sessions.ts:290-312`).

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** every cascade except gap 5 (paths under `apps/api/src/` unless noted).
>   - Gap 1, workspace stop: `routes/workspaces/workspace-stop.ts:145` →
>     `services/workspace-eviction-lifecycle.ts:53` → shared finalizer
>     `services/workspace-lifecycle-finalizer.ts:257` (`stopSession`), PR #1917. Test:
>     `apps/api/tests/unit/routes/workspace-eviction-real-sql.test.ts:200`.
>   - Gap 2, MCP `complete_task`: `routes/mcp/task-tools.ts:559` calls
>     `cleanupTerminalTaskResources` (session sleeps or stops; runtime torn down), PR #1560.
>   - Gap 3, idle timeout: `durable-objects/project-data/idle-cleanup.ts:315-379` terminalizes
>     the task, then stops the session and the workspace, PR #1760.
>   - Gap 4, workspace deletion: `services/workspace-deletion.ts:456,526` use the shared finalizer.
>   - Gap 6, manual fail/cancel: `routes/tasks/crud.ts:498-509` runs
>     `cleanupTerminalTaskResourcesOrThrow`; failed tasks with recoverable work are kept on purpose.
>   - Cascade tests: `apps/api/tests/workers/workspace-lifecycle-finalizer-vertical.test.ts`.
> - **Still open:** gap 5. `acp_sessions.status` is not updated when the chat session or workspace
>   ends; `durable-objects/project-data/sessions.ts:290-312` updates `chat_sessions` only. ACP rows
>   become `interrupted` only via the heartbeat-timeout sweep (`project-data/acp-sessions.ts`) or
>   on session sleep (`services/session-sleep-execution.ts:367`).

## Problem

Chat sessions, tasks, workspaces, and ACP sessions each have independent state machines stored in different databases (ProjectData DO SQLite vs D1) with no cascading updates between them. Status changes in one entity don't propagate to related entities, leaving orphaned "active" sessions, running workspaces after task completion, and stale task statuses after workspace shutdown.

## Context

Discovered during staging verification of PR #380 (follow-up message fix). After completing a task via the MCP `complete_task` tool, the task status updated correctly in D1 but the chat session remained "Active" in the project sidebar. Manually stopping a workspace also didn't change the chat session status. The only path that properly cascades all state changes is the VM agent callback handler with `toStatus: 'completed'`.

## Current State Machines

| Entity | States | Storage | Updated By |
|--------|--------|---------|------------|
| **Chat Session** | `active`, `stopped` | ProjectData DO SQLite | `stopSession()` in DO |
| **Task** | `draft` → `ready` → `queued` → `delegated` → `in_progress` → `completed`/`failed`/`cancelled` | D1 | Task status service, MCP, callbacks |
| **Workspace** | `pending` → `creating` → `running` → `stopping` → `stopped`/`deleted`/`error` | D1 | Lifecycle routes, task runner |
| **ACP Session** | `pending` → `assigned` → `running` → `completed`/`failed`/`interrupted` | ProjectData DO SQLite | Spec 027 DO handlers |

## Cascading Gaps

### Gap 1: Workspace stop doesn't stop chat session
- **Trigger**: User stops workspace via UI (`POST /workspaces/:id/stop`)
- **Location**: `apps/api/src/routes/workspaces/lifecycle.ts:29-87`
- **What happens**: Workspace status → `stopped` in D1
- **What doesn't happen**: No `projectDataService.stopSession()` call → session remains "active" in DO sidebar
- **Severity**: HIGH

### Gap 2: MCP `complete_task` doesn't stop chat session or clean up workspace
- **Trigger**: Agent calls `complete_task` via MCP server
- **Location**: `apps/api/src/routes/mcp.ts:289-361`
- **What happens**: Task status → `completed` in D1, activity event recorded
- **What doesn't happen**: No `stopSession()`, no `cleanupTaskRun()` → session active, workspace running
- **Severity**: HIGH

### Gap 3: Idle timeout doesn't update task or workspace status
- **Trigger**: Idle cleanup alarm fires in ProjectData DO
- **What happens**: Chat session → `stopped`
- **What doesn't happen**: Task remains `in_progress`, workspace remains `running`
- **Severity**: MEDIUM

### Gap 4: Workspace deletion doesn't stop chat session
- **Trigger**: Workspace marked as `deleted`
- **What doesn't happen**: No cascade to `stopSession()` in DO
- **Severity**: MEDIUM

### Gap 5: ACP session lifecycle completely decoupled
- **Trigger**: Any of the above
- **What doesn't happen**: ACP session status (spec 027) never synchronized with chat session, task, or workspace status
- **Severity**: HIGH

### Gap 6: Task failure doesn't stop workspace
- **Trigger**: User manually marks task as `failed` via UI
- **Location**: `apps/api/src/routes/tasks/crud.ts:330-391`
- **What happens**: Task → `failed`, session stopped (best-effort)
- **What doesn't happen**: Workspace remains `running`
- **Severity**: MEDIUM

## Working Path (for reference)

The **only** path that correctly cascades all state changes is the VM agent task status callback:

```
VM agent sends POST /tasks/:taskId/status/callback with toStatus='completed'
  → apps/api/src/routes/tasks/crud.ts:393-584
  → Task status → 'completed' in D1 ✓
  → projectDataService.stopSession() → session 'stopped' in DO ✓
  → cleanupTaskRun() → workspace cleanup scheduled ✓
```

## Acceptance Criteria

- [ ] Stopping a workspace cascades to stop its linked chat session in the ProjectData DO
- [ ] MCP `complete_task` cascades to stop the linked chat session and trigger workspace cleanup
- [ ] Idle timeout cascades to update task status (→ `completed` or `cancelled`) and stop workspace
- [ ] Workspace deletion cascades to stop linked chat session
- [ ] Task failure/cancellation cascades to stop workspace
- [ ] ACP session status synchronized with chat session terminal states
- [ ] All cascading paths have tests proving the cascade fires
- [ ] Sidebar session list accurately reflects actual state after any status-changing action

## Key Files

- `apps/api/src/durable-objects/project-data.ts` — `stopSession()`, session schema
- `apps/api/src/routes/workspaces/lifecycle.ts` — workspace stop handler (missing cascade)
- `apps/api/src/routes/mcp.ts` — MCP `complete_task` (missing cascade)
- `apps/api/src/routes/tasks/crud.ts` — task status handlers (callback path works, manual path partial)
- `apps/api/src/services/task-status.ts` — task status transition validation
- `apps/api/src/db/schema.ts` — D1 schema for tasks, workspaces, agent sessions

## Design Considerations

- The ProjectData DO and D1 are separate storage systems — cascading updates cross a network boundary and need to be best-effort with retry or idempotent
- Consider whether the DO should be the single source of truth for session state (per recent architectural direction) and D1 task/workspace status should be derived or synchronized
- Consider a unified "lifecycle event" pattern where any terminal state change emits an event that all related entities consume
