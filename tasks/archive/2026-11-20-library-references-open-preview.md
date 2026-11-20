# Library references open a preview in place

Task: 01M7W6WBJWCDNRF9KWSGCCQJNK · Branch: `sam/library-references-open-preview-ccqjnk`

## Problem

Raphaël, 2026-11-20: clicking a reference to a Library file should show a preview without
redirecting to the Library; closing it must return to where the person was (the inbox, not the
Library). Today `linkTarget()` (`components/inbox/inbox-model.ts`) and other references build
`projectLibraryFilePath(...)` and navigate to the Library page.

## Research findings

- The Library already has an id-based viewer: `LibraryFilePreview` (metadata via
  `libraryFileQueryOptions`, then `FilePreviewModal`). Reuse it; no second viewer.
- Call sites that navigate to the Library for a file reference:
  1. `components/inbox/InboxItemView.tsx` `InboxLinkChips` via `linkTarget()` — used by the inbox
     page item view (also reached from Overview "Needs you") and the chat `InboxItemCard`.
  2. `pages/ideas/idea-sections.tsx` Related files (`LinkedWorkRow to=`).
  3. `pages/ProjectComments.tsx` file comment threads (`navigate(projectLibraryFilePath(..., thread))`).
  4. `pages/automation/workflows/links.ts` `libraryFilePath` (duplicate of `projectLibraryFilePath`)
     rendered in workflow step outputs (`ui.tsx`).
  5. `components/MarkdownRenderer.tsx` `a`: in-app Library links in chat/inbox markdown did a full
     page load.
- Already in place: `DocumentCard` (chat library cards), `SessionLinkedWorkDrawer` (chat Related panel).
- Inbox quick view rows render no link chips today (`InboxRow`), so nothing to convert there.
- `useInboxWalk` and `InboxPage` read `location.state`; the preview must keep existing state.

## Design

One app-level `LibraryPreviewProvider` (inside the router) owns the preview. Opening pushes a
history entry at the same URL with `state.libraryPreview`, so phone Back closes it and the page
underneath never remounts. Closing goes back one entry. Desktop shows the viewer as a framed
`.sam-glass-live` overlay over a scrim; phones keep the full-screen viewer. The viewer gains an
"Open in Library" action.

## Checklist

- [x] Provider + `useLibraryPreview()` + `LibraryFileLink`
- [x] `FilePreviewModal`/`LibraryFilePreview`: overlay presentation on desktop, Open in Library
- [x] Convert call sites 1-5; remove duplicate `libraryFilePath`
- [x] Unit tests: chip click opens preview, URL path unchanged, close returns focus to chip, inbox still rendered; Back closes
- [x] Playwright audit at 375/1280: long filename, large image, PDF, unsupported type
- [x] Docs sync (user docs mentioning library links)
- [ ] Staging: real inbox item linking a real Library file

## Acceptance criteria

- Clicking a Library reference in the inbox page, chat inbox card, idea Related, comments page,
  workflow outputs and markdown links opens the preview over the current screen.
- x, Escape and Back close it; the URL path never becomes the Library; focus returns to the opener.
- "Open in Library" inside the preview goes to the Library file.
- Unpreviewable files show a download option.

## Review notes

- task-completion-validator: no CRITICAL/HIGH. Addressed: checklist ticked, docs paragraph fixed,
  Playwright now asserts scroll position + half-typed answer survive, `.sam-glass-live` on the
  desktop overlay, 44px header controls. Not changed: the chat Related drawer keeps its own local
  preview (already in place before this change; its focus trap coordinates with it), so Back does
  not close that one.
- ui-ux-specialist: HIGH light theme -> light screenshots added at 375/1280. MEDIUM fixed: shared
  `useDialogFocusTrap` (recaptures stray focus, topmost-only), Escape never discards a typed
  comment and closes the comments panel first, phone header gets a second row, segmented control
  sized to labels ("Rendered" no longer cut), `useId` title. Not changed: the shared
  SegmentedControl `lg` height (40px) is pre-existing and used app-wide.
