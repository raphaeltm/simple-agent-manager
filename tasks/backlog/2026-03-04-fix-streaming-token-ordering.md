# Fix Streaming Token Ordering (Wacky Display Order)

**Created**: 2026-03-04
**Priority**: Critical
**Classification**: `cross-component-change`, `business-logic-change`

## Problem

Chat messages display tokens in scrambled order during real-time streaming. Words within a single agent response appear rearranged (e.g., "finger seconds Usesprint-based de" instead of "fingerprint-based dedup"). This occurs in both workspace chat (ACP path) and project chat (WebSocket + polling path).

The DB-level ordering fix (sequence column, migration 007) was already implemented for persisted messages, but the **real-time streaming path** still delivers chunks out of order.

## Root Cause

The ACP Go SDK (`github.com/coder/acp-go-sdk`) dispatches inbound `session/update` notifications via `go c.handleInbound(&msg)` — each notification spawns a new goroutine. While the SDK reads chunks sequentially from stdout, the goroutines race for execution. When chunk B's goroutine runs before chunk A's goroutine, `sessionHostClient.SessionUpdate()` is called out of order, and `broadcastMessage()` sends chunks to viewers in the wrong sequence.

### Affected Code Paths

1. **ACP SDK** (`connection.go:97`): `go c.handleInbound(&msg)` — concurrent dispatch
2. **SessionHost** (`session_host.go:1729`): `SessionUpdate()` → `broadcastMessage()` — no serialization
3. **SessionHost** (`session_host.go:1261`): `broadcastMessageWithPriority()` → fan-out to viewers
4. **Client** (`useAcpMessages.ts:214`): `agent_message_chunk` handler — appends text in arrival order, no reorder correction

## Implementation Plan

### Step 1: Serialize SessionUpdate calls via an ordered channel
- Add an unbuffered or small-buffered channel to `sessionHostClient` that serializes notification processing
- `SessionUpdate()` sends to the channel (preserving goroutine call order via channel FIFO)
- A dedicated goroutine drains the channel and calls `broadcastMessage()` sequentially
- This restores the ordering guarantee lost by the SDK's concurrent dispatch

### Step 2: Add tests
- Go test: Verify that concurrent `SessionUpdate` calls preserve ordering
- Go test: Verify channel-based serialization under high throughput

### Step 3: Build and verify
- `pnpm build` passes
- `pnpm test` passes
- Go tests pass
- Deploy to staging and verify token ordering in live chat

## Acceptance Criteria

- [ ] Streaming tokens appear in correct sequential order during real-time chat
- [ ] `SessionUpdate` calls are serialized regardless of goroutine scheduling
- [ ] No regression in streaming throughput or latency
- [ ] All existing tests pass
- [ ] New Go tests cover the ordering guarantee
- [ ] Verified on staging with a complex multi-tool agent response

## References

- `packages/vm-agent/internal/acp/session_host.go:1729` — SessionUpdate
- `packages/vm-agent/internal/acp/session_host.go:1238` — appendMessage
- `packages/vm-agent/internal/acp/session_host.go:1261` — broadcastMessageWithPriority
- `packages/acp-client/src/hooks/useAcpMessages.ts:214` — agent_message_chunk handler
- `tasks/archive/2026-03-03-fix-chat-message-ordering.md` — DB-level fix (already implemented)
