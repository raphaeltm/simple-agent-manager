# Fix Duplicate Follow-Up Messages in Project Chat

**Created:** 2026-03-26
**Priority:** High (user-facing bug)

## Problem Statement

When a user submits any follow-up message in a project chat, the message appears twice. This is a regression of a previously fixed issue (PR #441 fixed ACP+DO merge duplication, but a different duplication path exists).

## Root Cause

User follow-up messages are persisted to the DO database **twice** via two independent paths:

1. **DO WebSocket path**: `handleSendFollowUp()` sends `{ type: 'message.send' }` via the DO WebSocket → `ProjectData.webSocketMessage()` calls `persistMessage()` → generates server ID (e.g., `msg-123`) → broadcasts `message.new`
2. **VM agent batch path**: `handleSendFollowUp()` also calls `agentSession.sendPrompt()` → VM agent receives via ACP → `ExtractMessages()` extracts user message with `uuid.NewString()` (e.g., `acp-456`) → batch POST to DO → `persistMessageBatch()` → ID-only dedup doesn't match → inserts SECOND row → broadcasts `messages.batch`

The `persistMessageBatch` function (`apps/api/src/durable-objects/project-data/messages.ts:140-148`) only checks `SELECT id FROM chat_messages WHERE id = ?` for deduplication. Since the two paths generate different IDs for the same content, both insertions succeed.

## Research Findings

### Key Files
- `apps/web/src/components/chat/ProjectMessageView.tsx:706-795` — `handleSendFollowUp()` sends via both DO WebSocket AND ACP
- `apps/api/src/durable-objects/project-data/index.ts:295-322` — DO WebSocket `message.send` handler calls `persistMessage()`
- `apps/api/src/durable-objects/project-data/messages.ts:87-177` — `persistMessageBatch()` with ID-only dedup
- `packages/vm-agent/internal/acp/message_extract.go:56-70` — `ExtractMessages()` extracts user messages with new UUIDs
- `apps/web/src/lib/merge-messages.ts:118-143` — `mergeAppend()` dedup logic (handles optimistic but not dual-delivery)
- `docs/notes/2026-03-17-chat-message-duplication-report.md` — Previous analysis documenting the 6 message sources

### Previous Fix (PR #441)
Fixed a different duplication: the ACP+DO merged rendering view was showing the full conversation twice due to broken timestamp/ID dedup. That fix removed the merge and switched to DO-only view after the grace period. The current bug is about server-side data duplication, not rendering duplication.

## Implementation Checklist

- [ ] **Server-side fix**: In `persistMessageBatch()` (`messages.ts`), add content-based dedup for user messages — before inserting a user-role message, check `SELECT id FROM chat_messages WHERE session_id = ? AND role = 'user' AND content = ?`. Skip if found.
- [ ] **Client-side fix**: In `mergeAppend()` (`merge-messages.ts`), add content-based dedup for confirmed user messages — skip incoming user messages that match an existing confirmed user message by role+content. This prevents brief real-time duplication between the two broadcasts.
- [ ] **Tests**: Add unit tests for both fixes:
  - `merge-messages.ts`: test that `mergeAppend` deduplicates confirmed user messages with same content but different IDs
  - `messages.ts`: test that `persistMessageBatch` skips user messages whose content already exists in the session
- [ ] **Regression test**: Add a test that simulates the dual-delivery scenario end-to-end (optimistic → WS confirmed → batch confirmed with different ID)

## Acceptance Criteria

- [ ] Submitting a follow-up message in project chat shows it exactly once
- [ ] User messages are not duplicated in the DO database when sent via both WebSocket and ACP batch
- [ ] Existing merge-messages dedup (optimistic reconciliation) still works correctly
- [ ] The fix handles edge cases: WebSocket closed (only batch path), repeated "yes" messages from different turns

## References

- `docs/notes/2026-03-17-chat-message-duplication-report.md` — Full duplication analysis
- PR #441 (`c5e37f09`) — Previous ACP+DO merge duplication fix
- `.claude/rules/06-technical-patterns.md` — React interaction-effect analysis requirements
