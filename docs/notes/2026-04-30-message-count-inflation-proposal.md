# Technical Proposal: Fix Message Count Inflation

**Date:** 2026-04-30
**Status:** Proposal
**Problem:** `chat_sessions.message_count` counts raw streaming tokens, not semantic messages, causing inflated counts (thousands for a single agent turn), UI crashes, and retrieval timeouts.

---

## 1. Root Cause Analysis

### How tokens become rows today

```
ACP SessionNotification
  → ExtractMessages() [vm-agent: message_extract.go:56]
    Each AgentMessageChunk, UserMessageChunk, ToolCall etc.
    becomes a separate ExtractedMessage with its own UUID
  → Enqueue() [vm-agent: reporter.go:205]
    Each ExtractedMessage → one row in message_outbox
  → flushLoop() → sendBatch() [vm-agent: reporter.go:339-426]
    POST /api/workspaces/:id/messages (batches of up to ~50-100)
  → persistMessageBatch() [project-data/messages.ts:97-259]
    Each message → one INSERT INTO chat_messages
    message_count incremented by persisted count
```

**The problem is at the top of the pipeline:** `ExtractMessages()` emits one `ExtractedMessage` per ACP `SessionNotification`. Since Claude Code streams tokens in small chunks (sometimes a few characters each), a single logical assistant message like a 500-line code block can produce hundreds of `ExtractedMessage` objects, each becoming its own database row.

### Where `messageCount` is used

| Location | Impact |
|----------|--------|
| `SessionItem.tsx:146` | UI shows "3847 msgs" for what a user would perceive as 5 messages |
| `messages.ts:38-47` | Quota enforcement — `MAX_MESSAGES_PER_SESSION` (default 10000) is hit quickly |
| `list-sessions.ts:85` | SAM tools see inflated counts, making session triage unreliable |
| `messages.ts:194-196` | Batch persist stops accepting messages once quota reached |

### Existing partial mitigations

1. **`groupTokensIntoMessages()`** (`session-tools.ts:73-84`) — groups consecutive same-role tokens by concatenating content. Used by MCP `get_session_messages` and materialization. **Not used for `messageCount`.**
2. **`materializeSession()`** (`materialization.ts:27-105`) — writes grouped messages to `chat_messages_grouped` table when a session stops. **Only runs post-session, does not affect `messageCount`.**

---

## 2. Proposed Solution: VM-Agent-Side Token Buffering

### Approach

Buffer consecutive same-role tokens in the VM agent's message reporter **before enqueueing to the outbox**. This collapses N streaming chunks into 1 logical message at the source, before any database writes.

### Why at the VM agent

1. **Smallest blast radius** — the change is contained in the Go `messagereport` package. No DB schema migration, no DO changes, no UI changes.
2. **Reduces all downstream pressure** — fewer outbox rows, fewer HTTP POST payloads, fewer DB INSERTs, accurate `messageCount` from the start.
3. **The VM agent already has all the context** — it knows the current role, the session ID, and the temporal proximity of chunks.

### Design

Add a `tokenBuffer` to the message reporter that accumulates same-role content:

```go
type tokenBuffer struct {
    mu        sync.Mutex
    role      string
    content   strings.Builder
    messageID string      // UUID of the first chunk (becomes the message ID)
    timestamp time.Time   // Timestamp of the first chunk
    metadata  string      // Tool metadata (if any) — use the last non-empty value
    timer     *time.Timer // Flush after MaxBufferAge
}
```

**Buffering rules:**
- When a new `ExtractedMessage` arrives with the **same role** as the buffer, append its content to the buffer.
- When a new message arrives with a **different role**, flush the buffer (enqueue the accumulated message) and start a new buffer.
- When `MaxBufferAge` elapses (configurable, default 2s), flush regardless — this prevents unbounded latency for long streaming outputs.
- When the session ends (stop signal), flush the buffer immediately.
- `user` and `plan` roles are **never buffered** — they pass through immediately since they're already logical units.

**Groupable roles** (same set as backend): `assistant`, `tool`, `thinking`.

### Configuration

| Env Var | Default | Purpose |
|---------|---------|---------|
| `MESSAGE_BUFFER_MAX_AGE_MS` | `2000` | Max time to hold a buffer before flushing |
| `MESSAGE_BUFFER_MAX_BYTES` | `524288` (512KB) | Max buffer content size before force-flush |
| `MESSAGE_BUFFER_ENABLED` | `true` | Kill switch |

### Impact on real-time streaming

**None.** The real-time WebSocket path is unaffected because it operates independently of the message reporter:
- Real-time: ACP notifications → WebSocket → browser (via `orderedPipe` serialization in `packages/vm-agent/internal/acp/`)
- Persistence: ACP notifications → `ExtractMessages()` → reporter outbox → API → DO (the path being changed)

The browser receives tokens in real-time via WebSocket regardless of how they're batched for persistence. The persistence path is only for historical retrieval and search.

### Impact on FTS5 search

**Positive.** Fewer, larger messages means:
- `chat_messages_grouped` will have fewer but identical rows (buffering at source produces the same output as post-hoc grouping)
- FTS5 indexing is unchanged — `materializeSession()` still works, but the delta between raw and grouped is much smaller
- `searchMessages()` LIKE fallback on raw `chat_messages` becomes faster (fewer rows to scan)

### Impact on `messageCount`

**This is the fix.** With buffering, `message_count` will reflect semantic messages (e.g., 5) instead of streaming tokens (e.g., 3847). The quota enforcement limit (`MAX_MESSAGES_PER_SESSION`) will work as intended.

---

## 3. Alternative Approaches Considered

### 3a. Group at the DO persist layer (rejected)

Modify `persistMessageBatch()` to check if the last persisted message has the same role and append content instead of inserting a new row.

**Rejected because:**
- Requires a SELECT + UPDATE instead of a simple INSERT for every message — doubles write I/O
- Creates race conditions if two batches arrive near-simultaneously (two workers could both read the "last message" and both try to append)
- Would break deduplication (content-based dedup for user messages relies on exact content match)
- Doesn't reduce HTTP traffic or outbox size

### 3b. Post-process: collapse messages on session stop (rejected)

Extend materialization to delete raw rows and replace `messageCount` with the grouped count.

**Rejected because:**
- Only fixes the count after the session stops — live sessions still show inflated counts
- Deleting raw rows is destructive and complicates crash recovery
- Doesn't solve the quota enforcement problem (sessions hit 10000 "messages" during active use)
- The UI crash/timeout issue persists during active sessions

### 3c. Use `chat_messages_grouped` count for `messageCount` (partial, complement to 2)

After materialization, update `message_count` to `COUNT(*) FROM chat_messages_grouped`.

**Could complement the main fix** as a backfill/correction mechanism for already-inflated sessions, but doesn't solve the root cause for active sessions.

### 3d. Compute `messageCount` at read time via grouping (rejected)

Replace the denormalized `message_count` with a computed value from `groupTokensIntoMessages()`.

**Rejected because:**
- Requires loading ALL messages to compute a count — O(n) per session list item
- `listSessions()` returns many sessions — this becomes O(sessions * messages_per_session)
- The count would still reflect raw rows unless we also group at query time

---

## 4. Implementation Plan

### Phase 1: VM Agent Buffering (Primary Fix)

1. Add `tokenBuffer` struct to `packages/vm-agent/internal/messagereport/`
2. Modify `Enqueue()` to route groupable roles through the buffer
3. Add `Flush()` method called on role change, timer expiry, max bytes, and session end
4. Add unit tests with simulated ACP streams (many small chunks → few large messages)
5. Add integration test verifying messageCount accuracy end-to-end

### Phase 2: Backfill Existing Sessions (Complement)

1. Add a one-time migration or admin endpoint to recompute `message_count` for existing sessions using `COUNT(DISTINCT grouped_id)` from materialized data
2. For stopped+materialized sessions: `UPDATE chat_sessions SET message_count = (SELECT COUNT(*) FROM chat_messages_grouped WHERE session_id = chat_sessions.id) WHERE materialized_at IS NOT NULL`

### Phase 3: Optional — Expose Grouped Count in UI

1. For active (non-materialized) sessions, compute grouped count on-the-fly only when displaying a single session detail (not in list views)
2. For stopped sessions, use the materialized count

---

## 5. Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Buffer flush timer races with session end | `Flush()` is idempotent; session end calls `Flush()` synchronously before closing the reporter |
| Tool metadata lost during buffering | Buffer preserves the last non-empty `toolMetadata` value; tool call boundaries already create role transitions (tool → assistant) that trigger flushes |
| Max buffer size causes memory pressure | `MESSAGE_BUFFER_MAX_BYTES` caps at 512KB; force-flush when exceeded |
| Kill switch needed | `MESSAGE_BUFFER_ENABLED=false` bypasses buffer entirely, preserving current behavior |
| Existing sessions have inflated counts | Phase 2 backfill corrects historical data |

---

## 6. Success Metrics

- `messageCount` for a typical agent task session drops from ~1000-5000 to ~10-50
- `MAX_MESSAGES_PER_SESSION` quota no longer hit during normal use
- Session list loads < 100ms (no change expected, but validates no regression)
- FTS5 search latency unchanged or improved (fewer rows)
- Real-time streaming latency unchanged (independent path)

---

## 7. Files to Modify

| File | Change |
|------|--------|
| `packages/vm-agent/internal/messagereport/reporter.go` | Add `tokenBuffer`, modify `Enqueue()`, add `Flush()` |
| `packages/vm-agent/internal/messagereport/buffer.go` (new) | `tokenBuffer` struct and methods |
| `packages/vm-agent/internal/messagereport/buffer_test.go` (new) | Unit tests for buffering logic |
| `packages/vm-agent/internal/messagereport/reporter_test.go` | Update existing tests for new buffering behavior |
| `apps/api/src/durable-objects/project-data/messages.ts` | Phase 2: backfill script for existing sessions |
