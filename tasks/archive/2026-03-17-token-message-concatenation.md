# Token-to-Message Concatenation in MCP + Documentation Updates

**Created**: 2026-03-17
**Context**: Agents using `get_session_messages` receive fragmented streaming tokens instead of logical messages

## Problem

The `get_session_messages` MCP tool returns individual streaming tokens (each chunk from Claude Code stored as a separate row in `chat_messages`). Agents receive fragmented output like:
```
{ "role": "assistant", "content": "Let me" }
{ "role": "assistant", "content": " look at" }
{ "role": "assistant", "content": " that file." }
```

This makes it hard for agents to read conversation history. The frontend already groups these via `groupMessages()` in `apps/web/src/components/chat/ProjectMessageView.tsx:64-81` — the same logic should be applied server-side.

Additionally, documentation across the codebase doesn't clarify the token-vs-message distinction, leading to confusion.

## Research Findings

### Key Code Paths

1. **Frontend grouping** (`ProjectMessageView.tsx:64-81`): Groups consecutive same-role messages (assistant, tool, thinking) by concatenating. Uses first token's `id` and `createdAt`.

2. **MCP handler** (`mcp.ts:1649-1708`): `handleGetSessionMessages()` fetches from `projectDataService.getMessages()` and maps directly — no grouping.

3. **DO message query** (`project-data.ts:555-557`): Returns messages ordered by `created_at ASC, sequence ASC`. The `sequence` field orders tokens within the same millisecond.

4. **Token creation** (`message_extract.go`): VM agent extracts individual streaming chunks and persists them as separate rows.

5. **Tool schema** (`mcp.ts:358-380`): Description says "Read messages" — doesn't mention tokens or concatenation behavior.

### Documentation Gaps

- MCP tool descriptions don't mention token-vs-message distinction
- `docs/architecture/durable-objects.md:92` describes `chat_messages` as "Append-only message log" — no token distinction
- `apps/www/src/content/docs/docs/guides/agents.md:139` lists tools without token context
- No skills or subagents reference the MCP message tools directly

### Groupable Roles

Per the frontend: `assistant`, `tool`, `thinking` are groupable. `user`, `system`, `plan` are not grouped (each is its own message).

## Implementation Checklist

### A) Server-side token concatenation

- [ ] Add `groupTokensIntoMessages()` function in `mcp.ts` that groups consecutive same-role tokens
  - Groupable roles: `assistant`, `tool`, `thinking`
  - Use first token's `id` and `createdAt` as the group's values
  - Concatenate `content` fields of grouped tokens
  - Non-groupable roles (`user`, `system`, `plan`) pass through as-is
- [ ] Apply grouping in `handleGetSessionMessages()` after fetching messages, before building response
- [ ] Update `messageCount` to reflect grouped count (not raw token count)
- [ ] Add unit tests for the grouping function:
  - Consecutive same-role assistant tokens are merged
  - Different roles create separate messages
  - Non-groupable roles (user, system) are not merged
  - Single-message sessions pass through unchanged
  - Empty message list returns empty
  - Mixed sequence (user, assistant x3, tool x2, user) groups correctly

### B) Documentation updates

- [ ] Update `get_session_messages` tool description in MCP tool schema (`mcp.ts:358-380`) to mention concatenation behavior
- [ ] Update `search_messages` tool description to note cross-token search limitation
- [ ] Update `docs/architecture/durable-objects.md:92` to clarify token-per-row storage
- [ ] Update `apps/www/src/content/docs/docs/guides/agents.md:139` MCP tools table to clarify behavior
- [ ] Add inline code comment in `handleGetSessionMessages()` explaining the grouping

## Acceptance Criteria

- [ ] `get_session_messages` returns concatenated logical messages, not individual tokens
- [ ] Consecutive assistant/tool/thinking tokens are merged into single messages
- [ ] User and system messages are not merged
- [ ] First token's `id` and `createdAt` are used for the grouped message
- [ ] `messageCount` reflects the number of logical messages
- [ ] Token storage is unchanged — only the MCP return value changes
- [ ] Unit tests cover all grouping scenarios
- [ ] MCP tool descriptions updated to clarify behavior
- [ ] Architecture docs updated with token-vs-message distinction

## References

- `apps/api/src/routes/mcp.ts:1649-1708` — get_session_messages handler
- `apps/api/src/routes/mcp.ts:358-380` — tool schema definitions
- `apps/web/src/components/chat/ProjectMessageView.tsx:64-81` — reference groupMessages
- `apps/api/src/durable-objects/project-data.ts:555-557` — message query ordering
- `packages/vm-agent/internal/acp/message_extract.go` — token creation
- `tasks/backlog/2026-03-17-search-messages-cross-token-matching.md` — related cross-token search issue
