# Workspace Lifecycle Fixes

**Created:** 2026-03-16
**Reference:** `docs/architecture/workspace-lifecycle.md` (exhaustive code path trace)
**Priority:** HIGH — workspaces run forever, incurring cloud costs; chat UI shows stale status

## Problem Statement

Multiple bugs in the workspace lifecycle system cause workspaces to never get cleaned up and chat sessions to show "Active" indefinitely. The root cause is that the workspace and chat session lifecycles are **not synchronized** — stopping a workspace doesn't stop the session, and the idle timeout mechanism has gaps that prevent it from firing for task-driven workspaces.

### User-Reported Symptoms

1. Workspaces never get cleaned up automatically
2. Chat sessions show "Active" forever, even after the workspace is stopped or deleted
3. The only reliable way to stop a session is the "Mark Complete" button in the chat dropdown
4. Stopping a workspace from the workspace page doesn't update the chat status

## Research Findings

All findings are traced with specific file:function:line references in `docs/architecture/workspace-lifecycle.md`. Summary:

### BUG 1: Task-Driven Workspaces May Never Get Idle Timeout Checks (HIGH)

- **Root cause:** Session created with `workspaceId=null` → no `workspace_activity` row → no alarm scheduled
- `linkSessionToWorkspace()` (`project-data.ts:412-433`) updates `chat_sessions.workspace_id` but doesn't create `workspace_activity` row or call `recalculateAlarm()`
- `updateMessageActivity()` (`project-data.ts:1074-1087`) creates the row via upsert but doesn't call `recalculateAlarm()`
- `updateTerminalActivity()` (`project-data.ts:1055-1068`) same — creates row but no alarm recalculation
- **Impact:** Workspace idle checks may never run for task-driven workspaces

### BUG 2: Stopping Workspace Doesn't Stop Chat Session (HIGH)

- **Root cause:** `POST /workspaces/:id/stop` (`lifecycle.ts:29-87`) and `DELETE /workspaces/:id` (`crud.ts:362-387`) only change workspace D1 status — they never call `projectDataService.stopSession()`
- The chat UI derives its "Active/Idle/Stopped" indicator from `session.status`, not `workspace.status`
- **Impact:** Chat stays "Active" forever after workspace is stopped or deleted

### BUG 3: Chat UI Never Refreshes Workspace Data (MEDIUM)

- **Root cause:** `ProjectMessageView.tsx:456-483` loads workspace data once when `session.workspaceId` becomes available, then never re-fetches
- Session data IS polled every 3s, but workspace data is static
- **Impact:** Workspace status badge in chat details panel is frozen at initial load value

### BUG 4: Orphaned Workspaces Flagged But Not Cleaned Up (HIGH)

- **Root cause:** Cron sweep sub-layer 2c (`node-cleanup.ts:239-290`) identifies orphaned workspaces (all tasks completed, workspace still running) but only logs them — doesn't stop them
- **Impact:** Running workspaces consume cloud resources indefinitely after their tasks complete

### BUG 5: Node Destruction Doesn't Cascade to Workspace D1 Records (MEDIUM)

- **Root cause:** `deleteNodeResources()` (`nodes.ts:314-353`) destroys VM/DNS but doesn't update workspace status. Only `stopNodeResources()` cascades.
- **Impact:** Orphaned workspace records in D1 pointing to deleted nodes

### BUG 6: Silent Credential Lookup Failure Orphans VMs (CRITICAL)

- **Root cause:** `deleteNodeResources()` (`nodes.ts:333-343`) silently skips VM deletion if user credentials can't be found. Node marked `deleted` in D1 but actual VM keeps running.
- **Impact:** Orphaned VMs incur cloud costs with no platform visibility

## Implementation Checklist

### Phase A: Core Session-Workspace Synchronization

- [ ] **A1: Stop chat session when workspace is stopped** — In `POST /workspaces/:id/stop` (`lifecycle.ts:29-87`), after updating workspace status, call `projectDataService.stopSession()` if workspace has `chatSessionId`. Use `waitUntil()` for best-effort (don't block the stop response).

- [ ] **A2: Stop chat session when workspace is deleted** — In `DELETE /workspaces/:id` (`crud.ts:362-387`), before deleting the workspace record, call `projectDataService.stopSession()` if workspace has `chatSessionId` and `projectId`. Best-effort via `waitUntil()`.

- [ ] **A3: Clean up workspace_activity when workspace is stopped/deleted** — In both stop and delete paths, call a new DO method or inline cleanup to delete the `workspace_activity` row for the workspace, preventing phantom idle checks.

### Phase B: Fix Idle Timeout for Task-Driven Workspaces

- [ ] **B1: Create workspace_activity row in `linkSessionToWorkspace()`** — After updating `chat_sessions.workspace_id`, insert a `workspace_activity` row for the workspace (using `INSERT OR IGNORE` to be idempotent). Call `recalculateAlarm()` to schedule the idle check.

- [ ] **B2: Consider calling `recalculateAlarm()` from activity updates** — Evaluate whether `updateMessageActivity()` and `updateTerminalActivity()` should call `recalculateAlarm()`. This ensures the alarm is always scheduled when activity data exists. Be mindful of performance — `recalculateAlarm()` does a D1 query + alarm set, so throttling may be needed. At minimum, the first upsert (INSERT path, not UPDATE path) should trigger alarm recalculation.

### Phase C: Cron Sweep Improvements

- [ ] **C1: Stop orphaned task workspaces in cron sweep** — In `node-cleanup.ts:239-290`, change from log-only to actually stopping orphaned workspaces. Call `stopWorkspaceOnNode()` + update D1 status to `stopped`. Also stop the associated chat session.

- [ ] **C2: Cascade workspace status on node destruction** — After `deleteNodeResources()` calls in the cron sweep, update all workspaces on the destroyed node to `status='deleted'` (similar to what `stopNodeResources()` already does at `nodes.ts:286-297`). Extract the cascade logic into a shared helper.

- [ ] **C3: Log CRITICAL warning on credential lookup failure** — In `deleteNodeResources()` (`nodes.ts:333-343`), when `credResult` is null, log at error level with structured context (nodeId, userId, providerInstanceId). Record in observability DB as a `credential_missing_vm_orphaned` event so it shows up in the admin dashboard.

### Phase D: Chat UI Freshness

- [ ] **D1: Simplify — derive workspace status from session** — Since BUG 2 fix ensures session status reflects workspace status, the chat UI can derive workspace-related state from the session (which IS polled every 3s). Remove the one-time workspace fetch or make it supplementary (for workspace name/link only, not status). The "Active/Idle/Stopped" indicator already derives from `session.status` via `deriveSessionState()`, so once the backend stops the session when the workspace stops, the UI will update automatically.

### Phase E: Tests

- [ ] **E1: Test that stopping workspace stops session** — Integration test: create workspace with session, call `POST /workspaces/:id/stop`, verify session status is `stopped` in DO.

- [ ] **E2: Test that deleting workspace stops session** — Integration test: create workspace with session, call `DELETE /workspaces/:id`, verify session status is `stopped` in DO.

- [ ] **E3: Test that `linkSessionToWorkspace()` creates workspace_activity and schedules alarm** — Unit test: call `linkSessionToWorkspace()`, verify `workspace_activity` row exists and alarm is scheduled.

- [ ] **E4: Test orphaned workspace cleanup in cron** — Integration test: create workspace with completed task, run cron sweep, verify workspace is stopped.

- [ ] **E5: Test node destruction cascades to workspace status** — Integration test: destroy node via cron sweep, verify associated workspaces are marked `deleted`.

- [ ] **E6: Test credential failure logging** — Unit test: mock credential lookup to return null, call `deleteNodeResources()`, verify error logged and observability event recorded.

## Acceptance Criteria

- [ ] Stopping a workspace via `POST /workspaces/:id/stop` stops the associated chat session (status → `stopped`)
- [ ] Deleting a workspace via `DELETE /workspaces/:id` stops the associated chat session
- [ ] Task-driven workspaces get idle timeout checks (workspace_activity row exists and alarm is scheduled after linking)
- [ ] Chat UI "Active/Idle/Stopped" indicator updates within seconds when workspace is stopped (via session polling)
- [ ] Orphaned task workspaces are stopped by cron sweep (not just flagged)
- [ ] Node destruction cascades workspace status to `deleted`
- [ ] Credential lookup failure during node destruction logs a CRITICAL-level warning with structured context
- [ ] All new behavior covered by automated tests
- [ ] No regressions: existing workspace creation, task submission, idle timeout (for user-created workspaces), and node warm pooling continue to work

## Key Files

| File | Changes |
|------|---------|
| `apps/api/src/routes/workspaces/lifecycle.ts` | A1: stop session on workspace stop |
| `apps/api/src/routes/workspaces/crud.ts` | A2: stop session on workspace delete |
| `apps/api/src/durable-objects/project-data.ts` | A3, B1, B2: workspace_activity + alarm fixes |
| `apps/api/src/scheduled/node-cleanup.ts` | C1: stop orphaned workspaces |
| `apps/api/src/services/nodes.ts` | C2, C3: cascade + credential logging |
| `apps/web/src/components/chat/ProjectMessageView.tsx` | D1: simplify workspace status display |
| `apps/api/tests/integration/` | E1-E6: new tests |
