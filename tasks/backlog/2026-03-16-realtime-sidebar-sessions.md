# Realtime Sidebar Session Updates

## Problem

The project chat sidebar session list does not update in realtime. It only refreshes on:
- Initial page load
- Task submission (explicit `loadSessions()` call)
- During active provisioning (3-second polling via `ACTIVE_SESSION_POLL_MS`)
- Task completion/failure

When another tab or user creates a session, stops a session, or when agent activity happens, the sidebar is stale until the next manual refresh.

## Research Findings

### Current Architecture
- **Chat messages** within a session ARE realtime via `useChatWebSocket` hook (session-scoped WebSocket)
- **Sidebar session list** uses REST polling only during provisioning, otherwise static after load
- **Backend WebSocket infrastructure** already supports project-wide broadcasting

### Key Backend Behavior (project-data.ts)
- `broadcastEvent()` sends to session-tagged sockets AND untagged sockets (project-wide listeners)
- `session.created` — already broadcast project-wide (no sessionId param, line 151)
- `session.stopped` — broadcast with sessionId, but untagged sockets still receive it (line 192)
- `session.updated` — broadcast with sessionId, untagged sockets receive it (line 432)
- `session.agent_completed` — broadcast with sessionId, untagged sockets receive it (line 731)
- `message.new` — broadcast with sessionId, untagged sockets receive it (line 260)

### WebSocket Connection
- Endpoint: `/api/projects/:projectId/sessions/ws`
- When `sessionId` query param is omitted, socket gets NO `session:` tag
- Untagged sockets receive ALL events (both project-wide and session-scoped)
- No backend changes needed — just need a frontend hook

### Key Files
- `apps/web/src/pages/ProjectChat.tsx` — sidebar + session list state
- `apps/web/src/hooks/useChatWebSocket.ts` — existing per-session WebSocket hook (pattern to follow)
- `apps/api/src/durable-objects/project-data.ts` — backend broadcast logic
- `apps/api/src/routes/chat.ts` — WebSocket upgrade endpoint

## Implementation Checklist

- [ ] Create `useProjectWebSocket` hook in `apps/web/src/hooks/useProjectWebSocket.ts`
  - Opens a WebSocket without `sessionId` query param (project-wide listener)
  - Listens for session lifecycle events: `session.created`, `session.stopped`, `session.updated`, `session.agent_completed`
  - Calls a provided `onSessionChange` callback when any lifecycle event arrives
  - Includes reconnection with exponential backoff (follow `useChatWebSocket` pattern)
  - Includes ping keep-alive
  - Debounces rapid successive events to avoid excessive API calls
- [ ] Wire `useProjectWebSocket` into `ProjectChat.tsx`
  - Call `loadSessions()` when session lifecycle events arrive
  - Remove or reduce the existing provisioning polling (project-wide WS covers it)
- [ ] Add tests for the new hook
- [ ] Verify no duplicate WebSocket connections (project-wide WS is separate from per-session WS)

## Acceptance Criteria

- [ ] When a new session is created (from another tab or by the task runner), it appears in the sidebar without manual refresh
- [ ] When a session stops, its status updates in the sidebar in realtime
- [ ] When agent completes on a session, the sidebar reflects the idle state
- [ ] Existing per-session chat message streaming continues to work unchanged
- [ ] WebSocket reconnects gracefully after disconnection
- [ ] No excessive API calls — events are debounced

## References

- `apps/web/src/hooks/useChatWebSocket.ts` — pattern for WebSocket hooks
- `apps/api/src/durable-objects/project-data.ts:broadcastEvent()` — backend broadcasting
