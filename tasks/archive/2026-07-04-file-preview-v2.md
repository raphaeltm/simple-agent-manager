# File Preview v2

## Problem

Project library previews need a stronger full-screen experience and safe support for generated HTML files. The current preview modal is constrained in a centered floating panel, HTML files are not previewable, and mobile image viewing uses an overflow-based actual-size mode without pinch or pan gestures.

## Research Findings

- Idea `01KWQE2VGCWT8FNWTQ0696PYPC` defines the implementation plan and security invariant: API preview may allow `text/html` only when served as inert `text/plain` with CSP `default-src 'none'`; client rendering must use `iframe srcdoc` with sandbox exactly `allow-scripts`.
- `apps/web/src/components/library/FilePreviewModal.tsx` owns the modal shell, focus trap, Escape handling, scroll lock, and preview branches for image, PDF, markdown, and unsupported files.
- `apps/web/src/components/shared-file-viewer/ImageViewer.tsx` owns image size guardrails and current fit/1:1 behavior.
- `apps/web/src/components/project-message-view/tool-cards/DocumentCard.tsx` owns chat timeline previews and must never inline-render HTML.
- `apps/web/src/lib/file-utils.ts` and `apps/api/src/routes/library.ts` maintain synchronized preview MIME allowlists.
- Related backlog `tasks/backlog/2026-07-03-harden-markdown-preview-sanitization.md` must not regress.
- UI changes require Playwright visual audit under `.claude/rules/17-ui-visual-testing.md`.

## Checklist

- [x] Convert `FilePreviewModal` to an edge-to-edge `100dvh` fullscreen surface with safe-area-aware header/footer padding while preserving focus trap, Escape, scroll lock, portal, filename, size, download, and close controls.
- [x] Add backend HTML preview allowlist support in `apps/api/src/routes/library.ts` while returning HTML previews as `text/plain; charset=utf-8` with CSP `default-src 'none'`, without changing download dangerous MIME rewrites.
- [x] Add regression coverage proving HTML preview responses are never `text/html` and keep non-allowlisted MIME previews blocked.
- [x] Add frontend HTML MIME helpers and render HTML in the modal through a credentialed text fetch, Rendered/Source toggle, `iframe srcdoc`, and sandbox exactly `allow-scripts`.
- [x] Ensure `DocumentCard` keeps HTML files on the icon tier with an `Interactive · tap to open` hint and no inline HTML rendering.
- [x] Replace image overflow actual-size mode with transform-based pinch zoom, pan, and double-tap gestures while preserving desktop click zoom, Actual size control, guardrails, and metadata.
- [x] Add unit/behavior tests for iframe sandbox/srcdoc, HTML source toggle, DocumentCard behavior, and image zoom transitions.
- [x] Update API contract docs if the preview response contract changes.
- [x] Run local Playwright visual audits at 375x667 and 1280x800 for image, markdown, PDF, and HTML modal content with overflow assertions.
- [x] Run security review for API HTML handling and iframe sandbox.
- [x] Deploy and verify on staging: interactive HTML from a DocumentCard runs in sandbox without session cookie access, and mobile pinch zoom works.

## Acceptance Criteria

- HTML library files can be opened from the preview modal without executing on the API origin.
- The preview endpoint never serves HTML previews as `text/html`.
- The modal fills the viewport edge-to-edge on mobile and desktop without horizontal overflow.
- Images support usable mobile pinch zoom/pan and desktop zoom controls without regressing large-file guardrails.
- Chat timeline cards do not render HTML inline.
- Tests, visual audit, local reviews, staging verification, and PR link the markdown sanitization backlog item.

## References

- Idea `01KWQE2VGCWT8FNWTQ0696PYPC`
- `tasks/archive/2026-07-03-typed-tool-call-cards-document-card.md`
- `tasks/backlog/2026-07-03-harden-markdown-preview-sanitization.md`
- `.claude/rules/17-ui-visual-testing.md`
