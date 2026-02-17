# Data Model: Worktree Context Switching

**Feature**: 015-worktree-context
**Date**: 2026-02-17

## Entities

### WorktreeInfo (VM Agent Runtime)

Represents a git worktree within a workspace. Derived from `git worktree list --porcelain` output.

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Absolute container path (e.g., `/workspaces/my-repo-wt-feature-auth`) |
| `branch` | `string \| null` | Branch name (null if detached HEAD) |
| `headCommit` | `string` | HEAD commit SHA (abbreviated) |
| `isPrimary` | `boolean` | True for the original clone directory |
| `isDirty` | `boolean` | True if worktree has uncommitted changes |
| `dirtyFileCount` | `number` | Number of dirty files (0 if clean) |

**Source**: Parsed from `git worktree list --porcelain` executed via `docker exec` inside the devcontainer.

**Lifecycle**: Ephemeral — computed on demand, cached for 30 seconds in VM Agent memory. Not persisted to any database.

### WorktreeInfo (Shared Type — API Response)

Serialized form of worktree info returned by the VM Agent API and consumed by the frontend.

```typescript
interface WorktreeInfo {
  path: string;           // Container path: /workspaces/my-repo-wt-feature-auth
  branch: string | null;  // Branch name or null for detached HEAD
  headCommit: string;     // Abbreviated SHA
  isPrimary: boolean;     // True for original clone
  isDirty: boolean;       // Has uncommitted changes
  dirtyFileCount: number; // Count of dirty files
}
```

### WorktreeCreateRequest

Request to create a new worktree.

```typescript
interface WorktreeCreateRequest {
  branch: string;          // Existing branch name or new branch name
  baseBranch?: string;     // Base ref for new branch (default: HEAD of primary worktree)
  createBranch?: boolean;  // True to create a new branch (default: false)
}
```

### Active Worktree (Frontend State)

The currently selected worktree in the UI. Drives file browser, git viewer, and new session creation.

| Storage | Key | Value |
|---------|-----|-------|
| URL search param | `worktree` | Container path (e.g., `/workspaces/my-repo-wt-feature-auth`) |

**Rules**:
- If `?worktree` is absent or invalid, defaults to the primary worktree
- Setting `?worktree` does NOT affect existing terminal or agent sessions
- The active worktree is NOT stored on the server — it's purely a UI concept

### Agent Session (Extended)

The existing `agent_sessions` D1 table gains a new nullable column.

**New Column**:

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `worktree_path` | `TEXT` | Yes | `NULL` | Container path of the worktree this session is bound to. NULL means primary worktree. |

**Shared Type Extension**:

```typescript
interface AgentSession {
  // ... existing fields ...
  id: string;
  workspaceId: string;
  status: AgentSessionStatus;
  label?: string | null;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string | null;
  errorMessage?: string | null;
  // NEW:
  worktreePath?: string | null;  // Container path of bound worktree
}

interface CreateAgentSessionRequest {
  label?: string;
  // NEW:
  worktreePath?: string;  // Worktree to bind the session to
}
```

### VM Agent Tab Store (Extended)

The VM Agent's local SQLite `tabs` table gains a new column for worktree persistence across agent process restarts.

**New Column**:

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `worktree_path` | `TEXT` | Yes | Container path of the worktree this tab/session is bound to |

### Worktree Validation Cache (VM Agent Runtime)

In-memory cache of valid worktree paths per workspace.

| Field | Type | Description |
|-------|------|-------------|
| `workspaceId` | `string` | Cache key |
| `worktrees` | `[]WorktreeInfo` | Cached worktree list |
| `expiresAt` | `time.Time` | Cache expiry (30s TTL by default) |

**Invalidation**: Automatically invalidated on create/remove operations.

## Entity Relationships

```
Workspace (1) ──── has many ───► WorktreeInfo (N, ephemeral)
    │                                │
    │                                │
    └── has many ──► AgentSession ──┘ bound to one worktree (worktree_path)
    │
    └── has many ──► Terminal Session ── bound to one worktree (CWD at creation)
```

- A workspace always has at least one worktree (the primary, which cannot be removed)
- Each agent session is bound to exactly one worktree at creation time (immutable)
- Each terminal session is bound to exactly one worktree at creation time (via CWD; immutable)
- The active worktree is a UI-only concept that determines context for new sessions

## State Transitions

### Worktree Lifecycle

```
                  create
    (not exist) ────────► (exists, clean)
                              │
                         user edits files
                              │
                              ▼
                         (exists, dirty)
                              │
                    ┌─────────┴──────────┐
                    │                    │
              user commits         force remove
                    │                    │
                    ▼                    ▼
             (exists, clean)      (not exist)
                    │
               user removes
                    │
                    ▼
              (not exist)
```

**Rules**:
- Primary worktree cannot be removed (FR-015)
- Removing a dirty worktree requires force flag and user confirmation (FR-016)
- Removing a worktree stops all bound agent sessions (FR-021)

### Active Worktree Selection

```
Page Load ──► Check ?worktree URL param
                    │
              ┌─────┴──────┐
              │             │
         param valid    param invalid/absent
              │             │
              ▼             ▼
    Set as active    Set primary as active
              │             │
              └──────┬──────┘
                     │
                     ▼
              User selects different worktree
                     │
                     ▼
              Update ?worktree URL param
              Update file browser context
              Update git viewer context
              (existing sessions unchanged)
```

## Validation Rules

### Worktree Path Validation

1. Path MUST be absolute and start with `/workspaces/`
2. Path MUST NOT contain `..` segments
3. Path MUST appear in `git worktree list --porcelain` output for the workspace
4. Path is validated server-side on every request that accepts a `worktree` parameter

### Worktree Creation Validation

1. Branch MUST NOT already be checked out in another worktree (git enforces this)
2. Branch name MUST be a valid git ref name
3. Total worktree count MUST NOT exceed `MAX_WORKTREES_PER_WORKSPACE` (configurable, default 10)
4. If `createBranch` is true, branch MUST NOT already exist

### Worktree Removal Validation

1. Primary worktree CANNOT be removed
2. If worktree is dirty, request MUST include force flag
3. Any running agent sessions bound to the worktree are stopped before removal

## Configuration (Constitution Principle XI Compliance)

All new configurable values follow the established `DEFAULT_*` constant + env var override pattern.

| Env Var | Default | Constant | Description |
|---------|---------|----------|-------------|
| `MAX_WORKTREES_PER_WORKSPACE` | 10 | `DEFAULT_MAX_WORKTREES_PER_WORKSPACE` | Maximum worktrees per workspace |
| `WORKTREE_CACHE_TTL_SECONDS` | 30 | `DEFAULT_WORKTREE_CACHE_TTL_SECONDS` | Cache TTL for worktree list validation |
| `WORKTREE_EXEC_TIMEOUT` | 30s | `DEFAULT_WORKTREE_EXEC_TIMEOUT` | Timeout for git worktree commands |

## Database Migration

### D1 Migration: Add worktree_path to agent_sessions

```sql
-- Migration: add_worktree_path_to_agent_sessions
ALTER TABLE agent_sessions ADD COLUMN worktree_path TEXT;
```

This is a backward-compatible, additive migration. Existing rows will have `NULL` for `worktree_path`, which means "primary worktree" — preserving current behavior.

### VM Agent SQLite Migration: Add worktree_path to tabs

```sql
ALTER TABLE tabs ADD COLUMN worktree_path TEXT DEFAULT NULL;
```
