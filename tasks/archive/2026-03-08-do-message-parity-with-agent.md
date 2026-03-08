# DO Message Parity with Agent Stream

## Problem

Project chat (messages via Durable Object) shows significantly less information than workspace chat (direct ACP WebSocket). Users lose visibility into agent behavior when viewing task history through the project chat interface.

### What's Missing in Project Chat (DO Path)

1. **Thinking blocks** — `agent_thought_chunk` notifications are dropped at `ExtractMessages()` in `message_extract.go` and never stored
2. **Plan items** — `plan` notifications are dropped, never persisted to DO
3. **Tool call deduplication** — `tool_call` and `tool_call_update` events are stored as separate DO rows, causing duplicate tool cards in project chat (workspace chat merges them in-place by `toolCallId`)
4. **`toolCallId` not preserved** — ACP `toolCallId` replaced with a new UUID at extraction time, preventing cross-system correlation
5. **Diff content** — only file paths stored (`diff: /path/to/file`), not actual diff content
6. **Terminal output** — only terminal IDs stored, not actual output
7. **Streaming granularity** — assistant text arrives as atomic complete messages, no progressive display

### Root Cause

The `ExtractMessages()` function in `packages/vm-agent/internal/acp/message_extract.go` acts as a lossy filter, intentionally dropping thinking, plan, and command update notifications. Tool call content extraction (`extractToolCallContents()`) only captures text-type content blocks and flattens diff/terminal content to path strings.

### Key Code Paths

| Component | File |
|-----------|------|
| Message extraction (lossy filter) | `packages/vm-agent/internal/acp/message_extract.go` |
| ACP session notification handler | `packages/vm-agent/internal/acp/session_host.go:SessionUpdate()` |
| Message outbox reporter | `packages/vm-agent/internal/messagereport/reporter.go` |
| DO message persistence | `apps/api/src/durable-objects/project-data.ts:persistMessageBatch()` |
| DO message schema | `apps/api/src/durable-objects/migrations.ts` |
| Project chat rendering | `apps/web/src/components/chat/ProjectMessageView.tsx` |
| DO→ConversationItem conversion | `ProjectMessageView.tsx:chatMessagesToConversationItems()` |
| ACP message processing (workspace) | `packages/acp-client/src/hooks/useAcpMessages.ts` |
| Shared message types | `packages/shared/src/types.ts` |

## Approach

Use speckit flow to design and implement a solution that brings DO-persisted messages closer to parity with the direct ACP stream.

## Acceptance Criteria

- [ ] Tool calls in project chat match workspace chat fidelity (single card per tool call with status transitions)
- [ ] Thinking blocks are persisted and displayed in project chat history
- [ ] Diff content is preserved in tool call metadata (not just file paths)
- [ ] Terminal output content is preserved
- [ ] Plan items are persisted and displayed
- [ ] `toolCallId` is preserved through the persistence pipeline for deduplication
- [ ] No regression in workspace chat behavior
- [ ] Tests covering the enhanced message extraction and rendering

## References

- `packages/vm-agent/internal/acp/message_extract.go` — current lossy extraction
- `apps/web/src/components/chat/ProjectMessageView.tsx` — current DO→UI conversion
- `packages/acp-client/src/hooks/useAcpMessages.ts` — reference implementation (workspace chat)
