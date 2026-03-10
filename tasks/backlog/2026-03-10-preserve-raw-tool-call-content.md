# Preserve Raw Tool Call Content Across Persisted Message Path

## Problem

Real-time ACP WebSocket messages include full tool call content (diffs with oldText/newText, terminal output, structured content blocks), but when messages are persisted to the Durable Object and reloaded on page refresh, this rich information is lost.

The Go `extractStructuredContent()` in `message_extract.go` selectively extracts fields into `ToolContentItem` structs, flattening the ACP wire format:
- Content blocks: `{ type: "content", content: { type: "text", text: "..." } }` → `{ type: "content", text: "..." }` (nested structure lost)
- Terminal blocks: `{ type: "terminal", terminalId: "term-id" }` → `{ type: "terminal", text: "term-id" }` (field name changed)
- Future ACP fields: silently dropped

The real-time path (`useAcpMessages.ts:mapToolCallContent`) preserves the full raw ACP object as `data`, while the persisted path reconstructs a different shape.

## Research Findings

### Key Files
- `packages/vm-agent/internal/acp/message_extract.go` — Go extraction (lossy step)
- `packages/vm-agent/internal/acp/message_extract_coverage_test.go` — Go tests
- `apps/web/src/components/chat/ProjectMessageView.tsx` — Frontend reconstruction (`chatMessagesToConversationItems`)
- `packages/acp-client/src/hooks/useAcpMessages.ts` — Real-time path (`mapToolCallContent`)
- `packages/acp-client/src/components/ToolCallCard.tsx` — Rendering component

### ACP SDK Marshaling
The ACP SDK (`github.com/coder/acp-go-sdk v0.6.3`) has a custom `MarshalJSON` on `ToolCallContent` that produces the exact wire format the frontend expects:
- `{ "type": "content", "content": { "type": "text", "text": "..." } }`
- `{ "type": "diff", "path": "...", "oldText": "...", "newText": "..." }`
- `{ "type": "terminal", "terminalId": "..." }`

### Storage Schema
Messages stored in DO SQLite with `content` (text) and `tool_metadata` (JSON string containing `ToolMeta`).

## Implementation Checklist

- [ ] **Go: Change `ToolMeta.Content` type** — From `[]ToolContentItem` to `[]json.RawMessage`
- [ ] **Go: Replace `extractStructuredContent()`** — Use SDK's `MarshalJSON` to serialize each `ToolCallContent` to raw JSON. Apply `truncateContent()` to diff `OldText`/`NewText` before marshaling.
- [ ] **Go: Keep `ToolContentItem` for tests** — Tests can unmarshal raw content back into `ToolContentItem` for field assertions (or use map[string]any)
- [ ] **Go: Update tests** — 9 tests in `message_extract_coverage_test.go` access `meta.Content[i].Type` etc. — need to unmarshal `json.RawMessage` first
- [ ] **Frontend: Simplify reconstruction** — In `chatMessagesToConversationItems`, pass stored content items through the same `mapToolCallContent` function used by the real-time path (or equivalent logic)
- [ ] **Frontend: Remove special-case diff reconstruction** — Lines 193-196 manually rebuild diff data; with raw storage this is unnecessary
- [ ] **Run Go tests** — `cd packages/vm-agent && go test ./internal/acp/...`
- [ ] **Run frontend quality checks** — `pnpm typecheck && pnpm lint && pnpm test`

## Acceptance Criteria

- [ ] Tool call content blocks round-trip through Go extraction → DO storage → frontend reconstruction with the same shape as the real-time ACP path
- [ ] Large diff fields (oldText/newText) are still truncated before storage
- [ ] Existing tests pass (updated for new format)
- [ ] No regression in real-time tool call rendering
- [ ] Page refresh preserves rich tool call information (diffs, terminal, content)

## References

- ACP SDK types: `/go/pkg/mod/github.com/coder/acp-go-sdk@v0.6.3/types_gen.go:4041-4203`
- Real-time rendering: `packages/acp-client/src/hooks/useAcpMessages.ts:471-483`
- ToolCallCard: `packages/acp-client/src/components/ToolCallCard.tsx`
