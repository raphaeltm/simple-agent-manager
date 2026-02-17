# Quickstart: Worktree Context Switching

**Feature**: 015-worktree-context
**Date**: 2026-02-17

## Implementation Order

This feature spans three layers. Build bottom-up to enable incremental testing.

### Phase 1: VM Agent Backend (Go)

**Goal**: Worktree CRUD endpoints and worktree-scoped operations.

1. **Add configuration** (`config/config.go`)
   - Add `MAX_WORKTREES_PER_WORKSPACE`, `WORKTREE_CACHE_TTL_SECONDS`, `WORKTREE_EXEC_TIMEOUT` env vars
   - Follow existing pattern: `getEnvInt()`/`getEnvDuration()` with `DEFAULT_*` fallback

2. **Add worktree validation** (`server/worktree_validation.go`)
   - Parse `git worktree list --porcelain` output
   - Build cached worktree list per workspace (30s TTL)
   - `ValidateWorktreePath(workspaceID, path string) (WorktreeInfo, error)` function
   - Cache invalidation on create/remove

3. **Add worktree CRUD handlers** (`server/worktrees.go`)
   - `GET /workspaces/:workspaceId/worktrees` — list worktrees
   - `POST /workspaces/:workspaceId/worktrees` — create worktree
   - `DELETE /workspaces/:workspaceId/worktrees` — remove worktree
   - Register routes in `server.go`

4. **Add worktree param to existing endpoints** (`server/git.go`, `server/files.go`)
   - Extract optional `worktree` query param
   - Validate via `ValidateWorktreePath()`
   - Pass validated path as `workDir` to `execInContainer()` instead of `ContainerWorkDir`
   - No change when param is absent (backward-compatible)

5. **Add worktree-scoped PTY sessions** (`pty/manager.go`, `server/websocket.go`)
   - Add `CreateSessionWithWorkDir(sessionID, userID string, rows, cols int, workDir string)` to Manager
   - Extract optional `worktree` query param from terminal WebSocket URL
   - Validate and use as CWD for new sessions

6. **Add worktree-scoped agent sessions** (`server/agent_ws.go`, `acp/session_host.go`)
   - Extract optional `worktree` query param from agent WebSocket URL
   - Validate and pass as `ContainerWorkDir` in `GatewayConfig`
   - Persist worktree path in local SQLite tabs table

7. **Tests** (`tests/worktrees_test.go`)
   - Unit tests for porcelain parser
   - Unit tests for worktree path validation
   - Unit tests for sanitized directory naming
   - Integration tests for CRUD endpoints (mock `docker exec`)

### Phase 2: Shared Types & Constants

**Goal**: Type definitions used by both API and Web.

1. **Add types** (`packages/shared/src/types.ts`)
   - `WorktreeInfo`, `WorktreeCreateRequest`, `WorktreeListResponse`, `WorktreeCreateResponse`, `WorktreeRemoveResponse`
   - Extend `AgentSession` with `worktreePath`
   - Extend `CreateAgentSessionRequest` with `worktreePath`

2. **Add constants** (`packages/shared/src/constants.ts`)
   - `DEFAULT_MAX_WORKTREES_PER_WORKSPACE = 10`

3. **Build shared package**: `pnpm --filter @simple-agent-manager/shared build`

### Phase 3: Control Plane API

**Goal**: Persist worktree association for agent sessions.

1. **D1 Migration**: `ALTER TABLE agent_sessions ADD COLUMN worktree_path TEXT;`

2. **Update routes** (`apps/api/src/routes/workspaces.ts`)
   - Accept `worktreePath` in `POST /api/workspaces/:id/agent-sessions`
   - Include `worktreePath` in all agent session responses
   - Pass `worktreePath` to VM Agent when creating session on node

3. **Tests**: Integration tests for agent session creation with worktree path

### Phase 4: Frontend — Worktree Selector

**Goal**: UI for listing, creating, switching, and removing worktrees.

1. **API client functions** (`apps/web/src/lib/api.ts`)
   - `listWorktrees(workspaceUrl, workspaceId, token)` → `WorktreeListResponse`
   - `createWorktree(workspaceUrl, workspaceId, token, request)` → `WorktreeCreateResponse`
   - `removeWorktree(workspaceUrl, workspaceId, token, path, force)` → `WorktreeRemoveResponse`

2. **useWorktrees hook** (`apps/web/src/hooks/useWorktrees.ts`)
   - Fetch worktree list (with refresh)
   - Active worktree state (from URL `?worktree=` param)
   - Create/remove actions
   - Auto-select primary worktree on load

3. **WorktreeSelector component** (`apps/web/src/components/WorktreeSelector.tsx`)
   - Dropdown in workspace header (next to repo@branch)
   - Shows all worktrees with branch names
   - Primary worktree marked distinctly
   - "New worktree" action at bottom
   - Context menu for remove (with dirty warning)

4. **WorktreeCreateDialog component** (`apps/web/src/components/WorktreeCreateDialog.tsx`)
   - Branch picker (existing branches)
   - "Create new branch" toggle
   - Base branch selector (when creating new)
   - Loading state during creation

### Phase 5: Frontend — Context Propagation

**Goal**: Wire active worktree through all workspace components.

1. **Workspace.tsx** — Add worktree state management
   - Integrate `useWorktrees` hook
   - Add `WorktreeSelector` to header
   - Propagate `activeWorktree.path` to child components
   - Update URL `?worktree=` param on switch

2. **FileBrowserPanel** — Accept and pass `worktree` prop to API calls

3. **GitChangesPanel** — Accept and pass `worktree` prop to API calls

4. **GitDiffView** — Accept and pass `worktree` prop to API calls

5. **FileViewerPanel** — Accept and pass `worktree` prop to API calls

6. **ChatSession** — Pass worktree path in WebSocket URL for new sessions

7. **MultiTerminal** — Pass worktree path in WebSocket URL for new connections

### Phase 6: Frontend — Tab Badging

**Goal**: Show worktree association on terminal and chat tabs.

1. **WorkspaceTabStrip** — Add worktree badge to tabs
   - Derive short worktree label from branch name
   - Color-code or icon to distinguish worktrees
   - Primary worktree tabs show no badge (clean default)

2. **Tab data** — Include worktree info in tab metadata
   - Agent session tabs: worktree from `AgentSession.worktreePath`
   - Terminal tabs: worktree from terminal session metadata

### ~~Phase 7: Devcontainer Mount Change~~ (NOT NEEDED)

The existing named volume setup already mounts at `/workspaces` (the parent directory), not at `/workspaces/<repo>`. The devcontainer override config from `bootstrap.go` sets `workspaceMount: "source=sam-ws-<id>,target=/workspaces,type=volume"`. This means sibling worktree directories created under `/workspaces/` are automatically visible inside the container. No infrastructure changes needed.

## Key Files to Modify

| File | Layer | Change Type |
|------|-------|-------------|
| `packages/vm-agent/internal/config/config.go` | VM Agent | Add env vars |
| `packages/vm-agent/internal/server/worktrees.go` | VM Agent | NEW: CRUD handlers |
| `packages/vm-agent/internal/server/worktree_validation.go` | VM Agent | NEW: Path validation |
| `packages/vm-agent/internal/server/git.go` | VM Agent | Add worktree param |
| `packages/vm-agent/internal/server/files.go` | VM Agent | Add worktree param |
| `packages/vm-agent/internal/server/websocket.go` | VM Agent | Add worktree to terminal WS |
| `packages/vm-agent/internal/server/agent_ws.go` | VM Agent | Add worktree to agent WS |
| `packages/vm-agent/internal/server/server.go` | VM Agent | Register routes |
| `packages/vm-agent/internal/pty/manager.go` | VM Agent | CreateSessionWithWorkDir |
| `packages/vm-agent/internal/acp/session_host.go` | VM Agent | Accept worktree CWD |
| `packages/shared/src/types.ts` | Shared | New types |
| `packages/shared/src/constants.ts` | Shared | New constant |
| `apps/api/src/db/schema.ts` | API | Add column |
| `apps/api/src/routes/workspaces.ts` | API | Accept/return worktreePath |
| `apps/web/src/lib/api.ts` | Web | API client functions |
| `apps/web/src/hooks/useWorktrees.ts` | Web | NEW: Worktree hook |
| `apps/web/src/components/WorktreeSelector.tsx` | Web | NEW: Selector component |
| `apps/web/src/components/WorktreeCreateDialog.tsx` | Web | NEW: Create dialog |
| `apps/web/src/pages/Workspace.tsx` | Web | State + propagation |
| `apps/web/src/components/FileBrowserPanel.tsx` | Web | Accept worktree prop |
| `apps/web/src/components/GitChangesPanel.tsx` | Web | Accept worktree prop |
| `apps/web/src/components/GitDiffView.tsx` | Web | Accept worktree prop |
| `apps/web/src/components/WorkspaceTabStrip.tsx` | Web | Worktree badges |

## Testing Strategy

| Layer | Test Type | What to Test |
|-------|-----------|--------------|
| VM Agent | Unit | Porcelain parser, path validation, directory naming |
| VM Agent | Unit | Worktree CRUD handler logic (mock docker exec) |
| VM Agent | Integration | End-to-end worktree operations with real git |
| Shared | Unit | Type validation, constant values |
| API | Integration | Agent session creation with worktree path (Miniflare) |
| Web | Unit | WorktreeSelector rendering, useWorktrees hook |
| Web | Unit | Worktree prop propagation in FileBrowserPanel, GitChangesPanel |
| E2E | Playwright | Create worktree, switch, verify file browser updates |

## Documentation Updates (Same Commit)

- `CLAUDE.md` / `AGENTS.md`: Add new env vars, API endpoints, recent changes entry
- `apps/api/.env.example`: Add `MAX_WORKTREES_PER_WORKSPACE`
