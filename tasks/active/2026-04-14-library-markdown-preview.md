# Library Markdown File Preview

## Problem

Users can upload markdown files to the project library but cannot preview them inline. Clicking on a markdown file does not offer a preview — only download. The app already has a mature `RenderedMarkdown` component with full GFM, Mermaid diagram, and syntax highlighting support (used in ChatFilePanel, FileViewerPanel, and IdeaDetailPage). The library preview modal just needs to be wired up to use it.

## Research Findings

### Current State
- `FilePreviewModal` supports images (via `ImageViewer`) and PDFs (via sandboxed iframe)
- `isPreviewableMime()` in `file-utils.ts` only includes image MIMEs + `application/pdf`
- The API preview endpoint (`GET /:fileId/preview`) has its own `PREVIEWABLE_MIMES` set that also excludes markdown
- `RenderedMarkdown` component fully supports GFM tables, Mermaid diagrams, syntax-highlighted code blocks
- Markdown files get MIME type `text/markdown` from browser upload

### Key Files
- `apps/web/src/lib/file-utils.ts` — MIME type detection functions
- `apps/web/src/components/library/FilePreviewModal.tsx` — preview modal (needs markdown rendering)
- `apps/web/src/components/library/FileListItem.tsx` — uses `isPreviewableMime` for clickable names
- `apps/web/src/components/library/FileGridCard.tsx` — uses `isPreviewableMime` for clickable cards
- `apps/web/src/components/library/FileActionsMenu.tsx` — uses `isPreviewableMime` for preview menu item
- `apps/web/src/components/MarkdownRenderer.tsx` — existing `RenderedMarkdown` component
- `apps/api/src/routes/library.ts` — API preview endpoint (line ~278, PREVIEWABLE_MIMES set)
- `apps/web/src/lib/api/library.ts` — `getLibraryFilePreviewUrl()` returns preview URL

### Architecture Decision
For markdown, unlike images/PDFs which render from a URL, we need to:
1. Fetch the file content as text from the preview endpoint
2. Render it using `RenderedMarkdown` in React
3. Provide a rendered/source toggle (matching the pattern in ChatFilePanel)

## Implementation Checklist

- [ ] Add `text/markdown` to `PREVIEWABLE_MIMES` in `apps/api/src/routes/library.ts`
- [ ] Add `isMarkdownMime()` function and add markdown to `PREVIEWABLE_MIMES` in `apps/web/src/lib/file-utils.ts`
- [ ] Update `FilePreviewModal` to:
  - Detect markdown files via `isMarkdownMime()`
  - Fetch content as text from the preview URL
  - Render with `RenderedMarkdown` component
  - Add rendered/source toggle button
  - Handle loading and error states
- [ ] Add unit tests for new `isMarkdownMime()` function
- [ ] Add behavioral test for FilePreviewModal markdown rendering

## Acceptance Criteria

- [ ] Markdown files in the library show as previewable (clickable name, preview in actions menu)
- [ ] Clicking a markdown file opens the preview modal with properly rendered markdown
- [ ] GFM tables render correctly
- [ ] Mermaid diagrams render as SVG
- [ ] Syntax-highlighted code blocks render properly
- [ ] User can toggle between rendered and source view
- [ ] Loading state shown while content fetches
- [ ] Error state shown if fetch fails
- [ ] No regressions to image or PDF preview
