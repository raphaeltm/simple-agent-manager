# Session State Machine: Task Failure Doesn't Propagate to Session Status

## Problem

When a task fails, the session can remain in "Active" (green) state indefinitely. This creates a misleading UI where the user sees a failed task but the session indicator shows everything is fine.

**Root cause**: `failTask()` in `state-machine.ts:259-281` wraps the `stopSession()` RPC call to ProjectData DO in a best-effort try/catch. When the DO is unavailable (e.g., during deploys — "The Durable Object's code has been updated, this version can no longer access storage"), the exception is swallowed and the session remains `active`.

**Two independent stores**: Task status lives in D1 (reliable), session status lives in ProjectData DO embedded SQLite (unreliable cross-DO RPC). They can diverge.

**UI blind spot**: `getSessionState()` only reads `session.status` from the DO. It never cross-references the embedded `session.task?.status` even though that data is already available in the response.

## Research Findings

### Key Files
- `apps/api/src/durable-objects/task-runner/state-machine.ts:256-281` — best-effort stopSession in failTask()
- `apps/api/src/routes/tasks/crud.ts:426-440` — same best-effort pattern in manual status update route
- `apps/api/src/durable-objects/project-data/sessions.ts:57-75` — stopSession SQL that never fires
- `apps/web/src/lib/chat-session-utils.ts:15-20` — getSessionState() only reads session.status
- `apps/web/tests/unit/lib/chat-session-utils.test.ts` — existing test file for getSessionState
- `apps/web/src/components/project-message-view/SessionHeader.tsx:289-300` — renders the green/idle/stopped dot
- `apps/web/src/pages/project-chat/SessionItem.tsx:46` — sidebar session item uses getSessionState

### The Embedded Task Data Is Already Available
`ChatSessionResponse.task?.status` is populated in session detail responses. The UI already renders a red "Failed" badge from this data (SessionHeader.tsx:386-403). But `getSessionState()` ignores it entirely.

### Same Pattern in Multiple Places
The best-effort session stopping appears in:
1. `failTask()` — task runner DO (lines 259-281)
2. `crud.ts` task status update route (lines 426-440)
3. `crud.ts` close conversation (lines 702-710)

All three swallow errors. If any fails, the session stays active.

## Implementation Checklist

### UI Reconciliation (Quick Win)
- [ ] Update `getSessionState()` in `chat-session-utils.ts` to check `session.task?.status` — if task is in a terminal state (failed/completed/cancelled), return 'terminated' regardless of session.status
- [ ] Update `isActiveSession()` to also consider task terminal state
- [ ] Add tests for the new task-status-aware logic in `chat-session-utils.test.ts`

### Backend: Add a 'failed' session status (structural improvement)
- [ ] In `sessions.ts`, add a `failSession()` function that sets status to 'failed' (distinct from 'stopped') so the UI can differentiate clean stops from failures
- [ ] Update `failTask()` to call `failSession()` instead of `stopSession()` when a task fails
- [ ] Add retry logic (1 retry with short delay) for the session status update in `failTask()` before falling back to best-effort

### Documentation
- [ ] Update docs if session state machine is documented anywhere

## Acceptance Criteria
- [ ] When a task fails and the DO RPC succeeds, the session shows as terminated/failed in the UI
- [ ] When a task fails and the DO RPC fails, the UI still shows the correct state by cross-referencing task status
- [ ] Existing tests pass
- [ ] New tests cover: task failed → session state = terminated, task completed → session state = terminated, task cancelled → session state = terminated
- [ ] isActiveSession returns false when task is in terminal state

## References
- Screenshot: `/workspaces/.private/Simple Agent Manager 2026-05-12 12.02.32.png`
- Error: "The Durable Object's code has been updated, this version can no longer access storage"
