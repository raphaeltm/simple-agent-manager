# Fix Project Chat Message Visibility

## Problem

Messages in project chat sessions are not displaying correctly, despite being present when opening the workspace directly. Multiple bugs in the session query and message conversion pipeline contribute to this issue.

## Root Cause Analysis

### Bug 1: SQL SELECT missing `agent_completed_at` column

In `apps/api/src/durable-objects/project-data.ts`, the `listSessions()` (line 406), `getSession()` (line 445), and `getSessionsByTaskIds()` (line 431) SQL queries don't include `agent_completed_at` in their SELECT. The `mapSessionRow()` function (line 957) reads `row.agent_completed_at` which is always `undefined`, causing:

- `agentCompletedAt` always `null` in API response
- `isIdle` always `false` — sessions that completed show as "Active" forever
- Session state derivation in `ProjectMessageView` breaks — idle countdown never shows
- Sessions never transition to idle state, causing stale "Active" indicators

### Bug 2: Incomplete `ChatSessionResponse` type

In `apps/web/src/lib/api.ts` (line 470-480), the `ChatSessionResponse` interface is missing fields that the API returns: `agentCompletedAt`, `isIdle`, `lastMessageAt`, `workspaceUrl`, `isTerminated`. The frontend uses unsafe casts via `ExtendedSession` to access these.

### Bug 3: Silent message role drops in `chatMessagesToConversationItems`

In `apps/web/src/components/chat/ProjectMessageView.tsx` (line 103-223), the `chatMessagesToConversationItems` function handles `user`, `assistant`, `thinking`, `plan`, `tool`, and `system` roles. Messages with any other role are **silently dropped** — no ConversationItem is created. Workspace chat renders unknown types as `raw_fallback`, but project chat drops them entirely.

### Bug 4: Missing `cleanupAt` in session detail response

The `idle_cleanup_schedule` table stores cleanup timestamps, but the session detail endpoint doesn't join this data. The frontend `ExtendedSession.cleanupAt` is always undefined.

## Implementation Checklist

- [ ] Fix SQL SELECT to include `agent_completed_at` in `listSessions()`, `getSession()`, `getSessionsByTaskIds()`
- [ ] Update `ChatSessionResponse` type to include all fields from the API
- [ ] Add `raw_fallback` handling for unrecognized message roles in `chatMessagesToConversationItems`
- [ ] Add `cleanupAt` to the session detail response (join idle_cleanup_schedule)
- [ ] Add unit tests for `chatMessagesToConversationItems` with unknown roles
- [ ] Add unit test for `mapSessionRow` with `agent_completed_at`
- [ ] Add integration test for session detail endpoint returning complete data

## Acceptance Criteria

- [ ] Sessions with completed agents show "Idle" state, not "Active"
- [ ] `agentCompletedAt` is correctly populated in API responses
- [ ] Unknown message roles render as visible fallback in project chat
- [ ] `cleanupAt` is included in session detail when cleanup is scheduled
- [ ] Frontend types match API response shape without unsafe casts
- [ ] All existing tests continue to pass
- [ ] New tests cover the fixed behaviors

## References

- `apps/api/src/durable-objects/project-data.ts` — ProjectData DO with SQL queries
- `apps/web/src/components/chat/ProjectMessageView.tsx` — Message conversion and display
- `apps/web/src/lib/api.ts` — Frontend API types
- `apps/api/src/routes/chat.ts` — Chat session routes
