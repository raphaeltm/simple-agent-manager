# Library File Preview Modal

## Problem

Library files can only be downloaded — there's no way to preview images or PDFs without downloading them first. Users want to quickly preview files directly in the UI.

## Research Findings

### Existing Infrastructure
- **Download endpoint** (`GET /api/projects/:projectId/library/:fileId/download`): Decrypts R2 files and serves them with `Content-Disposition: attachment` — forces download, can't be used for inline preview
- **ImageViewer component** (`apps/web/src/components/shared-file-viewer/ImageViewer.tsx`): Already handles image rendering with size-based guardrails (inline < 10MB, click-to-load < 50MB, download-only > 50MB)
- **ConfirmDialog** (`apps/web/src/components/ConfirmDialog.tsx`): Established modal pattern with backdrop, escape key, focus trap, body scroll prevention
- **File utils** (`apps/web/src/lib/file-utils.ts`): `isImageFile()` helper, `formatFileSize()`, configurable size thresholds
- **Library types** (`apps/web/src/components/library/types.tsx`): `FileWithTags`, `getFileIcon()`, `FOCUS_RING`

### Key Design Decisions
1. **New API endpoint needed**: Current download endpoint forces attachment disposition. Need a `/preview` endpoint that serves with `Content-Disposition: inline` for safe MIME types only
2. **Reuse ImageViewer**: The existing component already handles all image preview concerns
3. **PDF via iframe**: Browser-native PDF rendering via `<iframe>` element
4. **Modal pattern**: Follow ConfirmDialog's modal pattern (fixed overlay, escape key, backdrop click, focus trap)
5. **Security**: Only allow safe MIME types for inline preview (images, PDF). SVG served as image/svg+xml is safe in `<img>` tags but NOT in iframes — use ImageViewer for SVGs

### Files to Modify
- `apps/api/src/routes/library.ts` — add preview endpoint
- `apps/web/src/lib/api/library.ts` — add preview URL builder
- `apps/web/src/lib/file-utils.ts` — add `isPreviewableFile()` and `isPdfFile()` helpers
- `apps/web/src/components/library/FilePreviewModal.tsx` — new preview modal component
- `apps/web/src/components/library/FileActionsMenu.tsx` — add Preview action
- `apps/web/src/components/library/FileListItem.tsx` — add preview callback, make clickable
- `apps/web/src/components/library/FileGridCard.tsx` — add preview callback, make thumbnail clickable
- `apps/web/src/components/library/types.tsx` — add preview-related helpers
- `apps/web/src/pages/ProjectLibrary.tsx` — wire up preview state

## Implementation Checklist

- [ ] **API: Add preview endpoint** — `GET /:fileId/preview` that decrypts and serves with `Content-Disposition: inline` for allowed MIME types (images, PDF). Reject other types with 400.
- [ ] **Client: Add preview URL builder** — `getLibraryFilePreviewUrl(projectId, fileId)` returning the endpoint URL
- [ ] **Utils: Add preview helpers** — `isPreviewableFile(filename, mimeType)` and `isPdfFile(filename)` in file-utils
- [ ] **Component: FilePreviewModal** — Modal with ImageViewer for images, iframe for PDFs. Header with filename, size, download button, close button. Escape key, backdrop click, body scroll prevention.
- [ ] **Component: Update FileActionsMenu** — Add "Preview" action for previewable files
- [ ] **Component: Update FileListItem** — Add `onPreview` callback, make filename clickable for previewable files
- [ ] **Component: Update FileGridCard** — Add `onPreview` callback, make thumbnail area clickable for previewable files
- [ ] **Page: Wire up ProjectLibrary** — Add preview state, pass callbacks, render FilePreviewModal
- [ ] **Tests: Add unit tests** — Preview endpoint, preview helpers, modal component behavior

## Acceptance Criteria

- [ ] Clicking a previewable file (image/PDF) opens a modal showing the file content
- [ ] Images render using the existing ImageViewer component with size guardrails
- [ ] PDFs render in an iframe with native browser PDF viewer
- [ ] Modal has close button, escape key closes, backdrop click closes
- [ ] Modal shows filename and file size in header
- [ ] Download button available in preview modal header
- [ ] Non-previewable files don't show preview option
- [ ] Preview action available in both list and grid views
- [ ] Large files (> 50MB) show download-only message
