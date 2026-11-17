# Inbox task chat card shows "Question for you"

## Problem

When an agent assigns a task to a person (`inbox_write` method `assign`), the tool result carries an
`inboxItem` ref (`apps/api/src/routes/mcp/inbox-tools.ts`), so the chat renders it as an
`InboxItemCard`. The card heading is hard-coded to review-or-question
(`apps/web/src/components/project-message-view/tool-cards/InboxItemCard.tsx`:
`item.kind === 'review' ? 'Review requested' : 'Question for you'`), and the open badge reads
**Needs your answer**. A task therefore appears in the chat as a question with no way to answer it.

## Context

Found 2026-11-17 while documenting Inbox tasks for people (#2818) in the weekly docs update.

## Acceptance Criteria

- [ ] A `task` item renders a Task heading (for example **Task for a person**) and a status badge that
      fits a task (open, taken, done), not **Needs your answer**
- [ ] Chat card test covers question, review and task kinds
- [ ] Docs (`guides/chat-features.md`, "When the Agent Needs You") mention the task card
