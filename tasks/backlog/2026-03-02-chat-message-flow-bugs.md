# Chat Message Flow: Bugs and UX Issues

## Summary

End-to-end testing of the project chat flow on staging (app.sammy.party) revealed multiple bugs and UX issues preventing reliable message submission, feedback display, and agent response delivery.

## Critical Bugs

### BUG-1: Follow-up messages via WebSocket are silently dropped (server never processes them)

**Severity:** Critical — user messages are lost
**Root cause:** The client sends `{ type: 'message.send', sessionId, content, role }` over WebSocket, but the `ProjectData` DO's `webSocketMessage()` handler only processes `ping` — it completely ignores `message.send` events.

- **Client code:** `apps/web/src/components/chat/ProjectMessageView.tsx` — `handleSendFollowUp()` sends via `wsRef.current.send()`
- **Server code:** `apps/api/src/durable-objects/project-data.ts:831-842` — only handles `ping`, ignores everything else
- **Historical context:** The comment in `apps/api/src/routes/chat.ts` says "Browser-side POST /:sessionId/messages route removed — messages are now persisted exclusively by the VM agent". But the UI still has a follow-up input that sends via WebSocket, creating a dead path.

**User impact:** Messages typed into an active/idle session appear optimistically in the UI, then disappear on page reload. The message is never persisted or forwarded to the agent.

**Fix:** Implement server-side handling of `message.send` in the DO's `webSocketMessage()`:
1. Parse the incoming message
2. Persist it via `persistMessage()`
3. Forward it to the active agent session on the workspace (POST to VM agent)

### BUG-2: Task failure errors are invisible — session stays "Active" when task fails

**Severity:** Critical — user has no feedback that their task failed
**Root cause:** When a task fails (e.g., VM agent 404, auth error), the task status changes to `failed` but the chat session status remains `active`. The error display in `ProjectMessageView` is gated on `sessionState === 'terminated'`, which requires `session.status === 'stopped'`.

- **API response shows:** `session.status: "active"` + `task.status: "failed"` + `task.errorMessage: "Node Agent request failed: 404"`
- **UI code:** `apps/web/src/components/chat/ProjectMessageView.tsx:391` — `{taskEmbed?.errorMessage && sessionState === 'terminated' && (`
- **Missing:** No code path to stop the session when the task fails

**User impact:** User submits a task, sees the provisioning indicator disappear, then sees a blank chat with "Waiting for messages..." forever. No indication the task failed.

**Fix (two-part):**
1. **Server-side:** When TaskRunner marks a task as `failed`, also stop the associated session via `projectDataService.stopSession()`
2. **UI-side:** Also show task errors when `taskEmbed?.errorMessage` exists regardless of session state, or when `taskEmbed?.status === 'failed'`

### BUG-3: Provisioning indicator doesn't dismiss when task reaches `in_progress` without `workspaceId`

**Severity:** Medium — provisioning indicator stuck
**Root cause:** The provisioning dismiss condition requires BOTH `task.status === 'in_progress'` AND `task.workspaceId`. If the task transitions to `in_progress` before `workspaceId` is populated, the indicator stays visible indefinitely.

- **Code:** `apps/web/src/pages/ProjectChat.tsx:93-95`
- **In practice:** The workspace IS created but there may be a timing gap in the poll

**Fix:** Also dismiss provisioning when `task.executionStep === 'running'` regardless of `workspaceId`, since `running` means the agent has started.

## UX/UI Issues

### UX-1: No loading/thinking indicator after sending a follow-up message

When a user sends a follow-up message in an active session, there's no indication that the system is processing. The message appears as a user bubble but nothing else happens (even if the WebSocket bug is fixed).

**Fix:** Add a typing/thinking indicator after sending a message, showing until an agent response arrives.

### UX-2: Session sidebar shows "0 msgs" for sessions with messages

The sidebar session list shows `0 msgs` for the first session ("CrewAI Workspace") even though a message was sent. This is because the follow-up message is never persisted (BUG-1). But even for the task-submitted session, the message count shows `1 msg` in the sidebar but `messageCount: 1` from the API — only the initial task message, never updated as the agent replies (if it could).

**Fix:** Ensure message counts update in real-time when new messages are persisted.

### UX-3: Excessive polling of session endpoint

The network tab shows ~20 GET requests to the session endpoint in quick succession. Both the WebSocket `onopen` catch-up and the polling fallback run simultaneously, causing redundant requests.

**Fix:** Debounce or gate the polling fallback when the WebSocket is connected and healthy.

### UX-4: Provisioning indicator loses state on navigation

If a user navigates away during provisioning and comes back, the restoration logic (`ProjectChat.tsx:171-196`) skips tasks that are already `in_progress`. The user sees an empty chat with no indicator that the agent is working.

**Fix:** Allow restoring provisioning state for `in_progress` tasks with `executionStep !== 'running'` or show a persistent "Agent is working" banner.

### UX-5: Admin Logs page broken — CF Observability API returns 400

The admin Logs tab shows: "Cloudflare Observability API returned 400: Query not found". This blocks debugging via the admin panel.

### UX-6: `apple-mobile-web-app-capable` deprecation warning

Console warns about deprecated `<meta name="apple-mobile-web-app-capable">` — should use `<meta name="mobile-web-app-capable">`.

## Acceptance Criteria

- [ ] Follow-up messages sent from the chat UI are persisted server-side and forwarded to the agent
- [ ] When a task fails, the session is stopped and the error message is displayed in the chat
- [ ] The provisioning indicator properly dismisses when the task transitions to running
- [ ] Task error messages are visible in the chat UI even if the session is still active
- [ ] Admin Logs page loads without errors (or has graceful fallback)
- [ ] Session message counts update in real-time

## Investigation Evidence

- **Staging URL:** app.sammy.party
- **Date:** 2026-03-02
- **Test sessions:**
  - `8b082a2e-d83a-4316-bec4-b3de5d04b51b` — existing session, follow-up message silently dropped
  - `c30e39fe-b718-461b-a37b-523261fcd410` — task submitted, failed with "Node Agent 404", error not shown
  - `215032c5-6b3a-4f12-9131-a794df7ec54f` — task submitted, in_progress/running, agent auth 401 (expired OAuth token)
- **VM agent logs:** Auth error "Invalid bearer token" — expired OAuth token (user-configuration issue, not a code bug)
