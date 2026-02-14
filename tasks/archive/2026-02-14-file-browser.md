# File Browser

**Created**: 2026-02-14
**Priority**: High
**Relates to**: FR-008 (file browsing requirement), `2026-02-14-git-changes-viewer.md`

## Summary

A mobile-first file browser for exploring workspace filesystems. Breadcrumb + flat list pattern (not a tree — trees are painful on mobile). Read-only file viewer with syntax highlighting via `prism-react-renderer`. Links to the git changes viewer for files with uncommitted changes.

## Context

FR-008 requires file browsing and editing in workspaces. The git changes viewer (separate task) handles "what changed?". This tool handles "what's here?" — full directory exploration with syntax-highlighted file viewing. The two tools are separate overlays that cross-link to each other via URL routing.

## Design Decisions

- **Separate from git viewer**: Two independent icons in the nav bar, two independent overlays. They link to each other but don't share UI state.
- **Breadcrumb + flat list**: Not a tree. On mobile, show tappable breadcrumb segments at the top, flat directory listing below. Folders first, then files sorted alphabetically.
- **Read-only v1**: No file editing. "Edit in terminal" could be a future action menu item.
- **Syntax highlighting**: `prism-react-renderer` (~5-15KB gzipped). Dark theme matching SAM palette. Languages: TypeScript, JavaScript, Go, Python, CSS, HTML, JSON, YAML, Markdown, Bash, Dockerfile, TOML.
- **Cross-linking**: File viewer shows "View Diff" button when the file has git changes. Git diff view can link back to "Open File" in the browser.
- **Mutually exclusive overlays**: Opening the file browser clears `?git=*` params and vice versa.

## Routing

```
/workspaces/:id?files=browse                       → file browser at repo root
/workspaces/:id?files=browse&path=src/components    → file browser at specific path
/workspaces/:id?files=view&path=src/App.tsx         → file viewer for specific file
```

Cross-links to git viewer:
```
/workspaces/:id?git=diff&file=src/App.tsx&staged=false  → git diff (from file viewer "View Diff")
```

Browser back/forward works naturally — each navigation pushes to history. Workspace stays mounted underneath.

## UI Mockups

### File Browser (breadcrumb + flat list)

```
┌───────────────────────────────┐
│ ← Files               ↻    ✕ │  Header
│ / > src > components >        │  Breadcrumb (tappable segments)
├───────────────────────────────┤
│ 📁 hooks/                     │  Folders first (44px touch target)
│ 📁 utils/                     │
│ 📄 App.tsx              4.2KB │  Files with size
│ 📄 index.ts             0.3KB │
│ 📄 styles.css           1.1KB │
└───────────────────────────────┘
```

### File Viewer (syntax highlighted)

```
┌───────────────────────────────┐
│ ← App.tsx         [Diff] [✕] │  Header (Diff button if file has changes)
├───────────────────────────────┤
│  1  import React from 'react' │  Line numbers + syntax highlighting
│  2  import { useState } from  │  Monospace, horizontal scroll
│  3    'react';                 │  Dark theme colors
│  4                             │
│  5  export function App() {    │
│  ...                           │
└───────────────────────────────┘
```

## Implementation Plan

### Phase 1: Backend — VM Agent (Go)

- [ ] Add config values to `config.go`:
  - `FILE_LIST_TIMEOUT` (default: 10s) — timeout for `ls`/`find` commands
  - `FILE_LIST_MAX_ENTRIES` (default: 1000) — max entries returned per directory listing
  - `FILE_READ_MAX_SIZE` (default: 1MB) — reuses existing `GIT_FILE_MAX_SIZE` or separate
- [ ] Create `files.go` with one new handler:
  - `GET /workspaces/{workspaceId}/files/list?path=...` — directory listing
  - Runs `ls -la --time-style=long-iso` or custom JSON-producing script in container
  - Parses output into structured entries: `{ name, type (file|dir|symlink), size, modifiedAt }`
  - Auth: `requireWorkspaceRequestAuth()` (same as git endpoints)
  - Path sanitization: reuses `sanitizeFilePath()` from git.go
  - Container exec: reuses `execInContainer()` from git.go
- [ ] Reuse existing `GET /workspaces/{workspaceId}/git/file?path=...` for file content reading (no `ref` param = working tree)
- [ ] Register route in `server.go` `setupRoutes()`
- [ ] Create `files_test.go` with `ls` output parser tests

**Response type:**
```go
type FileEntry struct {
    Name       string `json:"name"`
    Type       string `json:"type"`       // "file", "dir", "symlink"
    Size       int64  `json:"size"`       // bytes, 0 for dirs
    ModifiedAt string `json:"modifiedAt"` // ISO 8601
}

type FileListResponse struct {
    Path    string      `json:"path"`
    Entries []FileEntry `json:"entries"`
}
```

**Implementation approach for directory listing:**
Rather than parsing `ls -la` output (fragile, locale-dependent), use a small inline script:
```bash
find <path> -maxdepth 1 -not -name '.' -printf '%y\t%s\t%T@\t%f\n' | sort -t$'\t' -k1,1 -k4,4
```
This produces tab-separated output: type (d/f/l), size, mtime epoch, name. Easy to parse, no locale issues.

### Phase 2: API Client (TypeScript)

- [ ] Add to `apps/web/src/lib/api.ts`:
  - Types: `FileEntry`, `FileListData`
  - Function: `getFileList(workspaceUrl, workspaceId, token, path)` → `FileListData`
  - Reuses existing `getGitFile()` for file content (already reads working tree files)

### Phase 3: Syntax Highlighting Setup

- [ ] Install `prism-react-renderer` in `apps/web`
- [ ] Create `apps/web/src/components/SyntaxHighlighter.tsx`:
  - Wraps `prism-react-renderer` `Highlight` component
  - Dark theme matching SAM palette (`--sam-color-bg-canvas: #0b1110`)
  - Language detection from file extension
  - Line numbers column
  - Horizontal scroll for long lines
  - Configurable max lines (with "Show more" button for very large files)

### Phase 4: Frontend Components (React)

- [ ] `FileBrowserButton.tsx` — nav bar icon (`Folder` from lucide-react)
  - Same pattern as `GitChangesButton.tsx`
  - Only visible when workspace is running
  - Touch target: 44x44px mobile, 32x32px desktop

- [ ] `FileBrowserPanel.tsx` — full-screen overlay with breadcrumb + file list
  - **Breadcrumb bar**: Tappable path segments (e.g., `/ > src > components >`)
    - Each segment navigates to that directory via `?files=browse&path=...`
    - Horizontal scroll on mobile for deep paths
  - **Directory listing**: Folders first (📁 icon), then files (📄 icon)
    - Each row: icon, name, size (files only), modified time (optional, desktop only)
    - Tapping a folder updates `path` param (drills in)
    - Tapping a file navigates to `?files=view&path=...`
    - 44px min-height touch targets on mobile
  - **Loading state**: Spinner
  - **Error state**: "Failed to list directory" with retry
  - **Empty state**: "This directory is empty"
  - Refresh button, close button, Escape key handler
  - Styling: inline styles with `var(--sam-color-*)` tokens (matches workspace page)

- [ ] `FileViewerPanel.tsx` — full-screen overlay with syntax-highlighted file content
  - **Header**: Back arrow, file name, optional "View Diff" button (if file has git changes)
  - **Content**: `SyntaxHighlighter` component with line numbers
  - **Language detection**: Map file extensions to Prism language keys
  - **Large file handling**: If > configurable line count, show first N lines + "Show all" button
  - **Binary file detection**: If content contains null bytes or isn't valid UTF-8, show "Binary file" placeholder
  - Back navigates to `?files=browse&path=<parent directory>`
  - Close removes all `files` params

- [ ] Integrate into `Workspace.tsx`:
  - Read `files`, `path` search params (alongside existing `git`, `view`, `sessionId`)
  - Navigation handlers for open/close/drill-in/view-file/back
  - `FileBrowserButton` in header (next to `GitChangesButton`, before kebab menu)
  - Overlay rendering: `FileBrowserPanel` when `files=browse`, `FileViewerPanel` when `files=view`
  - When opening file browser, clear `git` params; when opening git viewer, clear `files` params

### Phase 5: Cross-Linking

- [ ] In `FileViewerPanel`: detect if current file has git changes
  - On mount, call `getGitStatus()` and check if file path appears in staged/unstaged/untracked
  - If yes, show "View Diff" button in header → navigates to `?git=diff&file=...&staged=...`
- [ ] In `GitDiffView` (from git changes viewer): add "Open File" link
  - Navigates to `?files=view&path=...`

### Phase 6: Documentation

- [ ] Update `CLAUDE.md` + `AGENTS.md`:
  - New VM agent endpoint: `GET /workspaces/{id}/files/list`
  - New env vars: `FILE_LIST_TIMEOUT`, `FILE_LIST_MAX_ENTRIES`
  - Recent Changes entry
- [ ] Update git changes viewer task to note cross-linking integration

### Phase 7: Verification

- [ ] `go test ./internal/server/...` passes (new + existing tests)
- [ ] `pnpm typecheck && pnpm lint` passes
- [ ] Deploy and Playwright test:
  - Open file browser, navigate directories via breadcrumbs
  - View a file with syntax highlighting
  - Cross-link to git diff and back
  - Browser back/forward through all states
  - Mobile viewport (375px) — breadcrumbs scroll, touch targets work

## Dependencies

- **Git changes viewer** (`2026-02-14-git-changes-viewer.md`): Must be completed first (or at least the backend + `GitDiffView`), since the file viewer cross-links to it.
- **`prism-react-renderer`**: New npm dependency in `apps/web`.

## Future Enhancements (Not v1)

- File editing (write-back to container)
- File search (find in files)
- File upload/download
- Image preview for image files
- Markdown preview for .md files
- "Open in terminal" action (opens `vim`/`nano` in a terminal tab)
- Tree view toggle for desktop (alongside breadcrumb + list)
