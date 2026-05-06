# Compact Mode for Chat Messages + Lazy-Load Tool Content

## Problem

Chat sessions with heavy tool usage exceed Cloudflare's 32 MiB DO RPC serialization limit. The `tool_metadata` column in `chat_messages` stores full tool call content (file contents, command output, search results, diffs) — each content block up to 100KB, accumulating across hundreds of tool calls per session.

PR #918 added a 500-row default limit + 30 MiB RPC size guard as a stopgap, but the structural issue remains: full `tool_metadata.content` is sent on every initial load even though users rarely expand tool calls.

## Research Findings

### Storage Path
- **VM Agent** (`message_extract.go`): `ExtractMessages()` creates `ToolMeta` struct with `Content []json.RawMessage` — full raw ACP content blocks
- `marshalRawContent()` preserves wire format; `truncateContent()` caps at 100KB per diff field
- `persistMessageBatch()` stores `tool_metadata` as JSON string in DO SQLite `chat_messages` table

### Read Path
- `getMessages()` in `messages.ts`: queries all columns including `tool_metadata`, returns via RPC
- `parseChatMessageRow()` in `row-schemas.ts`: `JSON.parse(tool_metadata)` for every row
- `projectDataService.getMessages()`: thin RPC wrapper — this is the 32 MiB boundary
- Chat route (`GET /:sessionId`): passes full result to client

### Frontend Rendering
- `chatMessagesToConversationItems()` in `types.ts`: extracts `toolCallId`, `title`, `kind`, `status`, `locations`, `content` from tool_metadata
- `ToolCallCard` in `acp-client`: renders collapsed by default, expands on click
- **Key insight**: the header only needs `title`, `status`, `kind`, `locations` — `content` is only needed on expand
- `ToolCallItem` interface: `content: ToolCallContentItem[]` — always populated even when collapsed

### DO Public Interface
- `ProjectData.getMessages(sessionId, limit, before, roles)` — no compact parameter yet
- Need to add `compact` parameter and a new `getMessageToolContent(sessionId, messageId)` method

## Implementation Checklist

### Backend (DO + Service Layer)
- [ ] Add `stripToolMetadataContent()` helper in `messages.ts` — strips `content` array from parsed tool_metadata, adds `contentSize` byte count
- [ ] Add `compact` parameter to `getMessages()` in `messages.ts` — when true, strip content from tool_metadata before returning
- [ ] Add `getMessageToolContent()` function in `messages.ts` — fetches single message by ID+sessionId, returns parsed `tool_metadata.content`
- [ ] Update `ProjectData` DO class in `index.ts` — expose `getMessages(sessionId, limit, before, roles, compact)` and `getMessageToolContent(sessionId, messageId)`
- [ ] Update `projectDataService.getMessages()` in `services/project-data.ts` — add `compact` parameter, pass through
- [ ] Add `projectDataService.getMessageToolContent()` in `services/project-data.ts`
- [ ] Add `DEFAULT_CHAT_COMPACT_MODE` constant in `packages/shared/src/constants/defaults.ts`

### API Routes
- [ ] Update chat session detail route (`GET /:sessionId`) in `chat.ts` — pass `compact=true` by default (configurable via `CHAT_COMPACT_MODE_DEFAULT` env var)
- [ ] Add new route `GET /:sessionId/messages/:messageId/tool-content` in `chat.ts` — calls `projectDataService.getMessageToolContent()`, returns content array
- [ ] Ensure summarize route continues to use `compact=false` (needs full content for AI summarization)

### Frontend
- [ ] Add `getMessageToolContent()` API client function in `apps/web/src/lib/api/sessions.ts`
- [ ] Update `ToolCallItem` interface in `acp-client` — add optional `contentSize?: number` and `contentLoaded?: boolean` fields
- [ ] Update `chatMessagesToConversationItems()` in `types.ts` — handle compact metadata (missing `content` with `contentSize` present)
- [ ] Update `ToolCallCard` — show "Load content" hint when content not loaded, fetch on expand, cache in state

### Testing
- [ ] Unit test: `stripToolMetadataContent()` correctly strips content and computes size
- [ ] Unit test: `getMessages()` with compact=true returns messages without content blocks
- [ ] Unit test: `getMessageToolContent()` returns correct content for valid message
- [ ] Unit test: `getMessageToolContent()` returns null for message without tool_metadata
- [ ] Integration test: compact mode significantly reduces payload size vs full mode
- [ ] Frontend test: ToolCallCard lazy-loads content on expand

### Documentation
- [ ] Update CLAUDE.md Recent Changes section
- [ ] Add env var to `apps/api/.env.example` if not already covered

## Acceptance Criteria

1. Default message loads use compact mode — tool_metadata.content stripped, contentSize included
2. New endpoint returns tool content for individual messages on demand
3. ToolCallCard shows collapsed tool calls without content, loads content on expand
4. Sessions that previously crashed with ISE now load successfully
5. Existing tool call rendering unchanged after content is loaded (visual parity)
6. Summarize endpoint still gets full content (not compact)
7. All new behavior configurable via env vars (Constitution Principle XI)

## References
- PR #918: RPC size guard (stopgap fix)
- PR #917: Chat ISE diagnostics
- `apps/api/src/durable-objects/project-data/messages.ts` — getMessages, RPC size guard
- `apps/api/src/durable-objects/project-data/row-schemas.ts` — parseChatMessageRow
- `apps/api/src/routes/chat.ts` — session detail route
- `packages/acp-client/src/components/ToolCallCard.tsx` — collapsed-by-default rendering
- `packages/acp-client/src/hooks/useAcpMessages.ts` — ToolCallItem, ToolCallContentItem interfaces
- `apps/web/src/components/project-message-view/types.ts` — chatMessagesToConversationItems
