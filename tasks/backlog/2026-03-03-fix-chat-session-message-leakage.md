# Fix Chat Session Message Leakage

## Problem

Messages from one chat session are appearing in another session within the same project. This is a data isolation bug that undermines trust in the chat system.

### User-Reported Scenario (2026-03-07)

User sent a follow-up message in a project chat session. The message triggered agent activity in the correct workspace. However, when switching to a different chat session, the same follow-up message appeared there too. Opening the other chat's workspace confirmed the follow-up did NOT actually reach that workspace — but the message persisted in the project chat UI for the wrong session even after a full page refresh. This confirms the bug is not just a transient UI glitch — stale/misrouted data is being persisted or cached.

## Root Cause Analysis

Deep trace identified **5 leakage vectors**, with the primary cause being an `onMessageRef` race condition during session switches:

### Vector 0: `onMessageRef` Race on Session Switch (PRIMARY — HIGHEST CONFIDENCE)

**Location:** `apps/web/src/hooks/useChatWebSocket.ts:57-65, 121-122`

The `useChatWebSocket` hook uses a ref pattern (`onMessageRef.current = onMessage`) that is updated on every React render. When the user switches from Session A to Session B:

1. React re-renders `ProjectMessageView` with Session B's props
2. `onMessageRef.current` is updated to point to Session B's `setMessages` setter
3. The old WebSocket for Session A is closed asynchronously via `ws.close(1000)`
4. Between the `ws.close(1000)` call and the `ws.onclose` event firing, `wsRef.current` still points to the old socket
5. A server-pushed `message.new` event for Session A (e.g., the server-confirmed follow-up message) arrives in this window
6. It passes the `wsRef.current !== ws` guard (still points to old socket)
7. It passes the `sessionId` filter (old socket's closure has Session A's `sessionId`, matching the payload)
8. It calls `onMessageRef.current(newMsg)` — which now points to **Session B's** `setMessages` setter
9. Session A's message is appended to Session B's `messages` state

This is especially acute for follow-up messages because: the user sends a message in Session A, the DO persists it and broadcasts `message.new` back, and if the user has already navigated to Session B, the server-confirmed message arrives via the old WS and writes into Session B's state via the updated ref.

**Why it persists after refresh:** The `onCatchUp` callback (called on `onopen`) replaces all messages with `getChatSession()` data. If the `catchUpMessages()` function fires with a stale `sessionId` closure (old WS's `onopen` racing with new WS's setup), it fetches Session A's messages and stores them as Session B's via `onCatchUpRef.current`.

### Vector 1: Polling Race Condition (HIGH CONFIDENCE)

**Location:** `apps/web/src/components/chat/ProjectMessageView.tsx:447-473`

The polling fallback (`setInterval` every 3s) fetches session data via `getChatSession(projectId, sessionId)`. On session switch:

1. User switches from Session A → Session B
2. `useEffect` cleanup calls `clearInterval(pollInterval)` — stops future polls
3. BUT an in-flight HTTP request for Session A is NOT aborted
4. Session B's `loadSession()` fires and sets correct messages
5. Session A's in-flight poll resolves AFTER and calls `setMessages(data.messages)` — overwrites Session B's messages with Session A's data

The `<ProjectMessageView>` component does NOT use `key={sessionId}`, so React reuses the same instance. Stale closures from the old session's effects can overwrite the new session's state.

### Vector 2: WebSocket Broadcast Without Session Filtering (MEDIUM)

**Location:** `apps/api/src/durable-objects/project-data.ts:970-980`

`broadcastEvent()` sends to ALL WebSocket connections for the entire project:
```typescript
private broadcastEvent(type: string, payload: Record<string, unknown>): void {
  const sockets = this.ctx.getWebSockets(); // ALL project sockets
  // ...broadcasts to every socket
}
```

Client-side filtering exists (`if (p.sessionId !== sessionId) return` at `useChatWebSocket.ts:130`) but is a weak defense — relies on JavaScript closures being current during React re-renders.

### Vector 3: Missing Session Validation in Message Ingestion (MEDIUM)

**Location:** `apps/api/src/routes/workspaces.ts:1493-1595`

POST `/workspaces/:id/messages` validates that messages have a sessionId and belong to the same batch, but does NOT verify:
- The sessionId matches the workspace's `chatSessionId`
- The sessionId belongs to the workspace's linked project

A buggy VM agent could route messages to any session within the project.

### Vector 4: catchUpMessages Ref Staleness (LOW)

**Location:** `useChatWebSocket.ts:199-206`

`onCatchUpRef.current` always points to the latest handler. If an old catch-up fetch completes after session switch, it would call the new handler with old data. Mitigated by WS close on session switch, but not impossible.

## Research Findings

### Key Files
- `apps/web/src/components/chat/ProjectMessageView.tsx` — Session display, polling, message state
- `apps/web/src/hooks/useChatWebSocket.ts` — WebSocket hook with session filtering
- `apps/web/src/pages/ProjectChat.tsx:446` — Renders `<ProjectMessageView>` WITHOUT `key={sessionId}`
- `apps/api/src/durable-objects/project-data.ts` — ProjectData DO, broadcastEvent, message persistence
- `apps/api/src/routes/chat.ts:88-101` — WebSocket upgrade route (project-scoped, no sessionId)
- `apps/api/src/routes/workspaces.ts:1493-1595` — Message ingestion from VM agent
- `apps/api/src/services/project-data.ts` — Service layer forwarding to DO

### Prior Art / References
- Cloudflare Hibernatable WebSockets API supports `acceptWebSocket(ws, tags)` and `getWebSockets(tag)` for server-side filtering
- AdminLogs DO (`apps/api/src/durable-objects/admin-logs.ts`) uses per-client state tracking via `setClientState`/`getClientState` pattern
- React `key` prop pattern for resetting component state: forces unmount/remount, cleanly eliminates stale closures
- AbortController pattern for cancelling in-flight fetch requests in useEffect cleanup

### Backend Data Isolation
SQL queries are correctly scoped — all message queries use `WHERE session_id = ?`. Cross-project isolation is enforced by the DO model (each project has its own DO instance with independent SQLite). The bug is NOT in data storage; it's in data delivery/display.

## Implementation Checklist

### Frontend Fixes
- [ ] Add `key={sessionId}` to `<ProjectMessageView>` in `ProjectChat.tsx` — forces clean unmount/remount on session switch, cleanly eliminates ALL stale closure issues (Vectors 0, 1, 4)
- [ ] Nullify `wsRef.current` immediately in cleanup (before `ws.close(1000)`) in `useChatWebSocket.ts` — prevents the `wsRef.current !== ws` guard from passing for old sockets during the close window
- [ ] Add sessionId validation to `onMessageRef` dispatch — compare incoming `msg.sessionId` against current `sessionId` prop before calling `setMessages`
- [ ] Add `AbortController` to the polling `useEffect` in `ProjectMessageView.tsx` — abort in-flight requests on cleanup
- [ ] Add stale-session guard to `onCatchUp` handler — verify data matches current sessionId before applying

### Backend Fixes
- [ ] Add session-scoped WebSocket filtering to `ProjectData DO`:
  - Accept `sessionId` query param on WS URL
  - Track session subscriptions per WebSocket connection
  - Filter `broadcastEvent()` to only send session-specific events to subscribed sockets
  - Keep project-wide events (session.created, activity.new) broadcasting to all
- [ ] Add sessionId validation to POST `/workspaces/:id/messages`:
  - Query workspace's `chatSessionId` from D1
  - Reject messages where `body.sessionId !== workspace.chatSessionId`

### Documentation
- [ ] Write investigation document in `docs/notes/2026-03-03-chat-session-leakage-postmortem.md`
- [ ] Update relevant architecture docs if needed

### Tests
- [ ] Unit test: `ProjectMessageView` — verify messages don't leak across session switches
- [ ] Unit test: `useChatWebSocket` — verify session filtering works correctly
- [ ] Integration test: `ProjectData DO` — verify session-scoped broadcasting
- [ ] Integration test: POST `/messages` — verify sessionId validation rejects mismatched sessions
- [ ] Regression test: simulate the exact race condition (poll completing after session switch)

### Quality Gates
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes

## Acceptance Criteria

1. Messages from Session A never appear in Session B's view, even during rapid session switching
2. Backend rejects messages with sessionId mismatched from workspace's chatSessionId
3. WebSocket broadcasts are filtered server-side by session subscription
4. All fixes have corresponding tests that would catch regressions
5. Post-mortem document explains the root cause and process improvements
