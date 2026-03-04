# Fix Chat Session Cross-Contamination

## Problem

Messages from one project chat session are appearing in another session's feed. This is a data integrity bug where session isolation is broken at multiple layers.

## Root Cause Analysis

Three independent bugs contribute to cross-contamination:

### Bug 1: Stale polling responses in web UI (HIGH — most likely cause)

**File:** `apps/web/src/components/chat/ProjectMessageView.tsx:456-482`

The polling fallback (`setInterval` every 3s) fetches messages for the current session. When the user switches sessions:

1. An in-flight poll for session A is already executing
2. Cleanup runs (`clearInterval`), but the in-flight `fetch` is **not aborted**
3. When it resolves, it calls `setMessages(data.messages)` — writing session A's messages into the view now displaying session B

**Fix:** Add an `AbortController` to the polling effect. Abort in-flight requests on cleanup. Additionally, validate `data.session.id === sessionId` before applying the response.

### Bug 2: Stale messages in VM agent outbox during warm node reuse (MEDIUM)

**File:** `packages/vm-agent/internal/messagereport/reporter.go`

When a warm node is reused for a new task:

1. `SetSessionID(newId)` updates the in-memory field for new messages
2. Unsent messages in the SQLite outbox still carry the **old** session ID
3. The flush loop reads ALL messages (`ORDER BY id ASC`, no session filter)
4. `SetWorkspaceID(newId)` changes the POST endpoint URL
5. Old messages get POSTed to the **new workspace's endpoint** with the **old session ID**

**Fix:** Clear (or drain) the outbox when `SetSessionID()` is called, before any new messages are enqueued.

### Bug 3: Race between old agent output and session ID swap (MEDIUM)

**File:** `packages/vm-agent/internal/messagereport/reporter.go:164-168`

When the session ID is swapped via `SetSessionID()`, in-flight `SessionUpdate` goroutines from the **previous** agent call `Enqueue()`, which reads the **new** session ID — tagging old agent's messages with the new session.

**Fix:** Flush and clear the outbox in `SetSessionID()` before updating the field. The old agent's goroutines will either have already enqueued (flushed with correct old session) or will be dropped (outbox cleared).

## Implementation Checklist

### Web UI (Bug 1)
- [ ] Add `AbortController` to the polling `useEffect` in `ProjectMessageView.tsx`
- [ ] Pass `signal` to `getChatSession()` calls in the polling interval
- [ ] Verify `getChatSession` (and underlying fetch) accepts/propagates `AbortSignal`
- [ ] Add session ID guard: skip `setMessages` if response session ID doesn't match current prop
- [ ] Add unit test: verify stale poll response doesn't overwrite current session's messages

### VM Agent (Bugs 2 & 3)
- [ ] Add `DrainAndClear()` or `ClearOutbox()` method to `Reporter`
- [ ] Call it from `SetSessionID()` — flush any pending messages with old session, then clear remaining
- [ ] Add unit test: verify outbox is cleared when session ID changes
- [ ] Add unit test: verify messages enqueued after `SetSessionID` use the new session ID
- [ ] Add logging for outbox clear operations

### API Validation Hardening (Defense in depth)
- [ ] In `POST /:id/messages`, validate that the session ID belongs to the workspace's project
- [ ] Add test for session/workspace mismatch rejection

## Acceptance Criteria

- [ ] Switching between sessions in the project chat UI never shows messages from other sessions
- [ ] Warm node reuse does not leak messages from previous tasks into new sessions
- [ ] All existing tests pass
- [ ] New regression tests cover each bug specifically
- [ ] Typecheck and lint pass

## References

- `apps/web/src/components/chat/ProjectMessageView.tsx` — polling fallback
- `apps/web/src/hooks/useChatWebSocket.ts` — WebSocket session filtering
- `packages/vm-agent/internal/messagereport/reporter.go` — outbox + singleton reporter
- `apps/api/src/routes/workspaces.ts:1486` — message persistence endpoint
- `apps/api/src/durable-objects/project-data.ts` — DO broadcast (all sessions to all clients)
