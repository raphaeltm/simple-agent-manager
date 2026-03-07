# Fix Chat Session Message Leakage

## Problem

Messages from one chat session are appearing in another session within the same project. This is a data isolation bug that undermines trust in the chat system.

### User-Reported Scenario 1 (2026-03-07) — Frontend path

User sent a follow-up message in a project chat session. The message triggered agent activity in the correct workspace. However, when switching to a different chat session, the same follow-up message appeared there too. Opening the other chat's workspace confirmed the follow-up did NOT actually reach that workspace — but the message persisted in the project chat UI for the wrong session even after a full page refresh.

### User-Reported Scenario 2 (2026-03-07) — Backend path (PROVES NOT FRONTEND-ONLY)

User opened a workspace directly (not via project chat), submitted a message in the workspace chat, then navigated back to the project chat sessions list. The submitted message appeared in the **wrong** chat session. This reproduction path bypasses all frontend session-switching logic — the data is being persisted to the wrong session at the API/VM-agent layer.

## Root Cause Analysis

Deep trace identified bugs at **both backend and frontend layers**. The backend bugs are the primary cause — they write messages to the wrong session in persistent storage, which survives page refresh.

---

### BACKEND BUG 1 (CRITICAL — Root Cause for Scenario 2): `/messages` endpoint trusts client-provided sessionId

**Location:** `apps/api/src/routes/workspaces.ts:1638-1696`

The `POST /api/workspaces/:id/messages` endpoint extracts `sessionId` entirely from the VM agent's request body. It does NOT look up or validate against `workspaces.chatSessionId` in D1:

```
// Only fetches projectId — NOT chatSessionId
.select({ projectId: schema.workspaces.projectId })
```

This means the VM agent can (unintentionally) route messages to any session within the project.

### BACKEND BUG 2 (CRITICAL — Warm Pool Stale Session): Reporter retains old sessionId on warm node reuse

**Location:** `packages/vm-agent/internal/messagereport/reporter.go`

When a warm node is reused for a new workspace:

1. Task A runs on a node, VM agent's Reporter is initialized with `SESSION_A` (from `CHAT_SESSION_ID` env var at cloud-init time)
2. Task A completes, node enters warm pool — Reporter still has `r.sessionID = SESSION_A`
3. User creates a workspace directly on that warm node, gets a new `SESSION_B` in D1
4. `SetSessionID(SESSION_B)` is only called if `createAgentSessionOnNode()` is invoked with a non-empty `chatSessionId` (`workspaces.go:543`)
5. If the user submits a message directly in the workspace (bypassing the task runner), `SetSessionID` is never called — Reporter sends messages tagged with `SESSION_A`
6. Bug 1 above means the API blindly persists them to `SESSION_A` — the wrong session

### BACKEND BUG 3 (HIGH — Race Window): D1 chatSessionId linked before VM agent receives SetSessionID

**Location:** `apps/api/src/durable-objects/task-runner.ts:584-650`

In the task runner, `ensureSessionLinked()` writes `chatSessionId` to D1 immediately. But `SetSessionID` on the VM agent is only called later during `handleAgentSession` → `createAgentSessionOnNode`. Any messages the agent sends during this window go to the old session.

### BACKEND BUG 4 (HIGH — Creation Race): chatSessionId = null window at workspace creation

**Location:** `apps/api/src/routes/workspaces.ts:519-554`

When creating a workspace on an existing node:
1. `INSERT INTO workspaces` — no `chatSessionId` yet
2. `projectDataService.createSession()` — creates session in DO
3. `UPDATE workspaces SET chat_session_id = ?` — links them

Between steps 1 and 3, the workspace has `chatSessionId = null`. Any concurrent read gets null.

### BACKEND BUG 5 (MEDIUM — No Unique Constraint): Multiple workspaces can share chatSessionId

**Location:** `apps/api/src/db/schema.ts:407-454`

No unique index on `workspaces.chatSessionId`. The follow-up prompt routing in `chat.ts:235-249` uses `.limit(1)` — if two workspaces share the same `chatSessionId`, follow-ups go to whichever D1 returns first.

---

### FRONTEND BUG 6: `onMessageRef` Race on Session Switch

**Location:** `apps/web/src/hooks/useChatWebSocket.ts:57-65, 121-122`

The `useChatWebSocket` hook uses a ref pattern (`onMessageRef.current = onMessage`) updated on every React render. When switching sessions:

1. React re-renders with Session B's props, `onMessageRef.current` points to Session B's `setMessages`
2. Old WebSocket for Session A closes asynchronously — between `ws.close(1000)` and `ws.onclose`, `wsRef.current` still points to old socket
3. A `message.new` event for Session A arrives in this window, passes both the `wsRef.current !== ws` guard and `sessionId` filter (using old closure), then calls `onMessageRef.current(msg)` which writes into Session B's state

### FRONTEND BUG 7: Polling Race Condition

**Location:** `apps/web/src/components/chat/ProjectMessageView.tsx:447-473`

The polling fallback can overwrite the new session's messages with the old session's data if an in-flight request resolves after session switch. No `AbortController` is used, and `<ProjectMessageView>` has no `key={sessionId}`.

### FRONTEND BUG 8: WebSocket Broadcast Without Server-Side Session Filtering

**Location:** `apps/api/src/durable-objects/project-data.ts:970-980`

`broadcastEvent()` sends to ALL WebSocket connections for the entire project. Client-side `sessionId` filtering exists but is a weak defense (see Bug 6).

## Research Findings

### Key Files
- `apps/api/src/routes/workspaces.ts:1638-1696` — `/messages` endpoint (Bug 1)
- `packages/vm-agent/internal/messagereport/reporter.go` — Reporter sessionId management (Bug 2)
- `apps/api/src/durable-objects/task-runner.ts:584-650` — Session linking race (Bug 3)
- `apps/api/src/routes/workspaces.ts:519-554` — Workspace creation race (Bug 4)
- `apps/api/src/db/schema.ts:407-454` — Schema, no unique constraint (Bug 5)
- `apps/web/src/hooks/useChatWebSocket.ts` — WebSocket hook (Bug 6)
- `apps/web/src/components/chat/ProjectMessageView.tsx` — Message display, polling (Bug 7)
- `apps/web/src/pages/ProjectChat.tsx:446` — Renders `<ProjectMessageView>` WITHOUT `key={sessionId}`
- `apps/api/src/durable-objects/project-data.ts` — DO broadcastEvent (Bug 8)
- `apps/api/src/routes/chat.ts:235-249` — Follow-up prompt routing (Bug 5 impact)

### Prior Art / References
- Cloudflare Hibernatable WebSockets API supports `acceptWebSocket(ws, tags)` and `getWebSockets(tag)` for server-side filtering
- AdminLogs DO uses per-client state tracking via `setClientState`/`getClientState` pattern
- React `key` prop pattern for resetting component state
- AbortController pattern for cancelling in-flight fetch requests

### Backend Data Isolation
SQL queries are correctly scoped — all message queries use `WHERE session_id = ?`. Cross-project isolation is enforced by the DO model (each project has its own DO instance with independent SQLite). The bug is in how `sessionId` is determined at write time, not in read queries.

## Implementation Checklist

### Backend Fixes (Priority — these cause persistent data corruption)
- [ ] **Bug 1 fix:** In `POST /workspaces/:id/messages` (`workspaces.ts`), fetch `chatSessionId` from D1 alongside `projectId`. Use the D1 `chatSessionId` as the authoritative session ID, overriding the client-provided value. Log a warning when they mismatch.
- [ ] **Bug 2 fix:** In VM agent, ensure `SetSessionID()` is called on warm node workspace reuse even when not going through the task runner path. Consider calling it from the workspace creation API response path.
- [ ] **Bug 3 fix:** Consider making workspace creation and session linking atomic, or ensuring no messages can be sent until `SetSessionID` has been acknowledged.
- [ ] **Bug 4 fix:** Use a transaction or ensure `chatSessionId` is set in the initial INSERT when possible. If not possible, document the window and ensure no concurrent reads depend on it.
- [ ] **Bug 5 fix:** Add a unique index on `workspaces.chatSessionId` (nullable unique — only enforces uniqueness when non-null). Add a D1 migration.
- [ ] Add session-scoped WebSocket filtering to `ProjectData DO`:
  - Accept `sessionId` query param on WS URL
  - Track session subscriptions per WebSocket connection
  - Filter `broadcastEvent()` to only send session-specific events to subscribed sockets
  - Keep project-wide events (session.created, activity.new) broadcasting to all

### Frontend Fixes (Defense in depth — prevent stale display even if backend is correct)
- [ ] Add `key={sessionId}` to `<ProjectMessageView>` in `ProjectChat.tsx` — forces clean unmount/remount on session switch, eliminates all stale closure issues (Bugs 6, 7)
- [ ] Nullify `wsRef.current` immediately in cleanup (before `ws.close(1000)`) in `useChatWebSocket.ts`
- [ ] Add sessionId validation to `onMessageRef` dispatch — compare incoming `msg.sessionId` against current `sessionId` prop before calling `setMessages`
- [ ] Add `AbortController` to the polling `useEffect` in `ProjectMessageView.tsx`
- [ ] Add stale-session guard to `onCatchUp` handler — verify data matches current sessionId before applying

### Documentation
- [ ] Write post-mortem in `docs/notes/2026-03-07-chat-session-leakage-postmortem.md`
- [ ] Update relevant architecture docs if needed

### Tests
- [ ] Integration test: POST `/messages` — verify server overrides client sessionId with D1 chatSessionId
- [ ] Integration test: POST `/messages` — verify mismatched sessionId is logged as warning
- [ ] Unit test: `ProjectMessageView` — verify messages don't leak across session switches (with `key`)
- [ ] Unit test: `useChatWebSocket` — verify session filtering works correctly
- [ ] Integration test: `ProjectData DO` — verify session-scoped broadcasting
- [ ] Regression test: simulate the exact warm-pool reuse scenario with stale reporter sessionId

### Quality Gates
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes

## Acceptance Criteria

1. Messages from Session A never appear in Session B's view — even during rapid session switching, warm node reuse, or direct workspace access
2. The `/messages` API endpoint uses D1 `chatSessionId` as the authoritative session, not the client-provided value
3. Warm node reuse properly resets the VM agent's Reporter sessionId
4. WebSocket broadcasts are filtered server-side by session subscription
5. `chatSessionId` has a unique constraint in the schema
6. All fixes have corresponding tests that would catch regressions
7. Post-mortem document explains the root cause and process improvements
