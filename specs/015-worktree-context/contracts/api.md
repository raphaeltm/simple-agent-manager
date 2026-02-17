# API Contracts: Worktree Context Switching

**Phase 1 output** | **Date**: 2026-02-17

## VM Agent Endpoints (New)

### List Worktrees

```
GET /workspaces/{workspaceId}/worktrees?token={jwt}
```

**Authentication**: Workspace JWT (query param) or session cookie

**Response 200**:
```json
{
  "worktrees": [
    {
      "path": "/workspaces/my-repo",
      "branch": "main",
      "headCommit": "a1b2c3d",
      "isPrimary": true,
      "isDirty": false,
      "dirtyFileCount": 0
    },
    {
      "path": "/workspaces/my-repo-wt-feature-auth",
      "branch": "feature/auth",
      "headCommit": "e4f5g6h",
      "isPrimary": false,
      "isDirty": true,
      "dirtyFileCount": 3
    }
  ]
}
```

**Error 404**: Workspace not found or not running
**Error 401**: Invalid or expired token

**Implementation**: Runs `git worktree list --porcelain` inside the container, then `git status --porcelain -s` for each worktree to get dirty state. Results cached per `WORKTREE_CACHE_TTL`.

---

### Create Worktree

```
POST /workspaces/{workspaceId}/worktrees?token={jwt}
Content-Type: application/json
```

**Request body**:
```json
{
  "branch": "feature/auth",
  "createBranch": false,
  "baseBranch": "main"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch` | string | Yes | Branch name to check out in the worktree |
| `createBranch` | boolean | No | If `true`, create a new branch (default: `false`) |
| `baseBranch` | string | No | Base ref for new branch creation (default: primary worktree's HEAD) |

**Response 201**:
```json
{
  "path": "/workspaces/my-repo-wt-feature-auth",
  "branch": "feature/auth",
  "headCommit": "a1b2c3d",
  "isPrimary": false,
  "isDirty": false,
  "dirtyFileCount": 0
}
```

**Error 400**: Invalid branch name
**Error 409**: Branch already checked out in another worktree
**Error 422**: Max worktrees exceeded
**Error 404**: Workspace not found, branch not found (when `createBranch: false`)

**Implementation**:
1. Validate branch name with `git check-ref-format`
2. Check worktree count against `MAX_WORKTREES_PER_WORKSPACE`
3. Check branch not already checked out via `git worktree list`
4. If `createBranch: true`: `git worktree add -b <branch> <path> <baseBranch>`
5. If `createBranch: false`: `git worktree add <path> <branch>`
6. Invalidate worktree cache

---

### Remove Worktree

```
DELETE /workspaces/{workspaceId}/worktrees?token={jwt}&path={worktreePath}&force={boolean}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | Yes | URL-encoded absolute container path of the worktree |
| `force` | boolean | No | Force removal even if dirty (default: `false`) |

**Response 200**:
```json
{
  "removed": "/workspaces/my-repo-wt-feature-auth"
}
```

**Error 400**: Cannot remove the primary worktree
**Error 409**: Worktree has uncommitted changes (when `force: false`). Response includes:
```json
{
  "error": "WORKTREE_DIRTY",
  "message": "Worktree has uncommitted changes",
  "dirtyFileCount": 3
}
```
**Error 404**: Worktree not found

**Implementation**:
1. Validate path is a legitimate worktree (not primary)
2. If not `force`: check dirty state via `git status --porcelain`
3. Stop any agent sessions bound to this worktree (via in-memory session host map)
4. Run `git worktree remove [--force] <path>`
5. Invalidate worktree cache

---

## VM Agent Endpoints (Modified)

### Git Status (add worktree param)

```
GET /workspaces/{workspaceId}/git/status?token={jwt}&worktree={path}
```

| New Param | Type | Required | Description |
|-----------|------|----------|-------------|
| `worktree` | string | No | URL-encoded worktree path. Default: primary worktree |

**Behavior change**: When `worktree` is provided, the `docker exec -w` flag uses the worktree path instead of `ContainerWorkDir`. The worktree path is validated against `git worktree list` output.

---

### Git Diff (add worktree param)

```
GET /workspaces/{workspaceId}/git/diff?token={jwt}&path={file}&staged={bool}&worktree={path}
```

| New Param | Type | Required | Description |
|-----------|------|----------|-------------|
| `worktree` | string | No | URL-encoded worktree path. Default: primary worktree |

---

### Git File (add worktree param)

```
GET /workspaces/{workspaceId}/git/file?token={jwt}&path={file}&ref={ref}&worktree={path}
```

| New Param | Type | Required | Description |
|-----------|------|----------|-------------|
| `worktree` | string | No | URL-encoded worktree path. Default: primary worktree |

---

### File List (add worktree param)

```
GET /workspaces/{workspaceId}/files/list?token={jwt}&path={dir}&worktree={path}
```

| New Param | Type | Required | Description |
|-----------|------|----------|-------------|
| `worktree` | string | No | URL-encoded worktree path. Default: primary worktree |

---

### File Find (add worktree param)

```
GET /workspaces/{workspaceId}/files/find?token={jwt}&worktree={path}
```

| New Param | Type | Required | Description |
|-----------|------|----------|-------------|
| `worktree` | string | No | URL-encoded worktree path. Default: primary worktree |

---

## VM Agent WebSocket Protocols (Modified)

### Multi-Terminal WebSocket

```
GET /terminal/ws/multi?token={jwt}
```

**Modified message: `create_session`**

```json
{
  "type": "create_session",
  "data": {
    "sessionId": "uuid",
    "rows": 24,
    "cols": 80,
    "name": "Terminal 1",
    "workDir": "/workspaces/my-repo-wt-feature-auth"
  }
}
```

| New Field | Type | Required | Description |
|-----------|------|----------|-------------|
| `workDir` | string | No | Working directory for the new PTY session. Default: workspace's `ContainerWorkDir` |

**Validation**: If `workDir` is provided, it must be a valid worktree path (validated against `git worktree list`).

**Response `session_created`** (unchanged — already includes `workingDirectory`):
```json
{
  "type": "session_created",
  "sessionId": "uuid",
  "data": {
    "sessionId": "uuid",
    "workingDirectory": "/workspaces/my-repo-wt-feature-auth"
  }
}
```

---

### Agent WebSocket

```
GET /agent/ws?token={jwt}&sessionId={id}&worktree={path}
```

| New Param | Type | Required | Description |
|-----------|------|----------|-------------|
| `worktree` | string | No | URL-encoded worktree path for the agent session. Default: workspace's `ContainerWorkDir` |

**Behavior**: When `worktree` is provided, the `SessionHost` is created with `ContainerWorkDir` set to the worktree path. The agent's `NewSession(Cwd: ...)` uses this path. The worktree parameter is only used when creating a NEW session host — reconnecting to an existing session host ignores the parameter (the session retains its original CWD).

---

## Control Plane API Endpoints (Modified)

### Create Agent Session

```
POST /api/workspaces/{id}/agent-sessions
Content-Type: application/json
```

**Modified request body**:
```json
{
  "label": "Feature auth work",
  "worktreePath": "/workspaces/my-repo-wt-feature-auth"
}
```

| New Field | Type | Required | Description |
|-----------|------|----------|-------------|
| `worktreePath` | string | No | Container-side worktree path. Stored in D1. Default: `null` (primary worktree) |

**Modified response** (added field):
```json
{
  "id": "uuid",
  "workspaceId": "uuid",
  "status": "running",
  "label": "Feature auth work",
  "worktreePath": "/workspaces/my-repo-wt-feature-auth",
  "createdAt": "2026-02-17T...",
  "updatedAt": "2026-02-17T..."
}
```

---

### List Agent Sessions

```
GET /api/workspaces/{id}/agent-sessions
```

**Modified response** (added field to each session):
```json
[
  {
    "id": "uuid",
    "workspaceId": "uuid",
    "status": "running",
    "label": "Main branch review",
    "worktreePath": null,
    "createdAt": "...",
    "updatedAt": "..."
  },
  {
    "id": "uuid",
    "workspaceId": "uuid",
    "status": "running",
    "label": "Feature auth work",
    "worktreePath": "/workspaces/my-repo-wt-feature-auth",
    "createdAt": "...",
    "updatedAt": "..."
  }
]
```

---

## Shared Types (packages/shared)

### New Types

```typescript
export interface WorktreeInfo {
  path: string;
  branch: string;
  headCommit: string;
  isPrimary: boolean;
  isDirty: boolean;
  dirtyFileCount: number;
}

export interface CreateWorktreeRequest {
  branch: string;
  createBranch?: boolean;
  baseBranch?: string;
}

export interface RemoveWorktreeResponse {
  removed: string;
}

export interface WorktreeListResponse {
  worktrees: WorktreeInfo[];
}
```

### Modified Types

```typescript
export interface AgentSession {
  id: string;
  workspaceId: string;
  status: AgentSessionStatus;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string | null;
  errorMessage?: string | null;
  label?: string | null;
  worktreePath?: string | null;  // NEW
}

export interface CreateAgentSessionRequest {
  label?: string;
  worktreePath?: string;  // NEW
}
```
