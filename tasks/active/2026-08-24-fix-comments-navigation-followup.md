# Fix comments navigation follow-up defects

## Problem

The production comments rollout shipped with two user-visible failures:

1. On mobile, opening comments from the top chat-session control renders the comments UI in a bad floating/off-screen position and can overflow past the right edge.
2. The project-level Comments page navigates to comment sources but does not actually reveal the target:
   - Library-file comments navigate to the Library page without opening the file.
   - Chat-message comments navigate to the session without opening/revealing the annotated message.

Raphaël explicitly requested fixing these and getting them to production without staging verification for this follow-up because the flow is cumbersome to reproduce on staging. Use local screenshot-backed validation, CI, merge, and production deploy monitoring.

## Research findings

- `apps/web/src/pages/ProjectComments.tsx` currently routes library-file comments to `/projects/:projectId/library?file=:fileId`, but `ProjectLibrary` reads `?preview=:fileId` to open `FilePreviewModal`.
- `ProjectComments` routes session comments to `/projects/:projectId/chat/:sessionId` without any message target in the URL.
- `apps/web/src/components/project-message-view/index.tsx` already has robust internal jump/highlight logic (`handleTimelineJump`, `pendingJump`, `scrollAndHighlight`) used by the timeline and session comments drawer, including the Virtuoso zero-based coordinate fix. It needs a URL-driven entry point.
- `apps/web/src/pages/project-chat/index.tsx` already parses and clears URL parameters for attention-answer flows, so query-param driven actions are an existing pattern.
- `apps/web/src/components/chat/SessionCommentsDrawer.tsx` renders as a native `<dialog>` with fixed positioning and desktop right-rail behavior. Its mobile geometry should be full-viewport and bounded at narrow widths.
- Existing coverage in `apps/web/tests/playwright/comments-navigation-audit.spec.ts` exercises comments surfaces at mobile and desktop, but does not assert project-comments source deep links open targets or inspect drawer bounding boxes deeply enough to catch clipped fixed children.
- Relevant retained lesson: `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md` warns that document-level overflow checks can miss fixed/absolute descendants clipped or positioned off-screen.

## Implementation checklist

- [x] Change project-comments library navigation to use `preview`.
- [x] Add URL-driven chat-message jump support that consumes a query param, calls the existing jump/highlight path, and removes the param after handling.
- [x] Route project-comments session comments with the target message id.
- [x] Tighten mobile `SessionCommentsDrawer` geometry so it stays within the viewport at 320–375px and does not depend on desktop rail sizing.
- [x] Use Playwright route-level regression coverage rather than isolated unit tests for project-comments navigation URLs and URL-driven message jump behavior, because the defect crosses Project Comments → router → Library/Chat rendering.
- [x] Add/update Playwright audit coverage for:
  - mobile comments drawer bounding box/no off-screen fixed descendants;
  - project Comments → library-file row opens the file preview;
  - project Comments → chat-message row opens the session and highlights/reveals the target message.
- [x] Run local mobile + desktop screenshot-backed validation.
- [x] Skip staging per explicit instruction; document this in the PR.
- [ ] Merge and monitor automatic production deploy.

## Acceptance criteria

- On mobile, the session comments drawer opened from the chat-session top controls fits inside the viewport and has no horizontal overflow or off-screen panel edge.
- Selecting a library-file comment from Project → Comments opens the Library page with that file preview visible.
- Selecting a chat-message comment from Project → Comments opens the correct session and reveals/highlights the annotated message.
- Local tests and Playwright visual audits cover the two broken production paths.
- Staging is not triggered for this task; production deploy is monitored after merge.
