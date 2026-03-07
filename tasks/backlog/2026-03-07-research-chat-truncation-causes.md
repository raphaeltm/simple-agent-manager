# Research: Chat Messages Appear Truncated While Agent Still Working

## Problem Statement

Project chats sometimes appear to "end" prematurely — the last visible message is a tool call, but opening the workspace directly reveals many more messages (additional tool calls, agent responses) in the underlying ACP session. The chat UI stops updating while the agent is still actively working.

## Root Cause Analysis

There are **multiple independent failure modes** that can cause this symptom. They fall into three categories: (A) the UI stops listening too early, (B) messages fail to reach the persistence layer, and (C) messages are lost in transit.

---

## Category A: UI Stops Listening Too Early

### A1. `session.agent_completed` fires → WebSocket + polling both stop (CRITICAL)

**The most likely cause.** When the task completion callback (`POST /tasks/:id/status/callback` with `executionStep = 'awaiting_followup'`) fires, the API calls `markAgentCompleted()` on the DO session, which broadcasts `session.agent_completed` to all DO WebSocket clients. The web UI then:

1. `deriveSessionState()` returns `'idle'` (because `agentCompletedAt` is set) — `apps/web/src/components/chat/ProjectMessageView.tsx`
2. `useChatWebSocket` disconnects (gated on `session?.status === 'active'`) — `apps/web/src/hooks/useChatWebSocket.ts:263`
3. The 3-second polling fallback stops (same gate: `session.status !== 'active'`) — `ProjectMessageView.tsx:356-357`
4. The ACP WebSocket may also drop if the session state transitions further

**If the agent continues working after signaling `awaiting_followup`** (e.g., it sends the callback between turns but then processes more tool calls), those messages are persisted to the DO but the UI never polls for them.

**Key code paths:**
- Callback handler: `apps/api/src/routes/tasks.ts:727-748`
- DO broadcast: `apps/api/src/durable-objects/project-data.ts:markAgentCompleted()`
- UI gate: `apps/web/src/components/chat/ProjectMessageView.tsx:356` (`session.status !== 'active'`)
- WebSocket gate: `apps/web/src/hooks/useChatWebSocket.ts:263` (`enabled: session?.status === 'active'`)

### A2. ACP WebSocket viewer buffer full → messages silently dropped for that viewer

When the agent is streaming fast (e.g., large code output), the per-viewer send channel (256 slots, `DefaultViewerSendBuffer`) can fill up. Messages are silently dropped for that specific viewer with only a warning log.

**Key code path:** `packages/vm-agent/internal/acp/session_host.go:sendToViewer()` (line ~1475)

### A3. ACP WebSocket reconnection fails after 10 retries → permanently disconnected

If the ACP WebSocket drops and fails to reconnect within 10 attempts (exponential backoff up to 30s), the connection state becomes `'disconnected'` with no further automatic reconnection. The DO WebSocket may still be working, but ACP streaming data stops.

**Key code path:** `apps/web/src/hooks/useChatWebSocket.ts` reconnection logic

### A4. Workspace marked `stopped` → ACP connection terminates

If the workspace is stopped (idle cleanup alarm, explicit stop, or stuck-task cron), `deriveSessionState()` returns `'terminated'`, both WebSockets disconnect, and the UI shows "This session has ended."

**Key code path:** `apps/api/src/durable-objects/project-data.ts:alarm()` (line ~644) → `stopSessionInternal()`

---

## Category B: Messages Fail to Reach Persistence Layer

### B1. MessageReporter outbox cleared on warm node reuse

When a warm node is reused for a new task, `SetSessionID()` clears all unsent messages from the previous session's outbox. If the flush timer hasn't fired yet, those messages are permanently lost.

**Key code path:** `packages/vm-agent/internal/messagereport/reporter.go:SetSessionID()`

### B2. MessageReporter batch rejected with permanent HTTP error

HTTP 400, 401, or 403 responses cause the batch to be deleted from the outbox permanently. A misconfigured callback token would cause all messages to be silently discarded.

**Key code path:** `packages/vm-agent/internal/messagereport/reporter.go:sendBatch()`

### B3. MAX_MESSAGES_PER_SESSION limit hit (10000 messages)

Once a session hits 10,000 messages in the DO, further messages in a batch are silently skipped. The reporter gets a 200 response but with `persisted < batch.length`.

**Key code path:** `apps/api/src/durable-objects/project-data.ts:persistMessageBatch()` (line ~246)

### B4. MessageReporter nil (workspace not linked to project)

If the workspace lacks `ProjectID` or `SessionID` in its config, `MessageReporter` is nil. All messages only exist in the in-memory ACP replay buffer (5000 message limit) and are never persisted to the DO.

**Key code path:** `packages/vm-agent/internal/acp/session_host.go:SessionUpdate()` (line ~1880)

### B5. Scanner buffer overflow (>10MB single line)

If the agent outputs a single line >10MB, the `bufio.Scanner` in `orderedPipe` stops scanning entirely. All subsequent messages from the agent process are lost.

**Key code path:** `packages/vm-agent/internal/acp/ordered_reader.go:96-98`

---

## Category C: Messages Lost in Transit / Timing Issues

### C1. Race: completion callback fires before outbox flush

The agent sends its last tokens, they enter the outbox, then the agent calls the `awaiting_followup` callback. The control plane schedules idle cleanup. If the outbox flush interval hasn't fired, the last batch of messages may arrive after the session transitions. The messages ARE still persisted (the DO doesn't reject messages for stopped sessions), but the UI may have already disconnected.

**Key code paths:**
- Reporter flush: `packages/vm-agent/internal/messagereport/reporter.go:flushLoop()`
- Callback: `apps/api/src/routes/tasks.ts:727`
- DO alarm: `apps/api/src/durable-objects/project-data.ts:alarm()`

### C2. ACP message types not persisted (ThoughtChunk, PlanUpdate)

Only `UserMessageChunk`, `AgentMessageChunk`, `ToolCall`, and `ToolCallUpdate` are extracted for persistence. Other ACP notification types are broadcast to live WebSocket viewers but never stored. On page reload, those items disappear.

**Key code path:** `packages/vm-agent/internal/acp/message_extract.go:ExtractMessages()`

### C3. DO broadcast with no connected WebSocket clients

If no browser tabs have a DO WebSocket connection when `broadcastEvent` fires, the live event is lost. The message is still in SQLite and will appear on next poll/load, but there's no push notification.

**Key code path:** `apps/api/src/durable-objects/project-data.ts:broadcastEvent()`

### C4. Merge filter discards ACP items older than latest DO message

The message display logic merges DO (persistent) and ACP (streaming) messages. ACP items with timestamps older than the latest DO message are filtered out. Clock skew between VM and control plane could cause valid ACP items to be discarded.

**Key code path:** `apps/web/src/components/chat/ProjectMessageView.tsx:658-710`

---

## Most Likely Explanation for the Reported Symptom

The user reports: "chat appears ended with a tool call, but opening the workspace shows more messages."

**Primary suspect: A1** — The task completion callback fires (agent signals `awaiting_followup`) while the agent is still processing. The DO WebSocket and polling stop, so the UI freezes on whatever was last displayed (often a tool call mid-stream). The agent keeps running and messages keep being persisted to the DO, but the UI never fetches them.

**Contributing factor: C1** — Even if the agent truly finished, the last batch of messages may not have been flushed from the outbox when the UI stopped polling. The messages arrive in the DO after the UI disconnected.

**Secondary suspect: A2** — During fast streaming, the viewer buffer fills and messages are dropped. The user sees a gap (tool call without its result) that makes the chat look frozen.

---

## Acceptance Criteria

- [ ] Identify all code paths where the chat UI could stop updating prematurely
- [ ] Identify all code paths where messages could be lost between VM agent and DO
- [ ] Identify all code paths where messages could be lost between DO and browser
- [ ] Rank causes by likelihood for the reported symptom
- [ ] Document findings in a task file with specific code path citations

---

## References

- `apps/web/src/components/chat/ProjectMessageView.tsx` — message display, polling, session state derivation
- `apps/web/src/hooks/useChatWebSocket.ts` — DO WebSocket connection management
- `apps/web/src/hooks/useProjectAgentSession.ts` — ACP WebSocket connection
- `apps/api/src/durable-objects/project-data.ts` — session lifecycle, message persistence, idle cleanup
- `apps/api/src/routes/tasks.ts` — task status callback, completion handling
- `packages/vm-agent/internal/acp/session_host.go` — agent process, viewer management, message broadcast
- `packages/vm-agent/internal/acp/ordered_reader.go` — stdout serialization pipe
- `packages/vm-agent/internal/acp/message_extract.go` — ACP notification filtering
- `packages/vm-agent/internal/messagereport/reporter.go` — outbox-based message persistence
