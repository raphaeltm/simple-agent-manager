# Data Model: Worktree Context Switching

**Phase 1 output** | **Date**: 2026-02-17

## Entities

### WorktreeInfo (VM Agent — in-memory + API response)

Represents a single git worktree within a workspace.

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | Absolute container-side path (e.g., `/workspaces/my-repo-wt-feature-auth`) |
| `branch` | string | Branch name, or commit hash if detached HEAD |
| `headCommit` | string | Short HEAD commit hash (7 chars) |
| `isPrimary` | boolean | `true` for the original clone directory |
| `isDirty` | boolean | `true` if there are uncommitted changes |
| `dirtyFileCount` | number | Count of modified/staged/untracked files (0 if not dirty) |

**Notes**:
- Not persisted in a database — derived from `git worktree list --porcelain` + `git status --porcelain` at request time
- Cached briefly on the VM Agent (configurable via `WORKTREE_CACHE_TTL`, default 5s) to avoid repeated `docker exec` calls
- The primary worktree is identified by matching against `WorkspaceRuntime.ContainerWorkDir`

### WorktreeBinding (on AgentSession — D1 persistent)

Associates an agent session with its creation-time worktree.

| Field | Type | Nullable | Description |
|-------|------|----------|-------------|
| `worktree_path` | TEXT | Yes | Container-side worktree path. `NULL` = primary worktree (default) |

**Added to**: `agent_sessions` table via migration `0010_agent_sessions_worktree_path.sql`

**Semantics**:
- Set once at agent session creation time, never updated
- `NULL` is treated as "primary worktree" (backward compatible with existing sessions)
- When the bound worktree is removed, the agent session is stopped (FR-021)

### WorktreeBinding (on Terminal Session — VM Agent SQLite)

Associates a terminal PTY session with its creation-time worktree.

| Field | Type | Description |
|-------|------|-------------|
| `work_dir` | TEXT | The `WorkDir` already stored on `pty.Session` — no schema change needed |

**Notes**:
- The PTY session already stores its working directory (used for `docker exec -w`)
- With per-session CWD support, each terminal session naturally records its worktree path
- The `workingDirectory` field is already exposed in `session_created` / `session_list` WebSocket messages
- The tab strip uses this to show worktree badges

### ActiveWorktree (UI state — URL parameter)

The currently selected worktree in the browser, stored as a URL search parameter.

| Field | Type | Description |
|-------|------|-------------|
| `worktree` | URL search param | URL-encoded container path, e.g., `?worktree=%2Fworkspaces%2Fmy-repo-wt-feature-auth` |

**Semantics**:
- Absent or empty = primary worktree
- Determines context for file browser, git viewer, and new terminal/agent session creation
- Does NOT affect existing terminal or agent sessions (they retain their creation-time binding)
- Validated against worktree list on each use

## Entity Relationships

```
Workspace (1:many) ← WorktreeInfo (derived from git, not stored)
    │
    ├── (1:many) ← AgentSession
    │                 └── worktree_path (FK-like reference to WorktreeInfo.path)
    │
    └── (1:many) ← TerminalSession (via PTY Manager)
                      └── work_dir (same semantics)
```

## State Transitions

### Worktree Lifecycle

```
(none) ──create──▶ active ──remove──▶ (none)
                     │
                     ├── prunable (directory manually deleted)
                     │       │
                     │       └──prune──▶ (none)
                     │
                     └── dirty (uncommitted changes)
                             │
                             └──force-remove──▶ (none)
```

**State details**:
- **active**: Worktree exists, listed by `git worktree list`, directory accessible
- **prunable**: Worktree metadata exists in `.git/worktrees/` but directory is missing. Detected by `git worktree list` showing `prunable` flag
- **dirty**: Worktree has uncommitted changes. Detected by `git status --porcelain` in the worktree directory

### Active Worktree Selection (UI state machine)

```
primary ──select(wt)──▶ worktree-X
   ▲                        │
   │                        │ select(primary) or worktree removed
   └────────────────────────┘
```

**Transitions**:
- `select(wt)`: User picks a worktree from the selector → URL param updated → file browser and git viewer re-scope
- `select(primary)`: User picks the primary worktree → URL param cleared
- `worktree removed`: If the active worktree is removed, automatically fall back to primary

## Validation Rules

### Worktree Creation

| Rule | Validation | Error |
|------|-----------|-------|
| Branch not already checked out | `git worktree list` shows no worktree with this branch | "Branch '{branch}' is already checked out in worktree at {path}" |
| Max worktrees not exceeded | Count of existing worktrees < `MAX_WORKTREES_PER_WORKSPACE` | "Maximum of {max} worktrees per workspace reached" |
| Branch exists (for existing branch) | `git rev-parse --verify {branch}` succeeds | "Branch '{branch}' does not exist" |
| Valid branch name (for new branch) | `git check-ref-format --branch {name}` succeeds | "Invalid branch name: {name}" |
| Primary worktree exists | Workspace is running and primary worktree is accessible | "Workspace is not running" |

### Worktree Removal

| Rule | Validation | Error |
|------|-----------|-------|
| Not the primary worktree | `isPrimary` is `false` | "Cannot remove the primary worktree" |
| User confirmed if dirty | Client sends `force: true` when worktree has uncommitted changes | "Worktree has {count} uncommitted changes. Use force to remove" |

### Worktree Path Validation (Security)

| Rule | Validation | Error |
|------|-----------|-------|
| Path in worktree list | Exact match against `git worktree list` output | "Not a valid worktree path" |
| Path under /workspaces/ | `strings.HasPrefix(path, "/workspaces/")` | "Invalid worktree path" |
| No path traversal | `!strings.Contains(path, "..")` | "Invalid worktree path" |
| No null bytes | `!strings.ContainsRune(path, 0)` | "Invalid worktree path" |

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `MAX_WORKTREES_PER_WORKSPACE` | `5` | Maximum worktrees per workspace (including primary) |
| `WORKTREE_CACHE_TTL` | `5s` | Cache duration for `git worktree list` results |
| `GIT_WORKTREE_TIMEOUT` | `30s` | Timeout for git worktree create/remove operations |
