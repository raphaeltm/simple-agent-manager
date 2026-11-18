# Read a chat comment in its conversation (Comments page reader)

## Problem

Opening a chat comment from the project Comments page navigates into the live chat and
"hopes for the best" (Raphaël, 2026-10-23). The jump is hit or miss, the thread is not
opened, and nothing marks which words the comment is about. Raphaël approved prototype
Direction A ("Reader + thread", branch `sam/thorough-audit-commenting-uiux-w7d0g9`,
`apps/web/src/pages/comment-context-prototype/`) and asked for it to be built, made green,
and deployed to production.

Direction A: opening a chat comment shows the agent conversation around it, opened on the
exact quoted passage (highlighted), with the thread beside it on desktop or in a bottom
sheet on a phone. You can scroll earlier and later (more loads at the edges), get back to
the passage with one tap, step to the previous/next comment, and open the real chat at the
right place.

## Research findings

Why today's jump is unreliable (code reading, audit 2026-10-23):

1. `ProjectComments.tsx` links with `commentAt = thread.createdAt` (the comment's time), and
   `useConversationJump` falls back to "the message nearest that time" when the id does not
   resolve. A comment written hours after its message lands hours later in the chat.
2. The Comments page link has no `commentThread`, so the thread is not opened.
3. The jump centres the whole message (`align: 'center'`) and flashes it for 2.2 s; in a
   long agent message the quoted passage can be off screen and nothing marks it.
4. An agent message is many stored rows (one per streamed ACP chunk,
   `vm-agent/internal/acp/message_extract.go`; no coalescing in `persistMessageBatch`).
   `chatMessagesToConversationItems` merges consecutive `assistant` / `thinking` rows and
   keeps the first loaded row's id. An anchor on a later chunk (MCP-created comments, or a
   page boundary when the comment was made) never resolves: only tool-call `messageId`s are
   aliased in `useConversationJump`.
5. Comment notifications link with `commentThread` + `commentMessage` and no time, so the
   jump uses `Date.now()` and falls back to the bottom of the conversation for any message
   that is not on the newest page.

Server facts:

- Threads live in the project root ProjectData DO (`comments.ts`); `getCommentThread(sql,
sessionId, threadId)` is scoped by session. Comments cannot be created on an archived
  session, but a commented session can be archived later, so messages must be read through
  the archive-aware owner (`resolveExactReadOwnerIfArchiveEnabled`; root source, archive
  target, or compact archive target backed by R2 chunks).
- Existing owner-aware page reads: `archiveSourceReadMessages` / `archiveTargetReadMessages`
  (cursor pages, compact mode). Compact archives expose `compactRawMessage` (by id) and
  `compactRawPage`.
- Message cursors are exact `(createdAt, sequence, id)` exclusive bounds.
- `GET /sessions/:sessionId/messages` already pages with `before`/`after` cursors and
  `order`; the reader pages through it.
- Session reads require project membership; comment reads require `task:read`. Send to agent
  is for the session owner and grantees (`getSessionAccess`).
- New tunables go in the admin settings registry (`.claude/rules/07`, `quality:runtime-tunables`),
  Collaboration category.
- I/O budget (rule 60): read-only GET ≤ 8 round trips.

## Design

Server: `GET /api/projects/:projectId/sessions/:sessionId/comments/:threadId/context` returns
the thread, the viewer's session access, the session topic, and a window of stored messages
around the anchored message, read in one RPC to the transcript owner:

- The window is counted in **display messages**, not rows: a run of consecutive `assistant`
  rows (or `thinking` rows) is one message, every other row is one. It includes the whole
  anchored message (run start before the anchor and the rest of the run after it), then
  `collaboration.commentContextMessages` messages each side, never more than
  `collaboration.commentContextMaxRows` rows per side, and says whether more exists either way.
- Missing anchor (message gone) returns `anchor.found = false` and no messages.

Web: new route `/projects/:projectId/comments/:sessionId/:threadId` (reader). Comments page
chat rows open it. Notifications open it too. The reader:

- renders with the production chat renderer (`chatMessagesToConversationItems` →
  `groupToolCallItems` → `AcpConversationItemView`);
- maps any stored row id to the item it was merged into (shared helper, also used by the
  chat's jump), finds the quote as a DOM `Range`, paints it with the CSS Custom Highlight API,
  and scrolls the passage (not the message) into view;
- loads earlier/later pages at the edges (TanStack infinite query over the context page plus
  `/messages` pages), keeps the view still when older content is prepended;
- shows "Back to the comment" when the passage is off screen;
- desktop: thread panel (380 px) beside the conversation; phone: bottom sheet with a peek;
  the real `CommentThread` (reply / resolve / reopen / send to agent via `useMessageComments`);
- header: chat topic, "n of N" with previous/next over the inbox order, "Open in chat" with
  `commentThread`, `commentMessage` and the anchored message's own time;
- if the quote cannot be found, says so and highlights the whole message.

## Implementation checklist

### Server

- [x] Shared type `MessageCommentContextResponse` (`packages/shared/src/types/comments.ts`)
- [x] Admin settings `collaboration.commentContextMessages` (default 6, 1–50) and
      `collaboration.commentContextMaxRows` (default 1,000, 50–5,000) + getters
- [x] DO module `project-data/message-context.ts`: run-aware window over an owner reader;
      source + target (incl. compact) locate; exported guards in archive-sharding
- [x] DO RPCs `archiveSourceGetMessageContext` / `archiveTargetGetMessageContext`
- [x] Service `getMessageContextWindow` (owner resolved once)
- [x] Route `GET /:sessionId/comments/:threadId/context` (task:read, session + thread in
      parallel, thread/session cross-check, 404s, response)
- [x] Notification action URL opens the reader
- [x] Tests: window algorithm on real SQLite (mid-run anchor, run start, units each side,
      row cap, missing anchor, cursor ties); target + compact archive path (workers);
      route vertical slice with cross-session and cross-project attacks + owner controls

### Web

- [x] `message-aliases.ts` helper (row id → merged item id) + tests
- [x] Chat jump registers merged-row aliases (fixes cause 4) + test
- [x] Reader data hook (TanStack infinite query, both directions) + API client
- [x] Quote highlight module + global `::highlight` styles
- [x] Reader page: conversation, landing, edge loading, back-to-comment pill, comment chips
- [x] Thread panel (desktop) / sheet (phone) with the real `CommentThread`
- [x] Header: topic, n of N, prev/next, Open in chat (correct time + thread)
- [x] Route + lazy import in `App.tsx`; Comments page rows open the reader
- [x] Unit/behaviour tests (landing target, nav, open-in-chat href, not-found state)
- [x] Playwright visual audit 375 / 1280 (normal, long, not found, many, error, sheet)

### Docs

- [x] `apps/www/src/content/docs/docs/guides/collaboration.md` — reading a comment in context
- [x] `apps/www/src/content/docs/docs/guides/admin-settings.md` — two new settings
- [x] `apps/www/src/content/docs/docs/guides/notifications.md`, `reference/api.md`,
      `recent-product-changes.md`, and `.claude/skills/api-reference/SKILL.md`

## Acceptance criteria

- [x] From the Comments page, opening a chat comment lands on the conversation with the
      quoted passage highlighted and on screen (mobile and desktop). Staging 2026-10-24 02:17Z,
      desktop and phone; Playwright audit; `comment-reader.test.tsx`
- [x] An anchor on a later streamed chunk of an agent message still lands on that message.
      Staging anchor: 4th row of a 14-row reply; DO window tests; chat chunk-jump test
- [x] The thread is visible beside the conversation (desktop) / in a sheet (phone), and
      reply, resolve, reopen and send to agent work from there. Staging: panel, reply, phone
      sheet. Resolve, reopen and send are covered in `comment-reader.test.tsx`
- [x] Scrolling up/down loads earlier/later messages without jumping; "Back to the comment"
      returns to the passage. Staging: earlier 0.2 px, later 0 px, back on screen; audits hold
      the page response and measure mid-load
- [x] Previous/next comment works in inbox order (`comment-reader-model.test.ts`,
      `comment-reader.test.tsx`; staging header shows the position)
- [x] "Open in chat" opens the chat with the thread focused at the right message. Staging:
      desktop thread open and message on screen; phone message on screen. The phone failure-banner
      overlap is pre-existing, see backlog `2026-10-24-chat-comment-link-under-failure-banner-on-phones.md`
- [x] A comment whose message is gone shows the stored quote and a clear message, no error
      (vertical slice, `comment-reader.test.tsx`, Playwright "message gone")
- [x] Cross-session and cross-project thread ids return 404 with no data (vertical slice
      attack + owner-control pairs; DO cross-session test)
- [x] Works for archived (sharded) sessions: Workers-runtime tests compare the window across
      root, compact archive and copied-back storage. Sessions with comments are never archived
      today

## Implementation notes

- 2026-10-23: direct push of the task file to `main` is rejected by repository rules; the task
  file lives on the feature branch.
- Sessions with message comments are never archived (`archive-sharding.ts` refuses them with
  `message_comments_present` to avoid cascade deletion), so the reader normally reads the root
  object. The owner-aware read is kept so it matches `getMessages` and survives a policy change.
- `comment_threads.message_id` cascades on message delete, so "anchored message gone" needs a
  row removed without foreign keys; the endpoint still answers it with `anchor.found = false`.
- Compact-mode default consolidated into `getDefaultCompactMode` (three call sites).
- Discrimination checks: emptying `MERGED_ROLES` reddens 4 window tests; dropping the session
  predicate from the anchor lookup reddens exactly the cross-session test; removing the chat's
  `messageAliases` reddens the chunk-anchor jump test (a notification link with no time); keying
  the reader's conversation on the breakpoint reddens the identity test.
- With a correct `commentAt` the chat's time fallback already lands on the merged reply (last item
  at or before the time), so aliases matter for links without a time (old notifications).
- Playwright audit (375/1280): 23 pass, 1 skipped by design (sheet test on desktop). Fixed from the
  screenshots: notice hidden under the header (native scroll anchoring → `overflow-anchor: none`,
  land on the whole row), words half under the sheet counted as visible (≥24px rule), chip wall
  with 35 comments (fold into "+N more").
- Notifications now link to the reader (`buildCommentActionUrl`); API reference, notifications
  guide, collaboration guide and admin settings guide updated.

- Staging run 1 (3c067ba9e, 01:44Z): all checks passed except loading later messages moved the
  view 8 px. The loading row was 8 px shorter than the button, and the scroll position is clamped
  at the end of the conversation. Edge rows now share one height (a7e6060ae), and the audits hold
  the page response and measure mid-load: red with exactly 8 px without the fix. The run also
  showed a finished tool call as running: the window ended on the first of a parallel pair of
  tool calls. Runs of tool rows are now never cut (f82042d63); the tool-run test is red without it.
- Staging is shared through a claim queue on the `feature.linked-work` channel ("STAGING CLAIM
  <item> <branch>" / "STAGING RELEASE <item>"). My first two deploys were unclaimed; run 3 was
  claimed (seq 113), verified and released (seq 121). Check the channel before any staging deploy.
- Staging run 3 (f82042d63, 02:17Z): every feature check passed. The only errors were 404s from
  the chat page retrying a deleted workspace. That is pre-existing, filed as
  `tasks/backlog/2026-10-24-chat-retries-deleted-workspace.md` (consolidated 2026-10-26 into
  `tasks/backlog/2026-09-08-ended-chat-requests-deleted-workspace.md`).
- Rebased onto main `a3404a848` (idea updates): registry and RPC overlaps were additive, and the
  registry count is now 76.

## References

- Prototype: branch `sam/thorough-audit-commenting-uiux-w7d0g9`, commit `1eddd08ff`
- `.claude/rules/62`, `.claude/rules/60`, `apps/web/.claude/rules/17`, `48`, `56`, `64`
- `apps/api/.claude/rules/63`, `65`, `50`, `69` (harness ceilings), `.claude/rules/28`, `11`
