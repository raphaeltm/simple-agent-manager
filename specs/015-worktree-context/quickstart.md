# Quickstart: Worktree Context Switching

**Phase 1 output** | **Date**: 2026-02-17

## Overview

This feature adds git worktree support to SAM workspaces. Users can work on multiple branches simultaneously without switching — each worktree gets its own file tree, git state, terminals, and agent sessions.

## Implementation Phases

### Phase 1: VM Agent Backend (Go)

**Goal**: Worktree CRUD endpoints + worktree-aware git/files/terminal/agent

1. **Add worktree endpoints** (`internal/server/worktrees.go`):
   - `GET /workspaces/:id/worktrees` — list via `git worktree list --porcelain`
   - `POST /workspaces/:id/worktrees` — create via `git worktree add`
   - `DELETE /workspaces/:id/worktrees` — remove via `git worktree remove`

2. **Add worktree path validation** (`internal/server/worktrees.go`):
   - `validateWorktreePath()` — cross-reference against `git worktree list`
   - Cache results per `WORKTREE_CACHE_TTL` (default 5s)

3. **Add worktree param to git/files endpoints** (`git.go`, `files.go`):
   - Extract optional `worktree` query param
   - Validate via `validateWorktreePath()`
   - Use as `workDir` override for `docker exec -w`

4. **Add per-session CWD to PTY** (`pty/manager.go`, `websocket.go`):
   - Add `WorkDir` param to `CreateSessionWithID()`
   - Parse `workDir` from `create_session` WebSocket message
   - Validate worktree path before creating session

5. **Add worktree-scoped agent sessions** (`agent_ws.go`):
   - Parse `worktree` query param from agent WS URL
   - Pass as `ContainerWorkDir` to `SessionHost` config

6. **Add config** (`config/config.go`):
   - `MAX_WORKTREES_PER_WORKSPACE` (default: 5)
   - `WORKTREE_CACHE_TTL` (default: 5s)
   - `GIT_WORKTREE_TIMEOUT` (default: 30s)

### Phase 2: Control Plane API (TypeScript)

**Goal**: Persist worktree metadata on agent sessions

1. **D1 migration** (`migrations/0010_agent_sessions_worktree_path.sql`):
   - `ALTER TABLE agent_sessions ADD COLUMN worktree_path TEXT`

2. **Schema update** (`db/schema.ts`):
   - Add `worktreePath: text('worktree_path')` to `agentSessions`

3. **Route updates** (`routes/workspaces.ts`):
   - Accept `worktreePath` in `POST /api/workspaces/:id/agent-sessions`
   - Include `worktreePath` in session list/detail responses

4. **Shared types** (`packages/shared/src/types.ts`):
   - Add `WorktreeInfo`, `CreateWorktreeRequest` types
   - Add `worktreePath` to `AgentSession`, `CreateAgentSessionRequest`

### Phase 3: Frontend — Worktree Selector & Context Switching

**Goal**: Worktree dropdown + scoped file browser and git viewer

1. **WorktreeSelector component** (`components/WorktreeSelector.tsx`):
   - Dropdown listing all worktrees with branch names
   - Primary worktree visually distinguished
   - "New worktree" action with branch picker
   - "Remove" context action (with dirty warning)
   - Mobile-responsive (56px touch targets)

2. **Workspace page integration** (`pages/Workspace.tsx`):
   - Add `worktrees` and `activeWorktree` state
   - Add `?worktree=` URL search param
   - Fetch worktree list on mount and after create/remove
   - Pass `activeWorktree` to file browser, git viewer

3. **API client updates** (`lib/api.ts`):
   - Add `getWorktrees()`, `createWorktree()`, `removeWorktree()` functions
   - Add optional `worktree` param to `getGitStatus()`, `getGitDiff()`, etc.

4. **File browser & git viewer** (`FileBrowserPanel.tsx`, `GitChangesPanel.tsx`):
   - Accept `worktree` prop
   - Pass to API calls as query param

### Phase 4: Terminal & Agent Session Integration

**Goal**: Worktree-scoped terminals and agent chat sessions with tab badges

1. **Terminal integration** (`packages/terminal/`):
   - Add `workDir` to `create_session` protocol message
   - `MultiTerminal` accepts `defaultWorkDir` prop
   - Expose session `workingDirectory` for tab badge

2. **Tab strip updates** (`WorkspaceTabStrip.tsx`):
   - Add worktree badge to terminal and chat tabs
   - Badge shows short branch name (derived from worktree path)

3. **Agent session integration** (`ChatSession.tsx`, `Workspace.tsx`):
   - Pass `worktreePath` when creating agent sessions (control plane API)
   - Pass `worktree` query param on agent WebSocket URL
   - Show worktree badge on chat tabs

4. **Worktree removal cleanup** (VM Agent):
   - When worktree is removed, stop agent sessions bound to it
   - Notify connected viewers via ACP protocol

### Phase 5: Polish & Edge Cases

1. **Stale worktree detection**: Detect prunable worktrees, offer cleanup
2. **Detached HEAD display**: Show commit hash instead of branch name
3. **Keyboard shortcut**: Add worktree switcher to command palette
4. **URL deep linking**: Verify worktree param survives all navigation flows

## Key Files to Modify

| File | Changes |
|------|---------|
| `packages/vm-agent/internal/server/worktrees.go` | NEW — worktree CRUD + validation |
| `packages/vm-agent/internal/server/git.go` | Add worktree query param |
| `packages/vm-agent/internal/server/files.go` | Add worktree query param |
| `packages/vm-agent/internal/server/websocket.go` | Per-session workDir in create_session |
| `packages/vm-agent/internal/server/agent_ws.go` | Worktree param on agent WS |
| `packages/vm-agent/internal/server/server.go` | Register worktree routes |
| `packages/vm-agent/internal/pty/manager.go` | Per-session workDir in CreateSessionWithID |
| `packages/vm-agent/internal/config/config.go` | New env vars |
| `apps/api/src/db/migrations/0010_*.sql` | NEW — add worktree_path column |
| `apps/api/src/db/schema.ts` | Add worktreePath field |
| `apps/api/src/routes/workspaces.ts` | Accept/return worktreePath |
| `packages/shared/src/types.ts` | WorktreeInfo type, AgentSession extension |
| `packages/terminal/src/protocol.ts` | Add workDir to create_session |
| `packages/terminal/src/MultiTerminal.tsx` | Accept defaultWorkDir prop |
| `apps/web/src/components/WorktreeSelector.tsx` | NEW — worktree dropdown |
| `apps/web/src/components/FileBrowserPanel.tsx` | Accept worktree prop |
| `apps/web/src/components/GitChangesPanel.tsx` | Accept worktree prop |
| `apps/web/src/components/WorkspaceTabStrip.tsx` | Worktree badge |
| `apps/web/src/components/ChatSession.tsx` | Worktree-scoped agent sessions |
| `apps/web/src/pages/Workspace.tsx` | Worktree state, selector, URL param |
| `apps/web/src/lib/api.ts` | Worktree API functions |

## Testing Strategy

| Layer | Test Type | Focus |
|-------|-----------|-------|
| VM Agent: worktree CRUD | Unit | Parse `git worktree list` output, path validation, error cases |
| VM Agent: worktree CRUD | Integration | `docker exec git worktree add/remove` in real container |
| VM Agent: git/files with worktree | Unit | Query param parsing, workDir override |
| VM Agent: PTY per-session CWD | Unit | `CreateSessionWithID` with custom workDir |
| VM Agent: agent WS worktree | Unit | Worktree param extraction and validation |
| Control plane: agent session | Integration | Create/list sessions with worktreePath |
| Control plane: D1 migration | Integration | Migration applies, column exists, nullable |
| Frontend: WorktreeSelector | Unit | Render, create/remove actions, dirty warnings |
| Frontend: API client | Unit | Worktree param added to fetch calls |
| Frontend: Workspace page | Integration | Worktree state, URL param, context switching |
