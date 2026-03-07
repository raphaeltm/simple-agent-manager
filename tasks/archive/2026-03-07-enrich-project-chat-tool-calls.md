# Enrich Project Chat Tool Call Display

## Problem

In the project chat, tool calls only show the word "tool" (or a generic kind like "bash", "read"). In the workspace chat, tool calls show rich information: a descriptive title (e.g., "Read file src/main.ts"), typed content (diffs, terminal output), and file locations. Users need the same detail in both views to understand what the agent is doing.

## Root Cause

The Go VM agent's `message_extract.go` extracts tool call notifications from ACP but discards:
1. **`Title`** field — the human-readable description of what the tool is doing
2. **Structured content** — content items are flattened to plain text, losing type info (diff/terminal/content)

The `ToolMeta` struct only captures `Kind`, `Status`, and `Locations`. The frontend's `chatMessagesToConversationItems()` then sets `title` to the `kind` value since no title is available.

## Research Findings

### Key Files
- `packages/vm-agent/internal/acp/message_extract.go` — `ToolMeta` struct and `ExtractMessages()`
- `packages/vm-agent/internal/acp/message_extract_test.go` — existing tests
- `apps/web/src/components/chat/ProjectMessageView.tsx` — `chatMessagesToConversationItems()` at line 114
- `packages/acp-client/src/hooks/useAcpMessages.ts` — workspace chat processing (reference)
- `packages/acp-client/src/components/ToolCallCard.tsx` — shared rendering component

### ACP SDK Types (acp-go-sdk v0.6.3)
- `SessionUpdateToolCall.Title` (string) — "Human-readable title describing what the tool is doing"
- `SessionToolCallUpdate.Title` (*string) — "Update the human-readable title"
- `ToolCallContent` union: `Content` (text), `Diff` (path + old/new text), `Terminal` (id)

### Data Flow
1. ACP notification → `ExtractMessages()` → `ExtractedMessage` with `ToolMetadata` JSON string
2. VM outbox → HTTP POST → API route → ProjectData DO → SQLite `tool_metadata` TEXT column
3. DO retrieval → WebSocket broadcast → browser `ChatMessageResponse.toolMetadata`
4. `chatMessagesToConversationItems()` → `ToolCallItem` → `ToolCallCard` component

## Implementation Checklist

### Go Changes
- [ ] Add `Title` field to `ToolMeta` struct
- [ ] Add `Content` field (structured array) to `ToolMeta` struct
- [ ] Extract `Title` from `SessionUpdateToolCall` in `ExtractMessages()`
- [ ] Extract `Title` from `SessionToolCallUpdate` in `ExtractMessages()`
- [ ] Extract structured content items (type + text) instead of flattening
- [ ] Update `message_extract_test.go` with tests for new fields

### TypeScript Changes
- [ ] Update `chatMessagesToConversationItems()` to use `meta.title` for the title field
- [ ] Parse `meta.content` as structured `ToolCallContentItem[]` when available
- [ ] Fall back to existing behavior when metadata fields are missing (backward compat)

## Acceptance Criteria

- [ ] Project chat tool calls show descriptive titles (e.g., "Read file", "Bash command") instead of just "tool" or "bash"
- [ ] Project chat tool calls show structured content (diffs, terminal output) when available
- [ ] Backward compatible — old messages without the new metadata fields still render correctly
- [ ] Go tests pass
- [ ] TypeScript typecheck/lint pass
- [ ] Existing tests still pass

## References

- ACP SDK types: `/go/pkg/mod/github.com/coder/acp-go-sdk@v0.6.3/types_gen.go` lines 3382-3427
- Workspace chat processing: `packages/acp-client/src/hooks/useAcpMessages.ts` lines 293-320
