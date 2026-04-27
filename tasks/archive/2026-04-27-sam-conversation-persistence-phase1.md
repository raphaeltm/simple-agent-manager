# SAM Conversation Persistence — Phase 1: Frontend Wiring + FTS5 Search

## Problem

The SamSession DO persists conversations/messages in SQLite, and the API has endpoints to load them (`GET /api/sam/conversations`, `GET /api/sam/conversations/:id/messages`). But the frontend (`SamPrototype.tsx`) starts with empty `messages` state on every page load — conversation history is lost on refresh.

## Research Findings

### Current Architecture
- **SamSession DO** (`apps/api/src/durable-objects/sam-session/index.ts`): Per-user DO keyed by userId. Has `conversations` and `messages` tables in embedded SQLite. Migrations use a `sam_migrations` tracking table with named migrations (001-initial, 002-rate-limits).
- **API routes** (`apps/api/src/routes/sam.ts`): `GET /conversations` lists all conversations, `GET /conversations/:id/messages` gets messages. Both proxy to DO.
- **Frontend** (`apps/web/src/pages/SamPrototype.tsx`): Uses `useState<ChatMessage[]>([])` — no history loading. `conversationId` starts null, gets set from SSE `conversation_started` event.
- **Tools** (`apps/api/src/durable-objects/sam-session/tools/`): Three tools exist (list_projects, get_project_status, search_tasks). New tools follow the pattern: export a `*Def: AnthropicToolDef` and a handler function, register both in `tools/index.ts`.
- **SAM constants** (`packages/shared/src/constants/sam.ts`): Config via `resolveSamConfig()` with env var overrides. Need to add new constants here.

### FTS5 Pattern (from ProjectData DO)
- `apps/api/src/durable-objects/project-data/messages.ts` has the proven pattern:
  - `buildFtsQuery()` — sanitizes user input into FTS5 MATCH syntax
  - `searchMessagesFts()` — FTS5 MATCH query with JOIN on content table
  - `searchMessagesLike()` — LIKE fallback for when FTS5 returns nothing
  - `extractSnippet()` — context-windowed snippet around match
- FTS5 virtual table uses `content='messages', content_rowid='rowid', tokenize='unicode61'`

### Frontend Message Model
- `ChatMessage` type in `sam-prototype/components.tsx`: `{ id, role: 'user' | 'sam', content, timestamp, toolCalls?, isStreaming? }`
- Backend `MessageRow`: `{ id, conversation_id, role, content, tool_calls_json, tool_call_id, sequence, created_at }`
- Role mapping: backend `'assistant'` → frontend `'sam'`; backend `'tool_result'` is not directly rendered (it's part of the tool_calls on the preceding assistant message)

## Implementation Checklist

### 1. Schema Changes (SamSession DO migration 003)
- [ ] Add migration `003-fts-and-type` to `migrate()` in `sam-session/index.ts`
- [ ] ALTER TABLE conversations ADD COLUMN `type TEXT NOT NULL DEFAULT 'human'`
- [ ] ALTER TABLE conversations ADD COLUMN `linked_session_id TEXT`
- [ ] ALTER TABLE conversations ADD COLUMN `linked_project_id TEXT`
- [ ] CREATE VIRTUAL TABLE `messages_fts` USING fts5(content, content='messages', content_rowid='rowid', tokenize='unicode61')
- [ ] Backfill existing messages into FTS5 table

### 2. FTS5 Integration in SamSession DO
- [ ] Add FTS5 INSERT in `persistMessage()` after the message INSERT
- [ ] Add `searchMessages(query, limit)` method with two-tier search (FTS5 MATCH → LIKE fallback)
- [ ] Port `buildFtsQuery()` and `extractSnippet()` from project-data/messages.ts
- [ ] Add `GET /search?query=...&limit=...` route handler in DO fetch()

### 3. API Route for Search
- [ ] Add `GET /api/sam/search?query=...&limit=...` route in `apps/api/src/routes/sam.ts`
- [ ] Forward to SamSession DO `GET /search?query=...&limit=...`

### 4. SAM Constants (Configurable Limits)
- [ ] Add `DEFAULT_SAM_FTS_ENABLED` (true)
- [ ] Add `DEFAULT_SAM_SEARCH_LIMIT` (10)
- [ ] Add `DEFAULT_SAM_SEARCH_MAX_LIMIT` (50)
- [ ] Add `DEFAULT_SAM_HISTORY_LOAD_LIMIT` (200)
- [ ] Add these to `SamConfig` interface and `resolveSamConfig()`

### 5. search_conversation_history Tool
- [ ] Create `apps/api/src/durable-objects/sam-session/tools/search-conversation-history.ts`
- [ ] Tool def: name `search_conversation_history`, params: `query` (string, required), `limit` (number, optional)
- [ ] Handler calls the DO's search method internally (needs access to sql storage)
- [ ] Register in `tools/index.ts`
- [ ] Update system prompt in `agent-loop.ts` to instruct SAM to use this tool

### 6. Frontend: Load Conversation on Mount
- [ ] Add `isLoadingHistory` state
- [ ] On mount, call `GET /api/sam/conversations`, filter by type='human', take most recent
- [ ] If found, call `GET /api/sam/conversations/:id/messages` with limit param
- [ ] Map `MessageRow[]` → `ChatMessage[]` (role mapping, tool_calls parsing)
- [ ] Set `conversationId` and `messages` state
- [ ] Show loading spinner while fetching
- [ ] Scroll to bottom after loading

### 7. Conversations API Enhancement
- [ ] Add `type` filter param to `GET /conversations` in the DO (filter by type='human')
- [ ] Add `limit` param to `GET /conversations/:id/messages` (use SAM_HISTORY_LOAD_LIMIT)

### 8. Tests
- [ ] Unit tests: FTS5 search, buildFtsQuery, extractSnippet, message mapping
- [ ] Integration tests (Miniflare): persist messages → load via GET → verify order/content
- [ ] Integration test: search returns results via FTS5 and LIKE fallback
- [ ] Test conversation type filtering

### 9. Documentation
- [ ] Update CLAUDE.md Recent Changes section

## Acceptance Criteria
- [ ] Opening the SAM page loads the existing conversation and shows all prior messages
- [ ] Refreshing the page preserves the full conversation
- [ ] New messages continue the same conversation thread (same conversationId)
- [ ] Tool call messages from history render correctly (tool name + collapsed result)
- [ ] SAM can search its own history via the search_conversation_history tool
- [ ] FTS5 search returns relevant snippets with context
- [ ] LIKE fallback works when FTS5 returns no results
- [ ] conversations table has type/linked_session_id/linked_project_id columns
- [ ] All new limits configurable via env vars
- [ ] Mobile layout works correctly (375px viewport)

## References
- `apps/api/src/durable-objects/sam-session/index.ts` — SamSession DO
- `apps/api/src/durable-objects/sam-session/tools/` — existing tool pattern
- `apps/api/src/routes/sam.ts` — API routes
- `apps/web/src/pages/SamPrototype.tsx` — frontend
- `apps/api/src/durable-objects/project-data/messages.ts` — FTS5 pattern to port
- `packages/shared/src/constants/sam.ts` — SAM config constants
