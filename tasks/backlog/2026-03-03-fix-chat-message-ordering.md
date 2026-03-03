# Fix Chat Message Ordering (Scrambled Tokens)

## Problem

Chat messages displayed in workspace sessions have scrambled tokens. Words within a single assistant response appear rearranged (e.g., "finger seconds Usesprint-based de" instead of "fingerprint-based dedup"). The text content is present but in the wrong order.

## Root Cause

Each ACP streaming chunk from Claude Code becomes a **separate database row** with its own UUID (`message_extract.go:ExtractMessages()`). These rows are ordered solely by `created_at` (millisecond-precision integer). When multiple chunks arrive within the same millisecond — common during fast streaming — SQLite returns them in **undefined order** because there is no tiebreaker column.

The 3-second polling fallback (`ProjectMessageView.tsx`) replaces the message list with fresh DB query results, which may return same-timestamp rows in a different arbitrary order each time.

## Research Findings

### Affected Code Paths

1. **VM Agent outbox** (`packages/vm-agent/internal/messagereport/`)
   - `schema.go`: Outbox table has `id INTEGER PRIMARY KEY AUTOINCREMENT` (monotonic) but this value is never forwarded to the API
   - `reporter.go:readBatch()`: Reads `ORDER BY created_at ASC` — correct order locally, but the autoincrement `id` is not included in the API payload
   - `reporter.go:sendBatch()`: `apiMessage` struct has no sequence field

2. **API endpoint** (`apps/api/src/routes/workspaces.ts:1493`)
   - `POST /:id/messages`: Accepts `{messageId, sessionId, role, content, toolMetadata, timestamp}` — no sequence field

3. **Service layer** (`apps/api/src/services/project-data.ts:78`)
   - `persistMessageBatch()`: Passes messages through without sequence

4. **DO persistence** (`apps/api/src/durable-objects/project-data.ts:232`)
   - `persistMessageBatch()`: Inserts with `created_at = new Date(msg.timestamp).getTime()` — truncates nanosecond RFC3339 to millisecond integer
   - Broadcasts `messages.batch` with `persistedMessages` array in insertion order (correct at broadcast time, but lost on re-fetch)

5. **DO query** (`apps/api/src/durable-objects/project-data.ts:434`)
   - `getMessages()`: `ORDER BY created_at DESC` with `.reverse()` — no tiebreaker for same-millisecond rows

6. **DO schema** (`apps/api/src/durable-objects/migrations.ts:44`)
   - `chat_messages` table: `id TEXT PRIMARY KEY, created_at INTEGER` — no sequence column
   - Index: `idx_chat_messages_session_created ON chat_messages(session_id, created_at)` — no sequence in index

7. **UI** (`apps/web/src/components/chat/ProjectMessageView.tsx`)
   - `onCatchUp` (line 394): `setMessages(catchUpMessages)` — replaces with DB-ordered messages
   - Polling (line 463): `setMessages(data.messages)` — replaces with DB-ordered messages
   - Both paths use whatever order `getMessages()` returns

8. **Shared types** (`apps/web/src/lib/api.ts:469`)
   - `ChatMessageResponse`: Has `createdAt` but no `sequence` field

## Implementation Plan

### Step 1: Add `sequence` column to DO migration
- Add migration `007-add-message-sequence` to `migrations.ts`
- `ALTER TABLE chat_messages ADD COLUMN sequence INTEGER`
- Update index: `CREATE INDEX idx_chat_messages_session_seq ON chat_messages(session_id, sequence)`

### Step 2: Update VM agent to forward outbox `id` as sequence
- Add `Sequence int64` field to `apiMessage` struct in `reporter.go:sendBatch()`
- Set it from `row.id` (the autoincrement primary key, which is monotonic)
- Add `Sequence` field to `Message` struct for any direct callers

### Step 3: Update API endpoint to accept sequence
- Add optional `sequence` field to message validation in `workspaces.ts`
- Pass through to service layer and DO

### Step 4: Update DO `persistMessageBatch` to store sequence
- Accept `sequence` in the message array
- If provided, store in `chat_messages.sequence`
- If not provided (backward compat), auto-assign using a session-scoped counter

### Step 5: Update `getMessages` to order by sequence
- Change query to `ORDER BY sequence DESC` (with fallback to `created_at DESC` for old rows without sequence)
- Practical: `ORDER BY created_at DESC, sequence DESC`

### Step 6: Update broadcast payload and UI types
- Include `sequence` in `messages.batch` broadcast payload
- Add `sequence` to `ChatMessageResponse` type
- No UI rendering changes needed — ordering is fixed at the data layer

### Step 7: Write tests
- Go test: Verify outbox `id` is sent as `sequence` in batch payload
- DO test: Verify messages with same `created_at` but different `sequence` are returned in correct order
- Integration: Verify batch persistence preserves sequence ordering

## Acceptance Criteria

- [ ] Messages with identical `created_at` timestamps are returned in correct insertion order
- [ ] VM agent sends monotonic sequence numbers derived from outbox autoincrement ID
- [ ] DO stores and queries by sequence as tiebreaker
- [ ] Existing messages without sequence values still display correctly (backward compat)
- [ ] All existing tests pass
- [ ] New tests cover the ordering fix

## References

- `packages/vm-agent/internal/messagereport/reporter.go` — outbox flush
- `packages/vm-agent/internal/messagereport/schema.go` — outbox DDL
- `packages/vm-agent/internal/acp/message_extract.go` — chunk extraction
- `apps/api/src/routes/workspaces.ts:1493` — POST messages endpoint
- `apps/api/src/durable-objects/project-data.ts:232` — persistMessageBatch
- `apps/api/src/durable-objects/project-data.ts:420` — getMessages
- `apps/api/src/durable-objects/migrations.ts` — DO schema
- `apps/web/src/hooks/useChatWebSocket.ts` — WebSocket message handling
- `apps/web/src/components/chat/ProjectMessageView.tsx` — message rendering
