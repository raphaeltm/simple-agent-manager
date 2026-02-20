# Fix: Chat History Wiped on Reconnect (Post-Replay session_state Double-Clear)

**Created**: 2026-02-20
**Priority**: Critical
**Classification**: `cross-component-change`, `business-logic-change`

## Problem

When a user leaves a workspace (navigates away, closes tab, etc.) and comes back, chat sessions display **no messages** — the conversation history is empty. Previously, reconnecting to a running agent session would replay all buffered messages and show the full conversation.

## Root Cause

The bug was introduced in commit `f75b4c3` ("fix: harden reconnect for ACP chat and terminal sessions", PR #114, merged 2026-02-18). The fix for R3 (replay race condition) added a **post-replay authoritative `session_state` snapshot** in `AttachViewer()` that inadvertently triggers a second replay cycle, wiping all just-replayed messages.

### Detailed Trace

In `session_host.go`, `AttachViewer()` (line ~183) sends this sequence to a newly connected viewer:

1. `session_state` with `replayCount = len(messageBuf)` — triggers replay preparation
2. All buffered messages (the actual replay content)
3. `session_replay_complete` — signals end of replay
4. **A second `session_state`** with `replayCount = len(messageBuf)` — post-replay snapshot (PROBLEM)

Message #4 has the **same non-zero `replayCount`** as message #1 because the buffer hasn't changed between steps 1 and 4.

On the browser side in `useAcpSession.ts`, `handleSessionState()` unconditionally enters replay mode whenever it receives `session_state` with `status === 'ready'` and `replayCount > 0`:

```typescript
if (status === 'ready' || status === 'prompting') {
  if (msg.replayCount > 0) {
    onPrepareForReplayRef.current?.();  // <-- CLEARS ALL ITEMS
    setState('replaying');
    setReplaying(true);
  }
}
```

There is **no guard** preventing re-entry into replay mode from the `ready` state. So the sequence is:

1. Pre-replay `session_state` (replayCount > 0) → `prepareForReplay()` clears items → state = `replaying`
2. Replay messages arrive → items accumulate (conversation renders correctly)
3. `session_replay_complete` → state = `ready`
4. Post-replay `session_state` (replayCount **still > 0**) → `prepareForReplay()` **clears ALL items again** → state = `replaying`
5. No more messages or `replay_complete` ever arrives → stuck in `replaying` with empty items

**Result**: User sees an empty chat session, permanently stuck in the replaying state.

### Secondary Issue: Viewer Send Buffer Overflow (Partial Message Loss)

`replayToViewer()` sends buffered messages via `sendToViewer()`, which uses a non-blocking channel send. The viewer's send channel has a default capacity of 256 (`ACP_VIEWER_SEND_BUFFER`). If the ring buffer has more than ~256 messages (common for any non-trivial conversation — a single agent turn can generate 100+ streaming chunks), the replay loop fills the channel faster than the `viewerWritePump` goroutine can drain it, and **excess messages are silently dropped**.

This causes partial message loss during replay even without the double-clear bug. For long conversations, users may see only fragments of their history.

## Fix Plan

### Fix 1: Server — Send replayCount=0 in post-replay snapshot (PRIMARY)

**File**: `packages/vm-agent/internal/acp/session_host.go`

The post-replay `session_state` snapshot's purpose is to convey an **authoritative status** (in case it changed during replay), NOT to trigger another replay. It should always send `replayCount: 0`.

```go
// In AttachViewer(), change the post-replay snapshot to not include replayCount:
func (h *SessionHost) marshalSessionStateSnapshot(status SessionHostStatus, agentType, errMsg string) []byte {
    // Same as marshalSessionState but with replayCount forced to 0
}
```

Implementation approach:
- Add a `replayCount int` parameter to `marshalSessionState` (or an overloaded helper)
- Pass `0` for the post-replay snapshot in `AttachViewer()`
- Retain the current behavior (reading `len(messageBuf)`) for the pre-replay snapshot

### Fix 2: Browser — Guard against re-entering replay from ready state (DEFENSE-IN-DEPTH)

**File**: `packages/acp-client/src/hooks/useAcpSession.ts`

Add a ref-based guard in `handleSessionState` to prevent entering `replaying` if a replay has just been completed. This prevents the double-clear even if the server sends a `session_state` with stale `replayCount > 0`.

Implementation approach:
- Add a `replayCompletedRef` that is set to `true` in `handleSessionReplayComplete`
- In `handleSessionState`, skip `prepareForReplay()` and replay-entry if `replayCompletedRef.current` is true
- Clear the ref when the WebSocket reconnects (new connection = legitimate replay)

### Fix 3: Server — Prevent replay message drops for large buffers (SECONDARY)

**File**: `packages/vm-agent/internal/acp/session_host.go`

Change `replayToViewer()` to use a blocking (or semi-blocking) send with a timeout, rather than the non-blocking `sendToViewer()` that silently drops messages when the 256-slot channel is full.

Implementation approach:
- Use a dedicated `sendToViewerBlocking()` for replay that blocks with a timeout (e.g., 5 seconds per message)
- If the timeout fires, log a warning and skip the remaining messages (viewer can reconnect)
- This ensures the `viewerWritePump` goroutine has time to drain the channel between bursts

## Testing Strategy

### Unit Tests

- [x] **Go**: `session_host_test.go` — verify `AttachViewer` sends post-replay `session_state` with `replayCount: 0`
- [x] **Go**: `session_host_test.go` — verify pre-replay `session_state` has correct non-zero `replayCount`
- [x] **Go**: `session_host_test.go` — verify `replayToViewer` does not drop messages for buffers up to `ViewerSendBuffer` size
- [x] **TS**: `useAcpSession.test.ts` — verify post-replay `session_state` with `replayCount > 0` does NOT trigger `prepareForReplay`
- [x] **TS**: `useAcpSession.test.ts` — verify reconnection after a completed replay correctly enters replay mode (guard is reset)

### Integration Tests

- [ ] Full reconnect cycle: attach viewer → receive replay → disconnect → reattach → verify replay shows same messages (**deferred** — see `tasks/backlog/2026-02-20-acp-reconnect-replay-integration-test.md`)

## Affected Files

| File | Change |
|------|--------|
| `packages/vm-agent/internal/acp/session_host.go` | Fix 1 (replayCount=0 in post-replay snapshot), Fix 3 (blocking replay send) |
| `packages/vm-agent/internal/acp/session_host_test.go` | Tests for Fix 1 and Fix 3 |
| `packages/acp-client/src/hooks/useAcpSession.ts` | Fix 2 (replay re-entry guard) |
| `packages/acp-client/src/hooks/useAcpSession.test.ts` | Tests for Fix 2 |

## Prior Art and Context

- **Predecessor task**: `tasks/archive/2026-02-17-acp-reconnect-message-integrity.md` — fixed the original reconnect bugs (async clear race, prompt state, cancel support, token refresh)
- **Related backlog task**: `tasks/backlog/2026-02-17-acp-session-stuck-after-reconnect.md` — the R3 fix in this task (post-replay authoritative state) is what introduced the current bug
- **Commit that introduced the bug**: `f75b4c3` ("fix: harden reconnect for ACP chat and terminal sessions")
- **Ring buffer pattern**: Similar to terminal multiplexer scrollback buffers (tmux, screen) where replay is bounded and late-join viewers get a snapshot. The key lesson from prior art: replay frames should have explicit "begin replay" / "end replay" markers, and the "end replay" state update should never be confused with a "begin replay" signal. The server-side fix (replayCount=0) follows this principle.

## Acceptance Criteria

- [x] Leaving a workspace and returning displays the full chat history for all sessions
- [x] The post-replay session_state correctly conveys status without triggering a new replay cycle
- [x] Long conversations (500+ messages) are replayed without silent message drops
- [x] Existing reconnect-during-prompt behavior is preserved (stays in prompting state)
- [x] All unit tests pass
- [x] CI is green

## Resolution

Completed in PR #124 (merged 2026-02-20). All three fixes implemented with unit tests. Integration test deferred to separate backlog task.
