# Data Model: Chat Message Display Parity

## Overview

This feature modifies frontend rendering only. No database schema changes, no API contract changes, no new entities.

## Existing Entities (Unchanged)

### ConversationItem (TypeScript union type)

Defined in `packages/acp-client/src/hooks/useAcpMessages.ts`. Variants:
- `UserMessage` — user-sent text
- `AgentMessage` — agent response text (may be streaming)
- `ThinkingItem` — agent thinking blocks
- `ToolCallItem` — tool executions with structured content
- `PlanItem` — plan entries with status tracking
- `SystemMessage` — system notifications (project-only)
- `RawFallback` — unknown message types (JSON dump)

### ToolCallContentItem (TypeScript interface)

Defined in `packages/acp-client/src/hooks/useAcpMessages.ts`.

```
{
  type: 'content' | 'diff' | 'terminal'
  text?: string
  data?: unknown  // ← THIS FIELD is the focus of FR-001
}
```

The `data` field is populated by `mapToolCallContent()` in workspace chat but NOT populated for `terminal` and `content` types in `chatMessagesToConversationItems()` in project chat.

### ChatMessageResponse (TypeScript interface)

Defined in `apps/web/src/lib/api.ts`. Represents a DO-persisted message:

```
{
  id: string
  sessionId: string
  role: string
  content: string
  toolMetadata: Record<string, unknown> | null
  createdAt: number
  sequence?: number | null
}
```

## Data Flow (Unchanged)

```
Workspace Chat (live):
  ACP WebSocket → useAcpMessages.processMessage() → ConversationItem[] → AgentPanel

Project Chat (persisted):
  DO SQLite → GET /api/projects/:id/sessions/:id → ChatMessageResponse[]
    → chatMessagesToConversationItems() → ConversationItem[] → AcpConversationItemView
```

## Changes Summary

| What | Before | After |
|------|--------|-------|
| `data` field in project tool content | Only set for diffs | Set for all content types |
| Plan rendering | Duplicated in AgentPanel + ProjectMessageView | Shared PlanView component |
| Raw fallback in project | `return null` (hidden) | Rendered via shared RawFallbackView |
