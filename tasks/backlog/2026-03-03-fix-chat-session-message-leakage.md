# Fix Chat Session Message Leakage

## Problem

Messages from one chat session are appearing in another session within the same project. This is a data isolation bug that undermines trust in the chat system.

## Root Cause Analysis

Deep trace identified **4 leakage vectors**, with the primary cause being a frontend polling race condition:

### Vector 1: Polling Race Condition (PRIMARY — HIGH CONFIDENCE)

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
- [ ] Add `key={sessionId}` to `<ProjectMessageView>` in `ProjectChat.tsx` — forces clean unmount/remount on session switch
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
