# Unify Project Chat Message Flow Through DO (Per-Token Streaming)

## Problem

The project chat view currently uses **two parallel message paths** to the browser:
1. **DO WebSocket** — persisted complete messages (VM agent → HTTP batch → DO → browser)
2. **ACP WebSocket** — direct per-token streaming (VM agent → browser)

This dual-path architecture causes bugs:
- ULID regex rejecting workspace IDs in client ACP connection (fixed in PR #270)
- Message history loss when ACP replay has fewer messages than DO history (fixed in PR #270)
- "Agent offline" banner when client can't connect to workspace subdomain
- ACP WebSocket 503 during DNS propagation for newly created workspaces
- Complex state management merging two message sources with different formats

## Proposed Change

Unify the project chat message flow through the DO as the single source of truth, adding per-token streaming support:

1. **VM agent**: Replace HTTP POST batching with WebSocket or reduce batch interval to near-real-time. The per-chunk extraction already exists (`message_extract.go`); only the transport layer needs changing.
2. **DO**: Add `message.chunk` broadcast event type alongside `messages.batch`. Accumulate chunks into complete messages for persistent storage, broadcast chunks to connected clients in real-time.
3. **Client**: Add chunk reassembly in `useChatWebSocket` (append tokens to last message until complete). Remove `useProjectAgentSession` from project chat view entirely.

## What This Eliminates

- `useProjectAgentSession` hook for project chat (still needed for workspace chat)
- `deriveWorkspaceWsHost()` and all client-side workspace WebSocket connection logic for project chat
- "Agent offline" banner in project chat (no direct workspace connection needed)
- Dual-source message rendering logic in `ProjectMessageView.tsx`
- ACP WebSocket 503 race condition on new workspace creation

## Exploration Required

### DO Usage & Billing

- **WebSocket connections**: DOs charge per WebSocket message. Per-token streaming would increase message volume ~50x vs current batched approach. Quantify: typical task generates N tokens → N WebSocket messages vs current ~N/50 batches. What's the cost at scale?
- **DO CPU time**: Each chunk triggers `broadcastEvent()` which iterates all connected WebSocket clients. Profile CPU cost per broadcast. Does this hit DO CPU limits under load?
- **Subrequest limits**: If using HTTP instead of WebSocket for VM→DO, per-token POSTing would hit subrequest limits. WebSocket avoids this but requires persistent connection management.
- **Storage writes**: Current approach writes complete messages to SQLite. Would chunk-based writes increase storage I/O? Could we buffer chunks in memory and write complete messages only?
- **Comparison**: Benchmark current batch approach (2s/50msg batches) vs per-token approach. What's the cost delta per 1000 tasks?

### Latency

- Current ACP direct path: ~5-10ms (VM → browser)
- Proposed DO path: ~50-100ms (VM → API → DO → browser)
- Is 50-100ms perceptible for token streaming UX? Test with real users.

### Architecture Questions

- Should the VM agent open a WebSocket to the DO directly, or should it POST individual messages with a much shorter batch window (e.g., 100ms)?
- Can the DO handle concurrent chunk broadcasts to multiple viewers efficiently?
- Should the workspace chat view also switch to DO-based streaming, or keep the direct ACP path for lowest latency?
- How does this interact with the message outbox (SQLite on VM) and retry logic?

### Current Code Paths

| Component | File | Current Behavior |
|-----------|------|-----------------|
| VM extraction | `packages/vm-agent/internal/acp/message_extract.go` | Per-chunk extraction from ACP notifications |
| VM batching | `packages/vm-agent/internal/messagereport/reporter.go` | 2s/50msg/64KB batches via HTTP POST |
| API receiver | `apps/api/src/routes/workspaces.ts:1601` | Accepts 1-100 complete messages |
| DO persistence | `apps/api/src/durable-objects/project-data.ts:235` | `persistMessageBatch()` stores complete messages |
| DO broadcast | `apps/api/src/durable-objects/project-data.ts:341` | `messages.batch` event with complete messages |
| Client DO WS | `apps/web/src/hooks/useChatWebSocket.ts:143` | Receives `messages.batch` arrays |
| Client ACP WS | `packages/acp-client/src/hooks/useAcpMessages.ts:222` | Per-token streaming via direct ACP |
| Project chat | `apps/web/src/hooks/useProjectAgentSession.ts` | Client ACP connection to workspace |
| Rendering | `apps/web/src/components/chat/ProjectMessageView.tsx:634` | Dual-source message display logic |

## Acceptance Criteria

- [ ] Exploration questions above answered with data/benchmarks
- [ ] Cost analysis comparing current vs proposed approach
- [ ] If feasible: spec written for the architectural change
- [ ] Project chat shows per-token streaming through DO path only
- [ ] `useProjectAgentSession` removed from project chat (kept for workspace chat)
- [ ] No "Agent offline" banner in project chat
- [ ] Message history fully preserved when switching between conversations
