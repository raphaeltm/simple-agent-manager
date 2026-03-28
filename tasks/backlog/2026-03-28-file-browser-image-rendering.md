# File Browser Image Rendering Support

**Created**: 2026-03-28
**Priority**: High
**Effort**: Medium
**Tags**: `ui-change`, `cross-component-change`, `business-logic-change`
**Replaces**: `tasks/backlog/2026-02-22-file-browser-image-rendering.md` (original stub)

## Problem

The file browsing system cannot display images. Binary files (PNG, JPG, GIF, WebP, etc.) either show "Binary file — cannot display" or corrupt during JSON serialization. The entire file content pipeline assumes text — no binary endpoint, no MIME detection, no `<img>` rendering path.

## Research Findings

### Backend (VM Agent)
- **`packages/vm-agent/internal/server/git.go:151-214`** — `handleGitFile()` reads file content via `cat` or `git show`, returns as JSON string (`GitFileResponse{Content, FilePath}`). Binary data corrupts during string conversion.
- **`packages/vm-agent/internal/server/files.go`** — `handleFileList()` returns `FileEntry{Name, Type, Size, ModifiedAt}`. No MIME type in listing.
- **`packages/vm-agent/internal/server/server.go:755-762`** — Route registration. New endpoint needs registering here.
- **`packages/vm-agent/internal/config/config.go:147`** — `GitFileMaxSize` (default 1MB). Need new config for raw file max size.
- Path sanitization in `sanitizeFilePath()` at `git.go:294-323` — reusable for the new endpoint.
- Container resolution via `resolveContainerForWorkspace()` — reusable.
- Worktree support via `resolveWorktreeWorkDir()` — must support in new endpoint.

### API Proxy Layer
- **`apps/api/src/routes/projects/files.ts`** — Proxy routes for session-based file access. Currently only proxies JSON responses. Need new route for raw binary proxy.
- `proxyToVmAgent()` already forwards `Content-Type`, `Content-Length`, `Cache-Control`, `ETag` headers — works for binary passthrough.
- `FILE_PROXY_MAX_RESPONSE_BYTES` default 2MB — need separate/larger limit for image proxy.

### Frontend
- **`apps/web/src/components/FileViewerPanel.tsx:75-78`** — `isBinaryContent()` checks for null bytes, shows "Binary file — cannot display". Need image detection branch.
- **`apps/web/src/components/chat/ChatFilePanel.tsx:402-420`** — View mode renders only `SyntaxHighlightedCode` or `RenderedMarkdown`. Need image rendering branch.
- **`apps/web/src/lib/api.ts`** — `getGitFile()` and `getSessionFileContent()` return `GitFileData{content, filePath}`. Need new API functions for raw file URLs.

### Design Decisions
- **Binary streaming endpoint** (not base64) — matches GitHub/GitLab/VS Code pattern
- **Extension-based image detection** — reliable for common formats, no magic-number needed for v1
- **`<img src>` rendering** — direct URL as src, browser handles decoding
- **SVG via `<img>` tag** — blocks scripts per HTML spec, safe without sanitization
- **Click-to-toggle zoom** — fit-to-panel (default) vs 1:1 actual size
- **Caching** — `Cache-Control: no-cache` + ETag from mtime+size (active workspaces are being edited)

## Implementation Checklist

### 1. VM Agent: Raw file endpoint
- [ ] Add `handleFileRaw()` in `packages/vm-agent/internal/server/files.go`
  - Route: `GET /workspaces/{workspaceId}/files/raw?path=...`
  - Read file via `docker exec cat` with binary-safe output (use `execInContainerRaw()` or pipe stdout directly)
  - Detect MIME type from file extension (Go's `mime.TypeByExtension()`)
  - Set `Content-Type` header from MIME detection
  - Set `Content-Length` from file stat
  - Set `Cache-Control: no-cache` and `ETag` from mtime+size
  - Support `If-None-Match` → 304 response
  - Support `?worktree=` parameter (reuse `resolveWorktreeWorkDir`)
  - Enforce configurable max size (`FileRawMaxSize`, env: `FILE_RAW_MAX_SIZE`, default: 25MB)
  - Stream response body (don't buffer entire file in memory)
- [ ] Add `FileRawMaxSize` and `FileRawTimeout` to config (`packages/vm-agent/internal/config/config.go`)
- [ ] Register route in `server.go` route setup
- [ ] Add unit tests for the new endpoint

### 2. API Proxy: Raw file proxy route
- [ ] Add `GET /:id/sessions/:sessionId/files/raw` route in `apps/api/src/routes/projects/files.ts`
  - Proxy to `files/raw` on VM agent
  - Use separate max bytes config: `FILE_RAW_PROXY_MAX_BYTES` (default: 25MB)
  - Forward `Content-Type`, `Content-Length`, `Cache-Control`, `ETag`, `Content-Disposition` headers
  - Forward `If-None-Match` request header to VM agent
  - Add `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` for SVG safety
  - Add `X-Content-Type-Options: nosniff`
- [ ] Add direct workspace raw file endpoint in `apps/web/src/lib/api.ts`
  - `getFileRawUrl()` — returns URL string for `<img src>` (workspace-direct path)
  - `getSessionFileRawUrl()` — returns URL string for `<img src>` (session proxy path)

### 3. Frontend: Image detection utility
- [ ] Create `isImageFile(filePath: string): boolean` utility
  - Check extension against: png, jpg, jpeg, gif, svg, webp, avif, ico, bmp
  - Export from a shared location used by both `FileViewerPanel` and `ChatFilePanel`
- [ ] Create `isSvgFile(filePath: string): boolean` for SVG-specific toggle

### 4. Frontend: Image rendering in FileViewerPanel
- [ ] Add image detection branch in `FileViewerPanel.tsx`
  - If `isImageFile(filePath)`, render `<img>` with raw file URL instead of fetching text content
  - Construct URL: `${workspaceUrl}/workspaces/${workspaceId}/files/raw?path=${filePath}&token=${token}`
  - Default: `object-fit: contain`, `max-width: 100%`, `max-height: 100%`
  - Click toggles between fit-to-panel and 1:1 actual size (overflow: auto on container)
  - Show metadata bar: filename, dimensions (from `img.onload` → `naturalWidth x naturalHeight`), file size (from FileEntry if available)
  - Loading state with spinner until image loads
  - Error state if image fails to load (`img.onerror`)
- [ ] SVG support: render via `<img src>` (same as other images — blocks scripts)

### 5. Frontend: Image rendering in ChatFilePanel
- [ ] Add image detection in `ChatFilePanel.tsx` view mode
  - If `isImageFile(filePath)`, render `<img>` with session proxy URL
  - Construct URL: `/api/projects/${projectId}/sessions/${sessionId}/files/raw?path=${filePath}`
  - Same zoom toggle, metadata, loading/error behavior as FileViewerPanel
- [ ] Update `openFile()` to skip `loadFile()` (text content fetch) for image files

### 6. Frontend: File browser icon hints
- [ ] In file listing (both `ChatFilePanel` browse mode and `FileBrowserPanel`), show image icon for image files instead of generic `FileText` icon

### 7. Environment variable documentation
- [ ] Add `FILE_RAW_MAX_SIZE` to vm-agent config documentation
- [ ] Add `FILE_RAW_PROXY_MAX_BYTES` to API env documentation
- [ ] Add `FILE_PREVIEW_INLINE_MAX_BYTES` (default: 10MB) and `FILE_PREVIEW_LOAD_MAX_BYTES` (default: 25MB) as frontend-configurable thresholds
- [ ] Update CLAUDE.md recent changes section

## Acceptance Criteria

- [ ] PNG, JPEG, GIF, WebP images render inline in the file viewer when selected in the file browser
- [ ] SVG files render as images via `<img>` tag (no inline HTML injection)
- [ ] Images scale to fit the viewer panel by default (aspect ratio preserved)
- [ ] Clicking an image toggles between fit-to-panel and actual-size (1:1) view
- [ ] Image metadata (dimensions, file size) displayed in the header
- [ ] Files > 10MB show "Click to load" instead of auto-rendering
- [ ] Files > 25MB show "Download only" message
- [ ] Image rendering works in both FileViewerPanel (workspace view) and ChatFilePanel (project chat)
- [ ] Non-image binary files still show "Binary file — cannot display"
- [ ] No SVG script execution possible (all SVGs rendered via `<img>` tag)
- [ ] All size thresholds are configurable via environment variables
- [ ] Existing text file viewing is not affected
- [ ] VM agent raw endpoint returns proper MIME types and supports ETag/304
