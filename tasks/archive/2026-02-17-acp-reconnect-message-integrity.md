# ACP Reconnect Message Integrity

**Created**: 2026-02-17
**Priority**: High
**Classification**: `cross-component-change`, `business-logic-change`

## Problem

When a browser refreshes or reconnects to an in-progress ACP agent session, the conversation display becomes jumbled, duplicated, or stuck. This manifests as:

1. **Jumbled/garbled text**: Words from different messages interleaved together
2. **Stuck prompting state**: Can't submit new messages; Cancel button does nothing
3. **Duplicate messages**: Same conversation content appearing multiple times after refresh

## Root Cause Analysis

Five interrelated bugs identified from code analysis of the full message flow (browser → WebSocket → VM Agent SessionHost → Claude Code ACP):

### Bug 1: Async Clear Races with Synchronous Replay (HIGH)

`ChatSession.tsx` clears messages via `useEffect` when state transitions to `'replaying'`:

```typescript
useEffect(() => {
  if (state === 'replaying' || state === 'no_session') {
    clearMessages();
  }
}, [state, ...]);
```

But `clearMessages()` is deferred to the next React render cycle. Meanwhile, replay messages arrive synchronously via WebSocket `onmessage` → `processMessage()`, which appends items immediately. Result: replay messages arrive before the clear fires, then the clear wipes them, leaving partial/garbled conversations.

**Fix**: Move clear logic into `processMessage` itself — when a `session_state` message arrives with `replayCount > 0`, synchronously clear items before any replay messages are processed. Remove the `useEffect`-based clear.

### Bug 2: agent_message_chunk Blindly Concatenates (HIGH)

`useAcpMessages.ts` appends every `agent_message_chunk` to the last streaming `AgentMessage`:

```typescript
if (last?.kind === 'agent_message' && last.streaming) {
  return { ...last, text: last.text + text };
}
```

During replay, messages from multiple turns arrive rapidly. React may batch `setItems` calls, so intermediate state transitions (tool_call finalizing a streaming message) never materialize. Chunks from turn N+1 get concatenated onto turn N's agent message.

**Fix**: Finalize all streaming items at replay start. Consider adding a `turnId` or similar marker to prevent cross-turn concatenation.

### Bug 3: Prompt State Lost on Reconnect (HIGH)

When reconnecting during an active prompt:
1. Server sends `session_state` with `status === 'prompting'` and `replayCount > 0`
2. Client enters `'replaying'` state (ignoring the prompting status)
3. After replay, `session_replay_complete` transitions to `'ready'`
4. But the server-side prompt is still blocking on `acpConn.Prompt()`
5. User submits new prompt → deadlocks on `promptMu.Lock()` in HandlePrompt
6. UI appears completely stuck — can't send, can't cancel

**Fix**: Track the server-reported status separately from the replay state. After replay completes, restore the server's actual status (`prompting`) rather than defaulting to `ready`.

### Bug 4: Cancel Has No Effect (MEDIUM)

`session/cancel` is forwarded to the agent's stdin via `ForwardToAgent()`, but `acp-go-sdk`'s `Prompt()` is synchronous/blocking. The cancel message reaches the agent but the Go SDK doesn't process it as an interruption.

**Fix**: Have `HandlePrompt` accept a cancellable context. Store a cancel function on the SessionHost that the cancel message handler can invoke. This cancels the `Prompt()` context, causing it to return with an error.

### Bug 5: Token Refresh Triggers Full Reconnect (MEDIUM)

The JWT token is embedded in the WebSocket URL. When `useTokenRefresh` refreshes the token, `resolvedWsUrl` changes, triggering a full WebSocket disconnect → reconnect → replay cycle, which re-triggers bugs 1-3.

**Fix**: Decouple token from WebSocket URL — either send token refresh messages over the existing WebSocket, or only reconnect when the token actually expires (not on proactive refresh).

## Implementation Plan

### Phase 1: Fix Clear/Replay Race (Bug 1 + Bug 2)

Files:
- `packages/acp-client/src/hooks/useAcpMessages.ts`
- `packages/acp-client/src/hooks/useAcpSession.ts`
- `apps/web/src/components/ChatSession.tsx`

Changes:
- [ ] Add a `prepareForReplay()` method to `useAcpMessages` that synchronously clears items and finalizes any streaming state
- [ ] Call `prepareForReplay()` from `processMessage` when `session_state` with `replayCount > 0` arrives (via a new callback or by passing session_state through the message handler)
- [ ] Alternatively: add a `handleSessionState` callback to `useAcpMessages` that the transport can call synchronously before replay begins
- [ ] Remove the `useEffect`-based `clearMessages()` on `state === 'replaying'` from `ChatSession.tsx`
- [ ] Add unit tests for the replay race scenario

### Phase 2: Fix Prompt State on Reconnect (Bug 3)

Files:
- `packages/acp-client/src/hooks/useAcpSession.ts`

Changes:
- [ ] Store the server-reported status from `session_state` in a ref (e.g., `serverStatusRef`)
- [ ] In `handleSessionReplayComplete`, transition to the server-reported status instead of unconditionally going to `'ready'`
- [ ] If server status was `'prompting'`, enter `'prompting'` state after replay (user sees the agent working, input is disabled)
- [ ] Add unit tests for reconnect-during-prompt scenario

### Phase 3: Implement Cancel Support (Bug 4)

Files:
- `packages/vm-agent/internal/acp/session_host.go`
- `packages/vm-agent/internal/acp/gateway.go`

Changes:
- [ ] Add a `cancelPrompt` channel/context.CancelFunc to SessionHost
- [ ] In `HandlePrompt`, create a child context from `cancelPrompt` and pass to `acpConn.Prompt()`
- [ ] In Gateway `handleMessage`, route `session/cancel` to a new `SessionHost.CancelPrompt()` method
- [ ] When cancelled, broadcast `session_prompt_done` and a JSON-RPC error to viewers
- [ ] Add Go tests for cancel behavior

### Phase 4: Stabilize Token Refresh (Bug 5)

Files:
- `apps/web/src/components/ChatSession.tsx`
- `apps/web/src/hooks/useTokenRefresh.ts`

Changes:
- [ ] Only update `resolvedWsUrl` if the previous WebSocket is disconnected or the token has actually expired
- [ ] Or: separate the token from the URL and send it as an auth message after WebSocket connect
- [ ] Add test coverage for token refresh scenarios

## Testing

- [ ] Unit tests: `useAcpMessages` replay clear race (simulated rapid message delivery)
- [ ] Unit tests: `useAcpSession` prompt state preservation across reconnect
- [ ] Unit tests: Cancel prompt flow (Go)
- [ ] Integration test: Full reconnect scenario with Miniflare (if feasible)
- [ ] Manual Playwright test: Refresh during active prompt on live app

## Acceptance Criteria

- Refreshing during an active conversation shows the correct conversation history without jumbling
- Refreshing during an active prompt shows the prompting state (disabled input, cancel button visible)
- Cancel button during prompting actually cancels the agent's work
- Token refresh does not cause visible reconnection or message duplication
