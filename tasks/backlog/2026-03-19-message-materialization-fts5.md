# Post-Session Message Materialization + FTS5 Search

**Created**: 2026-03-19
**Context**: `search_messages` MCP tool searches raw streaming tokens with `LIKE`, failing to match terms that span token boundaries. Materialized grouped messages + FTS5 index solves this.

## Problem

Chat messages are stored as individual streaming tokens (one DB row per Claude Code chunk) in `chat_messages`. The `search_messages` handler in `project-data.ts:599-667` runs `WHERE m.content LIKE ?` against individual token rows. Multi-word search terms spanning token boundaries (e.g., "auth refactor" split across two chunks) silently fail to match.

The `groupTokensIntoMessages()` function in `mcp.ts:1678-1696` already groups tokens at read time — this task materializes those groups into a searchable table with FTS5 indexing.

## Research Findings

### Key Files
- `apps/api/src/durable-objects/project-data.ts` — ProjectData DO with `searchMessages()` at line 599-667
- `apps/api/src/durable-objects/migrations.ts` — Migration system, 10 existing migrations (001-010)
- `apps/api/src/routes/mcp.ts` — `groupTokensIntoMessages()` at line 1678-1696, `search_messages` handler at line 1762-1817
- `apps/api/src/services/project-data.ts` — Service layer, `searchMessages()` at line 159-177
- `apps/api/tests/unit/routes/mcp.test.ts` — Existing tests for search_messages (lines 719-791) and groupTokensIntoMessages (lines 1944-2076)

### Architecture
- Per-project data in ProjectData Durable Objects with embedded SQLite (NOT D1)
- Migrations tracked in `migrations` table, run in `blockConcurrencyWhile()` on DO construction
- Session status transitions: `active` → `stopped` (terminal) via `stopSession()` or `stopSessionInternal()`
- `stopSession()` at line 164-193 handles explicit stop with activity events and WebSocket broadcast
- `stopSessionInternal()` at line 982-990 is the internal stop (no broadcast)
- Service layer delegates to DO stub via `getStub(env, projectId)`

### Grouping Logic (mcp.ts:1669-1696)
- `GROUPABLE_ROLES`: `assistant`, `tool`, `thinking`
- Non-groupable: `user`, `system`, `plan` (pass through as-is)
- Consecutive same-role groupable tokens concatenated; first token's `id`/`createdAt` used

### Current searchMessages (project-data.ts:599-667)
- Escapes LIKE wildcards, wraps with `%`
- Joins `chat_messages` with `chat_sessions` for topic/task_id context
- Extracts 200-char snippet around first match
- Returns: `id`, `sessionId`, `role`, `snippet`, `createdAt`, `sessionTopic`, `sessionTaskId`

### Test Patterns
- DO methods mocked on `mockDoStub` (e.g., `searchMessages: vi.fn().mockReturnValue([])`)
- `mcpRequest()` helper sends JSON-RPC via `app.request('/mcp', ...)`
- Integration tests use `InMemorySqlStorage` mock

## Implementation Checklist

### A) Migration: Add materialized tables (migration 011)
- [ ] Add `011-message-materialization-fts5` migration in `migrations.ts`
- [ ] Create `chat_messages_grouped` table: `id TEXT PK, session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL`
- [ ] Add index: `idx_grouped_messages_session ON chat_messages_grouped(session_id, created_at)`
- [ ] Create FTS5 virtual table: `chat_messages_grouped_fts` with `content=chat_messages_grouped, content_rowid=rowid` and indexed column `content`
- [ ] Add `materialized_at INTEGER` column to `chat_sessions` to track which sessions have been materialized (NULL = not yet)

### B) Materialization logic in ProjectData DO
- [ ] Extract `groupTokensIntoMessages()` logic into a shared location (or duplicate the pure function in the DO since it's small)
- [ ] Add `materializeSession(sessionId: string)` method to ProjectData DO that:
  1. Checks if session is already materialized (`materialized_at IS NOT NULL`) — return early if so
  2. Reads all tokens for session from `chat_messages` ordered by `created_at ASC, sequence ASC`
  3. Groups tokens using the same grouping logic
  4. Inserts grouped messages into `chat_messages_grouped`
  5. Inserts into FTS5 table (via INSERT into the content-sync'd FTS table)
  6. Sets `materialized_at` on the session
  7. All within a transaction for atomicity

### C) Trigger materialization on session stop
- [ ] In `stopSession()`, call `materializeSession(sessionId)` after setting status to stopped
- [ ] In `stopSessionInternal()`, call `materializeSession(sessionId)` after setting status to stopped
- [ ] Materialization should not throw/block the stop operation — wrap in try/catch with error logging

### D) Backfill method for existing stopped sessions
- [ ] Add `materializeAllStopped()` method that finds all stopped sessions with `materialized_at IS NULL` and materializes them
- [ ] Expose via a DO RPC method so it can be called from an API endpoint or manually

### E) Update searchMessages to use FTS5
- [ ] Modify `searchMessages()` in `project-data.ts` to:
  1. Query `chat_messages_grouped_fts` using FTS5 `MATCH` syntax for materialized sessions
  2. Fall back to current `LIKE` search on `chat_messages` for non-materialized (active) sessions
  3. Combine results, dedup, order by `created_at DESC`, apply limit
- [ ] Update snippet extraction to work with full grouped content (larger text)
- [ ] Update the search_messages tool description in mcp.ts to remove the cross-token limitation note

### F) Tests
- [ ] Unit test `materializeSession()`: tokens grouped and written correctly, idempotent
- [ ] Unit test FTS5 search: phrase matching across former token boundaries works
- [ ] Unit test fallback: active (non-materialized) sessions still searchable via LIKE
- [ ] Unit test `materializeAllStopped()`: materializes only unmaterialized stopped sessions
- [ ] Update existing `search_messages` MCP tests to cover FTS path
- [ ] Integration test: full flow — persist tokens → stop session → search across token boundaries

### G) Documentation
- [ ] Update `search_messages` tool description in mcp.ts to reflect FTS5 capability
- [ ] Update `docs/architecture/durable-objects.md` to document the materialized table and FTS5 index

## Acceptance Criteria

- [ ] Search terms spanning token boundaries are found (e.g., "auth refactor" split across tokens)
- [ ] FTS5 phrase matching works (quoted phrases, prefix queries)
- [ ] Snippets reflect the full grouped message content, not individual tokens
- [ ] Active sessions still searchable (graceful LIKE fallback)
- [ ] Materialization is idempotent (re-running is a no-op)
- [ ] Materialization doesn't block session stop on failure
- [ ] Existing search behavior for single-token matches is not regressed
- [ ] Performance: FTS5 MATCH is faster than LIKE for large sessions

## References

- `apps/api/src/durable-objects/project-data.ts:599-667` — current searchMessages
- `apps/api/src/durable-objects/migrations.ts:20-233` — migration definitions
- `apps/api/src/routes/mcp.ts:1669-1696` — groupTokensIntoMessages
- `apps/api/src/routes/mcp.ts:1762-1817` — search_messages MCP handler
- `tasks/backlog/2026-03-17-search-messages-cross-token-matching.md` — original backlog task
- `tasks/archive/2026-03-17-token-message-concatenation.md` — prior token grouping work
