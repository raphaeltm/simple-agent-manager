# Inbox replies: web UI (item as a conversation, real chat composer)

Task 01M7WSNZ827P7DQ0E3J2CS2NFN. Design: Library 01M7W3TNVT4E947G9622FQTNHS, idea 01M7N16AF5HDPH1ZND4D4RJ00J.
Backend: PR #2940 (8f6031244). Channel `feature.inbox-replies`.

## Problem
Typed text on an inbox item can only close it as an answer. The backend now accepts replies that
go to the agent's chat (`POST …/inbox/items/:ref/reply`) and returns the agent's responses in the
item detail `conversation`. The web app has no UI for it.

## Research findings
- Item view: `pages/inbox/InboxPage.tsx` (`ItemPane`), body `components/inbox/InboxItemView.tsx`,
  controls `components/inbox/InboxAnswerControls.tsx` (pinned at the bottom today), walk
  `components/inbox/useInboxWalk.ts`.
- Free-text paths to remove: `AcknowledgeControls` Reply form (reviews/results), and the
  "type a different answer" (`allowCustom`) path of `AttentionAnswerControls` for option/text
  questions. `canReplyToAgent` becomes dead.
- Chat composer: `ProjectChatComposer` + `useAttachments` (same as `FollowUpInput` / Overview box).
- Conversation pages: replies cursor goes to EARLIER chat history; responses cursor goes to LATER
  anchored responses (`apps/api/src/services/inbox/reply-context.ts`). Advance only non-null cursors.
- Reply `content` is the chat display content and carries an "## Attached Files" block when files
  are attached; the inbox view must show attachments as chips instead.
- Walk stale-check closes any item whose status is not `open`: it would close a settled rejected
  permission (`status: done`, `canReply: true`). Must keep it open.
- Transcript metadata carries `inboxRef` only, not the item title; the "Re:" chip needs a title.
  Smallest fix: add `inboxTitle` to the delivery metadata in `send-chat.ts` (snapshot at reply time),
  fall back to "an inbox item" for rows without it.
- Sibling PR #2941 (open) edits `InboxItemView.tsx` (InboxLinkChips) and `inbox-model.ts`
  (linkTarget); keep those regions untouched.

## Checklist
- [ ] API client: `replyToInboxItem`, item read with `replyCursor`/`responseCursor`
- [ ] API: `inboxTitle` in inbox reply delivery metadata (+ test)
- [ ] Conversation model (merge pages, timeline, attachment-block stripping, row hint) + unit tests
- [ ] `useInboxConversation` (TanStack infinite query for older/later pages)
- [ ] Item view as conversation: ask as agent's first message, replies + responses in time order,
      controls on the latest agent turn, load-more
- [ ] Reply composer (ProjectChatComposer + attachments) pinned at bottom, only when `canReply`;
      permission decline notice
- [ ] Receipt + leave list (needs_you) / stay (archived); invalidate inbox queries; no reload
- [ ] Remove Reply form / free-text answer; remove `canReplyToAgent`
- [ ] Walk: settled permission with canReply stays open
- [ ] Row preview from `latestReply`/`withAgent`; Archived "With the agent" label
- [ ] "Re:" chip on inbox-reply user messages in the project chat, opens the item
- [ ] Docs: `apps/www/src/content/docs/docs/guides/inbox.md`
- [ ] Tests driving the real reply → refetch path (rule 62)
- [ ] Playwright audit 375/1280 with diverse data
- [ ] Staging: real reply to a real agent item end to end

## Acceptance criteria
- Opening an item shows the ask as the agent's first message, then replies and responses in order.
- Sending a reply with the chat composer (text + attachment) POSTs `/reply`, shows a receipt, the
  item leaves Needs you without a page reload.
- A pending permission says sending declines it; a settled one shows its conversation, no buttons,
  and can still be replied to.
- Rows show who replied / agent responded; Archived shows "With the agent".
- Project chat shows a "Re: <title>" chip on inbox replies that opens the item.
