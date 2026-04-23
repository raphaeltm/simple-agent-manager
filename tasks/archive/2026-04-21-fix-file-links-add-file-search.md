# Fix File Path Links & Add File Search in Project Chat

Created: 2026-04-21

## Problem Statement

Two issues in the project chat file browsing experience:

1. **Broken file path links**: When an agent mentions file paths in markdown responses (e.g., `[src/main.ts](src/main.ts)`), they render as `<a>` tags with `target="_blank"` that open a new browser window to a broken URL. They should instead open the ChatFilePanel to view the file.

2. **No file search**: The ChatFilePanel only supports manual directory browsing. Users need VS Code-style fuzzy file search to quickly find files — the VM agent already has a `/files/find` endpoint that returns all file paths recursively, but it's not proxied through the Worker or exposed in the UI.

## Research Findings

### File path links
- `MessageBubble` (`packages/acp-client/src/components/MessageBubble.tsx`) renders markdown via `react-markdown` with custom `<a>` component that always opens `target="_blank"` (lines 105-109, 134-138)
- `MessageBubble` has NO `onFileClick` prop — only `ToolCallCard` has this callback
- `AcpConversationItemView` passes `onFileClick` to `ToolCallCard` but NOT to `MessageBubble` (line 77 vs 81)
- The `onFileClick` handler in `useSessionLifecycle.ts` (line 112-114) sets `filePanel` state to open `ChatFilePanel` in view mode
- Need to: add `onFileClick` to `MessageBubble`, intercept file-path-looking hrefs in the markdown `<a>` renderer, and wire it through `AcpConversationItemView`

### File search
- VM agent has `GET /workspaces/{id}/files/find` endpoint returning `{ files: string[] }` — recursive file listing with exclusions (node_modules, .git, etc.)
- Client function `getFileIndex()` exists in `apps/web/src/lib/api/files.ts` (lines 147-163) but calls VM agent directly
- **No API Worker proxy route** exists for `/files/find` — need to add one in `apps/api/src/routes/projects/files.ts`
- `ChatFilePanel` has no search UI — only browse, view, diff, git-status modes
- Need to: add proxy route, add `getSessionFileIndex()` client function, add search mode to ChatFilePanel with fuzzy matching

### File path detection heuristic
A link href is treated as a file path (not a URL) when:
- Does NOT start with `http://`, `https://`, `mailto:`, `#`, or `javascript:`
- Looks like a relative path (contains `/` or `.` extension)
- Pattern: `/^(?!https?:|mailto:|#|javascript:)/` and contains a file-like segment

## Implementation Checklist

### Part 1: Fix file path links in agent messages

- [ ] Add `onFileClick` optional prop to `MessageBubble` component interface
- [ ] Create file-path detection utility function `isFilePathHref(href: string): boolean`
- [ ] Modify the markdown `<a>` component in `AGENT_MARKDOWN_COMPONENTS` to intercept file-path links and call `onFileClick` instead of opening a new window
- [ ] Make AGENT_MARKDOWN_COMPONENTS a function that accepts `onFileClick` (since it needs to be dynamic)
- [ ] Pass `onFileClick` from `AcpConversationItemView` to `MessageBubble` for agent messages
- [ ] Add unit tests for `isFilePathHref` function
- [ ] Add behavioral test for MessageBubble rendering file path links as clickable elements that call onFileClick

### Part 2: Add file search to ChatFilePanel

- [ ] Add API proxy route `GET /:id/sessions/:sessionId/files/find` in `apps/api/src/routes/projects/files.ts`
- [ ] Add `getSessionFileIndex()` client function in `apps/web/src/lib/api/files.ts`
- [ ] Implement lightweight fuzzy match function (VS Code-style: characters must appear in order, not necessarily contiguous)
- [ ] Add search mode to `ChatFilePanel` — search input in header, filtered results list
- [ ] Search UI: show search input when in browse mode, results replace directory listing while typing
- [ ] Clicking a search result opens the file in view mode
- [ ] Add keyboard shortcut (Ctrl+P / Cmd+P) to focus search input when panel is open
- [ ] Add unit tests for fuzzy match function
- [ ] Add behavioral test for search UI in ChatFilePanel

## Acceptance Criteria

- [ ] Clicking a file path link in an agent message opens the ChatFilePanel to view that file (instead of opening a new browser window)
- [ ] Non-file links (http URLs, anchors) still open in a new tab as before
- [ ] File path links with line numbers (e.g., `file.ts:42`) are parsed correctly
- [ ] ChatFilePanel has a search input that filters files using fuzzy matching
- [ ] Search results show file paths and can be clicked to view the file
- [ ] Search is fast (client-side fuzzy filter on cached file index)
- [ ] Works on mobile (375px viewport)
- [ ] No horizontal overflow on any changed surface

## References

- `packages/acp-client/src/components/MessageBubble.tsx` — markdown rendering
- `packages/acp-client/src/components/ToolCallCard.tsx` — existing onFileClick pattern
- `apps/web/src/components/chat/ChatFilePanel.tsx` — file browser panel
- `apps/web/src/lib/api/files.ts` — file API client functions
- `apps/api/src/routes/projects/files.ts` — file proxy routes
- `apps/web/src/components/project-message-view/AcpConversationItemView.tsx` — wires onFileClick
- `apps/web/src/components/project-message-view/useSessionLifecycle.ts` — handleFileClick handler
