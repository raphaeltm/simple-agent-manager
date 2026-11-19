# On phones, a chat comment link can land the message under the task failure banner

## Problem

On a phone (375x667), a chat link to a comment (`?commentThread=…&commentMessage=…&commentAt=…`, as the comment reader's **Open in chat** builds) can land the commented message under the "Failed · Retryable" banner. In a chat whose task failed, that banner overlays the top of the conversation. The message is on screen, but its first lines are covered, and they can hold the quoted words. The comment thread was not visible in the screenshot either; on desktop it opens in the comments rail.

`useConversationJump` places the message without accounting for overlays at the top of the conversation.

## Context

Seen on staging on 2026-10-24, in the comment reader's live check (branch `sam/comment-context-reader`, screenshot `staging-open-in-chat-375x667.png` on the `evidence/comment-context-reader` branch). The chat was a day-old Potato session whose task had failed. That branch only changed how a jump resolves a streamed-chunk anchor, not where the message lands.

## Acceptance Criteria

- [ ] A comment link on a phone lands the commented message (and quoted words, when present) below any overlay at the top of the conversation.
- [ ] Decide whether a comment link should open the thread on phones (sheet or rail), and make phone and desktop consistent with that decision.
- [ ] A Playwright audit at 375x667 covers a chat with a failed-task banner and asserts the message start is visible, not covered.
