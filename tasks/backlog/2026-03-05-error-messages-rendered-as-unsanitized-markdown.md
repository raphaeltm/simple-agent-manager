# Error Messages Rendered as Unsanitized Markdown in Chat

## Problem

When a task fails, the full devcontainer build log is displayed in the chat message area and is rendered as markdown. This causes docker build output to be misinterpreted:
- `#` characters in build step numbers (e.g., `Step 1/23 :`) create markdown headings
- URLs in log output become clickable links
- `*` characters in grep patterns (e.g., `'^root|^[^:]*:[^:]*:root:'`) create italic/bold formatting
- The overall result is an unreadable wall of misformatted text

## Visual Impact

The error messages are extremely long (hundreds of lines of docker build output) and visually chaotic. Users see a mix of giant headings, random italic text, and clickable links embedded in build logs, making it nearly impossible to find the actual error.

## Context

- **Discovered**: 2026-03-05 during manual QA testing
- **Severity**: Medium — error messages are present but unreadable
- **Screenshots**: `.codex/tmp/playwright-screenshots/task-failure-error.png`

## Research Findings

### Root Cause Chain

1. **Storage**: Error messages stored with `role: 'system'` in ProjectData DO SQLite — correct
2. **Conversion**: `chatMessagesToConversationItems()` in `apps/web/src/components/chat/ProjectMessageView.tsx:139-141` converts system messages to `agent_message` kind with `*System:* ${msg.content}` prefix
3. **Rendering**: `AcpConversationItemView` renders `agent_message` via `AcpMessageBubble` from `packages/acp-client/src/components/MessageBubble.tsx` which uses `react-markdown` + `remarkGfm`
4. **Result**: Build log characters (`#`, `*`, URLs) are interpreted as markdown

### Key Files

| File | Role |
|------|------|
| `apps/api/src/durable-objects/task-runner.ts:1027-1034` | Creates system messages via `persistMessage()` |
| `apps/web/src/components/chat/ProjectMessageView.tsx:139-141` | Converts `role: 'system'` → `agent_message` kind |
| `packages/acp-client/src/hooks/useAcpMessages.ts:68-74` | Defines `ConversationItem` union type |
| `packages/acp-client/src/components/MessageBubble.tsx:138-165` | Renders agent_message with react-markdown |
| `apps/web/tests/unit/components/project-message-view.test.tsx:434-441` | Existing test for system messages |

### Fix Approach

1. Add `SystemMessage` type to `ConversationItem` union in `packages/acp-client/src/hooks/useAcpMessages.ts`
2. Change `chatMessagesToConversationItems()` to output `system_message` kind instead of `agent_message`
3. Add `SystemMessageBubble` rendering in `AcpConversationItemView` that shows content as preformatted text
4. Update existing tests for system message conversion

## Implementation Checklist

- [ ] Add `SystemMessage` interface to ConversationItem type union
- [ ] Create `SystemMessageBubble` component for rendering system messages with preformatted content
- [ ] Update `chatMessagesToConversationItems()` to output `system_message` kind
- [ ] Handle `system_message` in `AcpConversationItemView` switch
- [ ] Update existing test at line 434-441 for new system_message kind
- [ ] Add behavioral test: system message with markdown chars renders as preformatted text
- [ ] Add test: system message with multi-line build log renders correctly

## Acceptance Criteria

- [ ] System error messages in chat are rendered as preformatted/monospace text (not markdown)
- [ ] Markdown-interpreted characters in error messages do not create visual artifacts
- [ ] System messages are visually distinct from agent messages
- [ ] Existing tests updated and passing
