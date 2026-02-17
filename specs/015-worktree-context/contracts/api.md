# API Contracts: Worktree Context Switching

**Feature**: 015-worktree-context
**Date**: 2026-02-17

## Overview

Worktree operations are split between the **VM Agent** (worktree CRUD, scoped git/files operations) and the **Control Plane API** (agent session metadata with worktree association).

The VM Agent endpoints are accessed directly by the browser via the `ws-{id}.domain` subdomain. The Control Plane API endpoints are accessed via the `api.{domain}` subdomain.

---

## VM Agent Endpoints (Direct — via ws-{id} subdomain)

### List Worktrees

```
GET /workspaces/:workspaceId/worktrees
    ?token=JWT
```

**Response** (200):
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

**Auth**: JWT workspace token (same as git/files endpoints)
**Notes**: Response is cached for 30 seconds (configurable via `WORKTREE_CACHE_TTL_SECONDS`). POST/DELETE operations invalidate the cache.

---

### Create Worktree

```
POST /workspaces/:workspaceId/worktrees
    ?token=JWT
Content-Type: application/json

{
  "branch": "feature/auth",
  "baseBranch": "main",
  "createBranch": false
}
```

**Request Body**:
| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `branch` | `string` | Yes | — | Branch name to check out (or create) |
| `baseBranch` | `string` | No | HEAD of primary | Base ref when creating a new branch |
| `createBranch` | `boolean` | No | `false` | Whether to create a new branch |

**Response** (201):
```json
{
  "worktree": {
    "path": "/workspaces/my-repo-wt-feature-auth",
    "branch": "feature/auth",
    "headCommit": "e4f5g6h",
    "isPrimary": false,
    "isDirty": false,
    "dirtyFileCount": 0
  }
}
```

**Errors**:
| Status | Code | Description |
|--------|------|-------------|
| 400 | `BRANCH_ALREADY_CHECKED_OUT` | Branch is checked out in another worktree |
| 400 | `BRANCH_ALREADY_EXISTS` | Branch already exists (when `createBranch: true`) |
| 400 | `INVALID_BRANCH_NAME` | Branch name is not a valid git ref |
| 400 | `MAX_WORKTREES_EXCEEDED` | Workspace already has maximum worktrees |
| 500 | `WORKTREE_CREATE_FAILED` | `git worktree add` command failed |

**Auth**: JWT workspace token
**Side Effects**: Invalidates worktree cache. Creates a sibling directory under `/workspaces/`.

---

### Remove Worktree

```
DELETE /workspaces/:workspaceId/worktrees
    ?token=JWT&path=/workspaces/my-repo-wt-feature-auth&force=false
```

**Query Parameters**:
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | Yes | — | Absolute container path of the worktree to remove |
| `force` | `boolean` | No | `false` | Force removal even if worktree has uncommitted changes |

**Response** (200):
```json
{
  "removed": "/workspaces/my-repo-wt-feature-auth",
  "stoppedSessions": ["session-abc123"]
}
```

**Errors**:
| Status | Code | Description |
|--------|------|-------------|
| 400 | `CANNOT_REMOVE_PRIMARY` | Attempted to remove the primary worktree |
| 400 | `WORKTREE_DIRTY` | Worktree has uncommitted changes (use `force=true`) |
| 400 | `INVALID_WORKTREE_PATH` | Path is not a valid worktree |
| 500 | `WORKTREE_REMOVE_FAILED` | `git worktree remove` command failed |

**Auth**: JWT workspace token
**Side Effects**: Invalidates worktree cache. Stops any agent sessions bound to the removed worktree. Removes the sibling directory.

---

### Modified Existing Endpoints: Worktree Parameter

The following existing VM Agent endpoints gain an **optional** `worktree` query parameter. If omitted, the primary worktree (existing `ContainerWorkDir`) is used — preserving backward compatibility.

#### Git Status (Modified)

```
GET /workspaces/:workspaceId/git/status
    ?token=JWT&worktree=/workspaces/my-repo-wt-feature-auth
```

**New Query Parameter**:
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `worktree` | `string` | No | Primary worktree | Absolute container path of the worktree |

**Behavior**: `git status --porcelain=v1` executed with `-C <worktree>` (or `docker exec -w <worktree>`)
**Validation**: `worktree` path must be a valid worktree (validated against `git worktree list` cache)

#### Git Diff (Modified)

```
GET /workspaces/:workspaceId/git/diff
    ?token=JWT&path=auth.ts&staged=false&worktree=/workspaces/my-repo-wt-feature-auth
```

**New Query Parameter**: Same `worktree` parameter as above.

#### Git File (Modified)

```
GET /workspaces/:workspaceId/git/file
    ?token=JWT&path=auth.ts&ref=HEAD&worktree=/workspaces/my-repo-wt-feature-auth
```

**New Query Parameter**: Same `worktree` parameter as above.

#### File List (Modified)

```
GET /workspaces/:workspaceId/files/list
    ?token=JWT&path=.&worktree=/workspaces/my-repo-wt-feature-auth
```

**New Query Parameter**: Same `worktree` parameter as above.
**Behavior**: `find` command executed relative to the worktree path.

#### File Find (Modified)

```
GET /workspaces/:workspaceId/files/find
    ?token=JWT&worktree=/workspaces/my-repo-wt-feature-auth
```

**New Query Parameter**: Same `worktree` parameter as above.
**Behavior**: Recursive file index relative to the worktree path.

---

### Modified WebSocket Endpoints: Worktree Parameter

#### Terminal WebSocket (Modified)

```
WSS ws-{id}.domain/terminal/ws/multi
    ?token=JWT&worktree=/workspaces/my-repo-wt-feature-auth
```

**New Query Parameter**:
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `worktree` | `string` | No | Primary worktree | CWD for new PTY sessions on this connection |

**Behavior**: New terminal sessions created on this WebSocket connection start with CWD set to the specified worktree path. Existing sessions on other connections are unaffected.

#### Agent WebSocket (Modified)

```
WSS ws-{id}.domain/agent/ws
    ?token=JWT&sessionId=SESSION_ID&worktree=/workspaces/my-repo-wt-feature-auth
```

**New Query Parameter**:
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `worktree` | `string` | No | Primary worktree | CWD for the agent session |

**Behavior**: When creating a new SessionHost, the worktree path is used as `ContainerWorkDir` for the ACP `NewSession(Cwd: ...)` call. For existing sessions (reconnection), the stored worktree path is used.

---

## Control Plane API Endpoints (via api.{domain})

### Create Agent Session (Modified)

```
POST /api/workspaces/:id/agent-sessions
Content-Type: application/json
Authorization: Bearer <session-cookie>

{
  "label": "Claude (feature-auth)",
  "worktreePath": "/workspaces/my-repo-wt-feature-auth"
}
```

**New Request Field**:
| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `worktreePath` | `string` | No | `null` | Container path of the worktree to bind to |

**Response** (201):
```json
{
  "id": "01HQ...",
  "workspaceId": "ws-abc123",
  "status": "running",
  "label": "Claude (feature-auth)",
  "worktreePath": "/workspaces/my-repo-wt-feature-auth",
  "createdAt": "2026-02-17T10:00:00Z",
  "updatedAt": "2026-02-17T10:00:00Z"
}
```

**Notes**: The `worktreePath` is stored in the D1 database and passed to the VM Agent when creating the session on the node.

### List Agent Sessions (Modified)

```
GET /api/workspaces/:id/agent-sessions
Authorization: Bearer <session-cookie>
```

**Response**: Each session in the array now includes `worktreePath`:
```json
[
  {
    "id": "01HQ...",
    "workspaceId": "ws-abc123",
    "status": "running",
    "label": "Claude (main)",
    "worktreePath": null,
    "createdAt": "2026-02-17T09:00:00Z",
    "updatedAt": "2026-02-17T09:30:00Z"
  },
  {
    "id": "01HR...",
    "workspaceId": "ws-abc123",
    "status": "running",
    "label": "Claude (feature-auth)",
    "worktreePath": "/workspaces/my-repo-wt-feature-auth",
    "createdAt": "2026-02-17T10:00:00Z",
    "updatedAt": "2026-02-17T10:00:00Z"
  }
]
```

---

## Shared Types (packages/shared)

### New Types

```typescript
/** Git worktree information */
export interface WorktreeInfo {
  path: string;
  branch: string | null;
  headCommit: string;
  isPrimary: boolean;
  isDirty: boolean;
  dirtyFileCount: number;
}

/** Request to create a new worktree */
export interface WorktreeCreateRequest {
  branch: string;
  baseBranch?: string;
  createBranch?: boolean;
}

/** Response from list worktrees */
export interface WorktreeListResponse {
  worktrees: WorktreeInfo[];
}

/** Response from create worktree */
export interface WorktreeCreateResponse {
  worktree: WorktreeInfo;
}

/** Response from remove worktree */
export interface WorktreeRemoveResponse {
  removed: string;
  stoppedSessions: string[];
}
```

### Modified Types

```typescript
// Extended: AgentSession
export interface AgentSession {
  // ... existing fields ...
  worktreePath?: string | null;  // NEW
}

// Extended: CreateAgentSessionRequest
export interface CreateAgentSessionRequest {
  label?: string;
  worktreePath?: string;  // NEW
}
```

### New Constants

```typescript
/** Default max worktrees per workspace. Override via MAX_WORKTREES_PER_WORKSPACE env var. */
export const DEFAULT_MAX_WORKTREES_PER_WORKSPACE = 10;
```

---

## Error Response Format

All error responses follow the existing pattern:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description"
}
```

### New Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `BRANCH_ALREADY_CHECKED_OUT` | 400 | Branch is already checked out in another worktree |
| `BRANCH_ALREADY_EXISTS` | 400 | Attempted to create a branch that already exists |
| `INVALID_BRANCH_NAME` | 400 | Branch name is not a valid git ref |
| `MAX_WORKTREES_EXCEEDED` | 400 | Workspace already has the maximum number of worktrees |
| `CANNOT_REMOVE_PRIMARY` | 400 | Attempted to remove the primary worktree |
| `WORKTREE_DIRTY` | 400 | Worktree has uncommitted changes; use force=true |
| `INVALID_WORKTREE_PATH` | 400 | Path is not a valid worktree for this workspace |
| `WORKTREE_CREATE_FAILED` | 500 | git worktree add failed |
| `WORKTREE_REMOVE_FAILED` | 500 | git worktree remove failed |
