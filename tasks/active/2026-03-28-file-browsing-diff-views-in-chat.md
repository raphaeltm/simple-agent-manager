# File Browsing & Diff Views in Project Chat

## Problem

When reading a conversation in the project chat view, agents reference files via `toolMetadata.locations[]` in tool call messages, but these are just static text labels. There's no way to quickly view file contents or diffs without leaving the chat and navigating to the workspace view.

## Research Findings

### Current component tree for tool calls
- `ProjectMessageView` renders `AcpConversationItemView` for each `ConversationItem`
- `AcpConversationItemView` renders `AcpToolCallCard` for `tool_call` items
- `ToolCallCard` (in `packages/acp-client/`) shows `locations` as plain text spans
- `ToolCallCard` receives only `{ toolCall: ToolCallItem }` — no `workspaceId`

### Existing file viewer components (workspace view)
- `FileBrowserPanel` — directory browser with breadcrumbs (props: `workspaceUrl`, `workspaceId`, `token`, etc.)
- `FileViewerPanel` — file viewer with syntax highlighting via Prism (same VM-agent-direct API pattern)
- `GitDiffView` — unified diff display with additions/removals coloring
- All three talk directly to VM agent via `workspaceUrl` (e.g., `https://ws-{id}.${BASE_DOMAIN}`)
- All use `token` from `getTerminalToken()` for auth

### API pattern for VM agent access
- Current: UI calls VM agent directly at `workspaceUrl` with a terminal token
- For chat: Need a proxy route on CF Worker since chat view doesn't have the workspace URL/token
- Pattern: `GET /api/projects/:projectId/sessions/:sessionId/files/*` resolves workspace+node from session, proxies to VM agent
- Terminal token generation: `apps/api/src/routes/terminal.ts` shows the pattern — generate token, build `workspaceUrl`

### Session → Workspace mapping
- `ChatSessionResponse` includes `workspaceId` field
- `WorkspaceResponse` includes `nodeId` and workspace URL can be derived from `ws-{id}.${BASE_DOMAIN}`

## Implementation Checklist

### Phase 1: Clickable file refs + session header buttons

- [ ] 1.1 Add `workspaceId` prop to `ToolCallCard` component (optional, for backward compat)
- [ ] 1.2 Render `locations` as clickable links when `workspaceId` is provided
- [ ] 1.3 Thread `workspaceId` through `AcpConversationItemView` in `ProjectMessageView.tsx`
- [ ] 1.4 Add "Files" and "Git" buttons to `SessionHeader` expanded details panel
- [ ] 1.5 Same visibility condition as "Open Workspace": `session.workspaceId && sessionState === 'active'`

### Phase 2: Inline slide-over file viewer panel

- [ ] 2.1 Extract shared rendering components from `FileBrowserPanel`, `FileViewerPanel`, `GitDiffView`
  - Move pure rendering logic (file list, syntax highlighting, diff rendering) to shared components
  - Keep workspace-specific orchestration (URL-driven state) in workspace page
  - Create `apps/web/src/components/shared-file-viewer/` directory
- [ ] 2.2 Add proxy API routes on CF Worker
  - `GET /api/projects/:projectId/sessions/:sessionId/files/list?path=...`
  - `GET /api/projects/:projectId/sessions/:sessionId/files/view?path=...`
  - `GET /api/projects/:projectId/sessions/:sessionId/git/status`
  - `GET /api/projects/:projectId/sessions/:sessionId/git/diff?path=...&staged=...`
  - Auth: project-level (user must own the project)
  - Resolve workspace from session, build workspaceUrl, generate token, proxy to VM agent
- [ ] 2.3 Add API client functions in `apps/web/src/lib/api.ts` for the proxy routes
- [ ] 2.4 Build `ChatFilePanel` slide-over component
  - Slides from right on desktop, full-screen bottom sheet on mobile
  - Internal state machine: `browse` → `view` → `diff`
  - Uses shared rendering components
  - Close button returns focus to chat
- [ ] 2.5 Integrate `ChatFilePanel` into `ProjectMessageView`
  - File ref clicks open the panel (instead of navigating away)
  - "Files" and "Git" buttons open the panel
  - Handle workspace unavailability (disable buttons, show message)
- [ ] 2.6 Update `ToolCallCard` click behavior to call `onFileClick` callback instead of navigating

### Testing

- [ ] 3.1 Write Playwright visual audit tests following `ideas-ui-audit.spec.ts` pattern
  - Mock data for tool calls with file locations
  - Session header with/without Files/Git buttons
  - Slide-over panel states (file viewer, diff, file browser, empty, error)
  - Mobile (375px) and desktop (1280px) viewports
  - Assert no horizontal overflow
- [ ] 3.2 Unit tests for proxy API routes
- [ ] 3.3 Unit tests for shared file viewer components

## Acceptance Criteria

- [ ] File references in `ToolCallCard` are clickable when workspace is available
- [ ] "Files" and "Git" buttons appear in session header when workspace is active
- [ ] Clicking file refs opens inline slide-over panel (no navigation away from chat)
- [ ] Slide-over shows file contents with syntax highlighting
- [ ] Slide-over shows diff view with color-coded additions/removals
- [ ] Slide-over supports basic directory browsing
- [ ] Mobile: panel is full-screen bottom sheet
- [ ] Desktop: panel slides in from the right
- [ ] Workspace unavailable: buttons disabled, panel shows "Workspace unavailable"
- [ ] Proxy API routes work with project-level auth
- [ ] No code duplication between workspace view and chat view file panels
- [ ] No horizontal overflow on any viewport
- [ ] Playwright visual audit screenshots captured for all states

## References

- `apps/web/src/components/chat/ProjectMessageView.tsx` — SessionHeader + message rendering
- `packages/acp-client/src/components/ToolCallCard.tsx` — tool call display
- `apps/web/src/components/FileBrowserPanel.tsx` — existing file browser
- `apps/web/src/components/FileViewerPanel.tsx` — existing file viewer
- `apps/web/src/components/GitDiffView.tsx` — existing diff viewer
- `apps/web/src/lib/api.ts:1221-1340` — VM agent API client functions
- `apps/api/src/routes/terminal.ts` — pattern for building workspaceUrl + token
