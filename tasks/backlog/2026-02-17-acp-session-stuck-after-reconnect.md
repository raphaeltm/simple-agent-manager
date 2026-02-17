# ACP Session Stuck After Reconnect

**Created**: 2026-02-17
**Status**: Backlog
**Priority**: High
**Estimated Effort**: Medium

## Context

Users report that if they leave a workspace for a while and come back, the agent session can become stuck: they can see the chat history but cannot send new commands or cancel. The input field is disabled and nothing works.

## Root Cause Analysis

Investigation identified **two primary root causes** and **two contributing race conditions**.

### R1: `HandlePrompt` Has No Timeout (CRITICAL)

**File**: `packages/vm-agent/internal/acp/session_host.go:396-432`

`HandlePrompt` acquires `promptMu` and calls `acpConn.Prompt()` with a context derived from `context.Background()` (no timeout). If the ACP SDK `Prompt()` call hangs (agent subprocess unresponsive, stdin/stdout pipe stall, Claude API hang), the mutex is held **forever**.

When the user returns:
1. They reconnect successfully and see chat history via replay
2. `session_state` reports `status: "prompting"` — browser disables input, shows Cancel
3. User clicks Cancel — `CancelPrompt()` calls `promptCancel()` which cancels the context
4. **But**: if `acpConn.Prompt()` doesn't honor context cancellation (common in pipe I/O blocking), the call never returns
5. `promptMu` stays locked forever — session permanently stuck in `prompting`

**Why it correlates with "being away"**: Long prompts (complex code generation) take minutes. If the user leaves during one and the underlying call hangs, they return to an unrecoverable state.

### R2: ChatSession Does Not Refresh Tokens (HIGH)

**File**: `apps/web/src/components/ChatSession.tsx:110-145`

The `ChatSession` component fetches a terminal token **once** on mount and bakes it into `resolvedWsUrl`. Unlike the terminal component which uses `useTokenRefresh` (`apps/web/src/hooks/useTokenRefresh.ts`), the chat session never refreshes its token.

The token expires in 1 hour (`apps/api/src/services/jwt.ts:27`).

When the user returns after 1+ hour:
1. WebSocket has dropped (browser backgrounded the tab)
2. `useAcpSession` tries to reconnect using the **same expired token** in the stale URL
3. VM Agent JWT validation rejects it — WebSocket upgrade fails
4. Reconnection retries all fail (same stale URL) until the 30-second timeout
5. State goes to `error` / "Reconnection timed out"
6. The "Reconnect" button calls `connect(wsUrl)` with the same stale URL — still fails
7. The visibility change handler (`useAcpSession.ts:428-460`) also uses the same stale `wsUrl`

**Result**: User sees chat history (local React state) but cannot interact. Reconnect button is broken.

### R3: Replay Race Condition — `session_prompt_done` Overwritten (MEDIUM)

**Files**:
- `packages/vm-agent/internal/acp/session_host.go:155-207` (AttachViewer)
- `packages/acp-client/src/hooks/useAcpSession.ts:256-271` (handleSessionReplayComplete)

When a viewer attaches, the server:
1. Reads `currentStatus` (e.g., `prompting`) — line 178
2. Registers the viewer — line 190
3. Sends `session_state` with status `prompting` — line 199
4. Replays buffered messages (which include `session_prompting` AND `session_prompt_done` if the prompt completed between status read and viewer registration)
5. Sends `session_replay_complete`

On the browser side, during replay:
- `session_prompt_done` in the replay buffer fires `handleSessionPrompting(false)`, setting state to `ready`
- Then `handleSessionReplayComplete` fires and **overwrites** state back to `prompting` based on `serverStatusRef.current` (set from the initial `session_state`)

**Result**: Browser is stuck in `prompting` while the server is actually `ready`. Input disabled, Cancel does nothing (no prompt in flight).

### R4: Viewer Send Buffer Overflow Drops Control Messages (MEDIUM)

**File**: `packages/vm-agent/internal/acp/session_host.go:982-989`

`sendToViewer` uses a non-blocking channel send with a `default` case that **silently drops** messages when the 256-deep buffer is full. During replay of large conversation histories (up to 5000 messages), the channel can fill before `viewerWritePump` drains it.

If `session_prompt_done` is among the dropped messages, the browser stays in `prompting` forever.

## Proposed Fixes

### Fix R1: Add prompt timeout + force-kill escape hatch

- [ ] Add configurable `ACP_PROMPT_TIMEOUT` env var (e.g., default 10 minutes)
- [ ] Use `context.WithTimeout` instead of `context.WithCancel` in `HandlePrompt`
- [ ] If `CancelPrompt` doesn't unblock within a grace period, force-kill the agent subprocess
- [ ] Broadcast error to viewers on timeout so browser transitions to `error` state
- [ ] Consider a `session/stop` control message to let users force-stop stuck sessions from UI

### Fix R2: Use `useTokenRefresh` in ChatSession

- [ ] Refactor `ChatSession` to use the existing `useTokenRefresh` hook (same as terminal)
- [ ] On reconnection (visibility change, reconnect button), fetch a fresh token before `connect()`
- [ ] Pass the refreshed token URL into `useAcpSession` so reconnect attempts use valid tokens

### Fix R3: Use server-authoritative post-replay status

- [ ] After replay completes, have the server send a **fresh** `session_state` that reflects the current status at that exact moment (not the one captured before replay)
- [ ] Or: on the browser side, track `session_prompt_done` control messages seen during replay and use them to override `serverStatusRef.current` before `handleSessionReplayComplete` runs

### Fix R4: Prioritize control messages in send buffer

- [ ] Use a separate high-priority channel for control messages (`session_prompting`, `session_prompt_done`, `session_state`)
- [ ] Or: increase viewer send buffer size for replay (temporarily or permanently)
- [ ] Or: filter control messages out of the replay buffer and send them as a separate post-replay summary

## Affected Files

| File | What to Change |
|------|---------------|
| `packages/vm-agent/internal/acp/session_host.go` | R1: prompt timeout, R3: post-replay state, R4: buffer priority |
| `packages/vm-agent/internal/acp/gateway.go` | R1: propagate timeout config |
| `packages/vm-agent/internal/config/config.go` | R1: `ACP_PROMPT_TIMEOUT` env var |
| `apps/web/src/components/ChatSession.tsx` | R2: use `useTokenRefresh` |
| `packages/acp-client/src/hooks/useAcpSession.ts` | R2: accept dynamic URL, R3: replay state logic |
| `CLAUDE.md` / `AGENTS.md` | R1: document `ACP_PROMPT_TIMEOUT` env var |

## Testing Strategy

- Unit test: prompt timeout triggers status transition to error
- Unit test: `CancelPrompt` with force-kill after grace period
- Unit test: token refresh on reconnection
- Integration test: replay with `session_prompt_done` in buffer produces correct post-replay state
- Manual test: leave workspace idle for >1 hour, return, verify reconnection works
