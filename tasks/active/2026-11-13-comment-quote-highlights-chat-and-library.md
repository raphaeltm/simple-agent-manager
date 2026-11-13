# Comment quote highlights in the chat and the library markdown viewer

## Problem

The Comments page reader paints a comment's quoted words (CSS Custom Highlight API,
`pages/comment-reader/quote-highlight.ts`). "Open in chat" lands in the main chat, which only
flashes the whole message for 2.2s (`.sam-message-highlight`) and opens the thread; the quoted
words are never marked. The library markdown viewer never marks commented text either, and a
library comment opened from the Comments page opens the file but not its thread.

Wanted (Raphaël, 2026-11-13):

1. Following a comment into the chat highlights its quoted words.
2. Library markdown files highlight commented text.
3. Commented text is highlighted by default in both places; clicking a highlight opens the
   comment sidebar focused on that comment.

Decisions: only **open** comments get the default (faint blue `sam-comment-quote-other`)
highlight; a resolved comment is painted only when it is the focused one. When highlights
overlap, a click opens the message's threads with the newest open one focused. Web-only change;
staging verification skipped by explicit instruction.

## Research findings

- `apps/web/src/pages/comment-reader/quote-highlight.ts`: `findTextRange` (whitespace-tolerant
  quote match with leading-words fallback), `useQuoteHighlights` (registers two global
  highlight names, deletes them on cleanup), `scrollBoxIntoView`, `boxPlacement`.
  Tests: `tests/unit/pages/comment-reader-quote.test.ts`.
- `CSS.highlights` is one document-wide registry keyed by name. A library preview opens over a
  chat (`SessionLinkedWorkDrawer` → `LibraryFilePreview`), so two surfaces registering the same
  names would overwrite and delete each other's ranges → need a per-surface registry.
- Main chat: `SessionMessageView.tsx` (497 lines — must not grow) wires
  `useProjectMessageCommentUi` (has `chatLogRef`, comments, `focusedCommentId`,
  `activeMessageId`, deep-link focus latch, `onSelectMessageComments`). Messages render inside
  `[data-comment-anchor=<itemId>]` (`CommentableConversationItem.tsx`). List is react-virtuoso:
  rows mount/unmount and streaming text rewrites nodes → re-find ranges on DOM mutation.
- Deep link jump (`useConversationJump.ts`) centers the row; long messages can leave the quote
  off-screen → reveal the active quote when focus changes.
- Library: `FilePreviewModal.tsx` renders markdown in `[data-comment-anchor=<fileId>]`
  (`FilePreviewContent.tsx:186`); comments load only inside `FileCommentPanel`
  (`useLibraryFileComments`), i.e. only when the panel is open. `CommentThreadList` already
  supports `focusedCommentId`.
- Comments page library rows navigate to `/library?preview=<fileId>` only
  (`pages/ProjectComments.tsx:63`); `ProjectLibrary.tsx` reads `preview`.
- Highlights are not elements → click/hover need hit-testing against range client rects.

## Implementation checklist

- [ ] Move `quote-highlight.ts` to `components/project-message-view/comments/` (shared); reader
      imports updated; test file moved.
- [ ] Per-surface highlight registry (union of all mounted surfaces under the two CSS names).
- [ ] `useQuoteHighlights` options: item attribute (`readerItem` / `commentAnchor`), observe DOM
      mutations (rAF-debounced), reveal-on-focus window; returns painted ranges.
- [ ] Hit-testing + `useQuoteHighlightClicks` (click opens, pointer cursor on hover, ignores
      drags/selection and clicks on interactive elements).
- [ ] Chat: paint focused thread strongly (while its surface is open) and other open quoted
      threads faintly; click → `onSelectMessageComments(messageId, newestOpenHitThreadId)`;
      reveal the focused quote after deep link / rail selection.
- [ ] Reader: faint highlights only for open comments (same rule).
- [ ] Library: lift `useLibraryFileComments` into `FilePreviewModal` (enabled for markdown or
      when the panel is open); paint in rendered markdown; click opens panel + focuses thread.
- [ ] Library deep link: `?preview=<fileId>&commentThread=<id>` from the Comments page; modal
      opens the panel focused and reveals the quote; closing the preview drops both params.
- [ ] CSS: pointer cursor while hovering a highlight; comments in `index.css` updated.
- [ ] Tests: registry, hit-testing, chat click/paint behavior, library click/deep link.
- [ ] Playwright visual audit: chat + library, mobile 375 + desktop 1280.
- [ ] Docs: public docs mention of comment highlighting updated if present.

## Acceptance criteria

- [ ] "Open in chat" from the reader shows the quoted words strongly highlighted in the chat.
- [ ] Open quoted comments are faintly highlighted in the chat by default; resolved are not.
- [ ] Clicking a chat highlight opens the comment rail (desktop) / inline thread (mobile)
      focused on the newest open thread under the click.
- [ ] Library markdown files highlight open quoted comments; clicking opens the panel focused.
- [ ] Opening a library comment from the Comments page opens the file with the thread focused.
- [ ] A library preview opened over a chat doesn't erase the chat's highlights (registry test).
