# Research: Worktree Context Switching

**Phase 0 output** | **Date**: 2026-02-17

## Research Questions & Findings

### R1: Git Worktree Operations Inside Docker Named Volume

**Decision**: Run `git worktree add/remove/list` inside the devcontainer via `docker exec`. Worktrees are created as sibling directories under `/workspaces/` within the same named volume.

**Rationale**: The named volume `sam-ws-<workspaceId>` is mounted at `/workspaces` inside the container. The main repo lives at `/workspaces/<repoDirName>/`. Creating a worktree at `/workspaces/<repoDirName>-<branch>/` places it in the same volume, so all git metadata cross-references (`.git` file pointing to main repo's `.git/worktrees/`) resolve correctly. No container rebuild or mount changes needed.

**Alternatives considered**:
- Creating worktrees on the host filesystem: Rejected — host-side directories are not visible inside the container (only the named volume is mounted)
- Creating worktrees inside the repo directory (e.g., `/workspaces/my-repo/.worktrees/`): Rejected — pollutes the working tree, may confuse tools and `.gitignore` rules
- Adding dynamic bind mounts per worktree: Rejected — requires container restart, overly complex

**Key finding**: `docker exec -w /workspaces/my-repo containerID git worktree add /workspaces/my-repo-feature feature` works correctly because both the `-w` flag sets the CWD for git to find `.git/`, and the absolute target path resolves within the same volume.

---

### R2: Per-Session Working Directory for PTY Sessions

**Decision**: Add optional `workDir` field to the multi-terminal `create_session` WebSocket message. The PTY `Session` already supports per-session `WorkDir` in `SessionConfig`; only the `Manager.CreateSessionWithID()` method and the WebSocket protocol need changes to thread it through.

**Rationale**: Currently, `pty.Manager` holds a single global `workDir` applied to all sessions. However, `pty.Session` already accepts `WorkDir` in `SessionConfig` and passes it as `docker exec -w <workDir>`. The change is to allow `CreateSessionWithID()` to accept an optional override, falling back to the manager's default.

**Changes required**:
1. **Go**: Add `WorkDir string` field to `wsCreateSessionData` struct; pass to `CreateSessionWithID()`; add `workDir` parameter to `CreateSessionWithID()` signature
2. **TypeScript protocol**: Add optional `workDir` field to `create_session` message encoder
3. **MultiTerminal component**: Accept `workDir` prop or per-session CWD parameter

**Alternatives considered**:
- Separate PTY Manager per worktree: Rejected — adds unnecessary complexity. A single manager with per-session CWD override is simpler
- Changing CWD after session creation: Rejected — `docker exec -w` is set at process start; can't change after

---

### R3: Per-Session Working Directory for Agent (ACP) Sessions

**Decision**: Pass the worktree path as `ContainerWorkDir` when creating a new `SessionHost` via `getOrCreateSessionHost()`. The ACP SDK's `NewSession(Cwd: ...)` already supports specifying the agent's working directory per session.

**Rationale**: Each `SessionHost` owns a single agent process. The `GatewayConfig.ContainerWorkDir` is used as the `Cwd` for `NewSession()` and `LoadSession()`. Since each agent session already gets its own `SessionHost` instance, we just need to set `ContainerWorkDir` to the worktree path instead of the default workspace path.

**Changes required**:
1. Add `worktree` query parameter to the agent WebSocket URL (`/agent/ws?token=...&sessionId=...&worktree=/workspaces/my-repo-feature`)
2. In `handleAgentWS`, extract the worktree parameter and validate it
3. Pass the worktree path as `ContainerWorkDir` in the `GatewayConfig` when calling `getOrCreateSessionHost()`

**Alternatives considered**:
- ACP protocol message to change CWD mid-session: Not supported by ACP SDK, and per the spec, session worktree binding is immutable after creation

---

### R4: Worktree Path Validation (Security)

**Decision**: Validate worktree paths server-side by:
1. Running `git worktree list --porcelain` inside the container to get the canonical list of worktree paths
2. Checking that any client-supplied `worktree` parameter matches one of these paths exactly
3. As a defense-in-depth measure, also verify the path starts with `/workspaces/` and contains no `..` segments

**Rationale**: The `worktree` parameter is client-controlled and passed to `docker exec -w`. Without validation, an attacker could set it to an arbitrary path (e.g., `/etc/`) and execute commands there. By cross-referencing with `git worktree list` output, we ensure only legitimate worktree directories are accepted.

**Implementation approach**:
- Create a `validateWorktreePath(ctx, containerID, user, primaryWorkDir, requestedPath)` helper in `worktrees.go`
- Cache `git worktree list` results briefly (e.g., 5 seconds) since worktree creation/deletion is infrequent
- Return a clear error message ("not a valid worktree") on validation failure

**Alternatives considered**:
- Path prefix check only (`strings.HasPrefix(path, "/workspaces/")`): Rejected — insufficient; allows any path under `/workspaces/` even if not a worktree
- Allowlist in config: Rejected — too static; worktrees are created dynamically

---

### R5: D1 Migration for `worktree_path` Column

**Decision**: Add `worktree_path TEXT` column to `agent_sessions` table via a D1 migration file. The column is nullable — existing sessions and sessions in the primary worktree will have `NULL`, meaning "default workspace directory."

**Rationale**: The project uses numbered SQL migration files in `apps/api/src/db/migrations/` applied by Wrangler during deployment. Adding a nullable column via `ALTER TABLE` is safe, non-blocking, and backward-compatible. Drizzle ORM schema (`schema.ts`) must be updated in the same commit.

**Migration file**: `apps/api/src/db/migrations/0010_agent_sessions_worktree_path.sql`
```sql
ALTER TABLE agent_sessions ADD COLUMN worktree_path TEXT;
```

**Schema update**: Add `worktreePath: text('worktree_path')` to `agentSessions` table in `schema.ts`.

**Alternatives considered**:
- Storing worktree info as JSON metadata field: Rejected — `worktree_path` is a single string, a dedicated column is simpler and queryable
- Not persisting in D1 (only in VM Agent memory): Rejected — the control plane API serves `AgentSession` responses and needs to include the worktree path for UI rendering after page reload

---

### R6: Worktree Naming Convention

**Decision**: Worktree directories are named `<repoDirName>-wt-<sanitizedBranchName>` under `/workspaces/`. For example, repo `my-repo` with branch `feature/auth` creates a worktree at `/workspaces/my-repo-wt-feature-auth`.

**Rationale**: Using a `-wt-` infix avoids collisions with other workspace directories on multi-workspace nodes. Branch names are sanitized (slashes to dashes, special chars removed) to produce valid directory names.

**Alternatives considered**:
- Using numeric IDs (`my-repo-wt-1`, `my-repo-wt-2`): Rejected — not meaningful to users
- Using branch name only (`feature-auth`): Rejected — could collide with other workspace repo directories
- Letting the user choose the directory name: Rejected per spec scope — unnecessary complexity

---

### R7: Maximum Worktrees Per Workspace

**Decision**: Configurable via `MAX_WORKTREES_PER_WORKSPACE` environment variable with a default of 5. Enforced server-side on the VM Agent before creating a new worktree.

**Rationale**: Each worktree consumes disk space (a full checkout of the branch). With typical repos at 100MB-1GB, 5 worktrees is reasonable for the default CX3x1 VM size. Users with larger VMs can increase the limit.

**Constitution compliance**: Principle XI (No Hardcoded Values) — the limit is configurable via env var with a sensible default.

---

### R8: Active Worktree URL Persistence

**Decision**: Store the active worktree as a URL search parameter `?worktree=<path>` (URL-encoded). The path is the container-side absolute path (e.g., `/workspaces/my-repo-wt-feature-auth`). If the parameter is absent or empty, the primary worktree is used.

**Rationale**: URL-based persistence provides free deep-linking, browser back/forward support, and survives page refresh. This follows the existing pattern where `git`, `files`, `view`, and `sessionId` parameters are used.

**Alternatives considered**:
- `localStorage` persistence: Rejected — not shareable, doesn't survive incognito
- Using branch name instead of path: Rejected — branch name alone is ambiguous if the worktree directory was customized

---

### R9: Worktree-Scoped Git/Files Endpoints

**Decision**: Add an optional `worktree` query parameter to existing git and file endpoints. When present and validated, it overrides the default `ContainerWorkDir` used as the `-w` flag for `docker exec`.

**Endpoints affected**:
- `GET /workspaces/:id/git/status?worktree=...`
- `GET /workspaces/:id/git/diff?worktree=...`
- `GET /workspaces/:id/git/file?worktree=...`
- `GET /workspaces/:id/files/list?worktree=...`
- `GET /workspaces/:id/files/find?worktree=...`

**Rationale**: This is the minimal change — adding an optional parameter to existing endpoints rather than creating parallel endpoint sets. The `worktree` parameter defaults to the primary worktree when absent, preserving backward compatibility.

**Security**: Every endpoint must validate the `worktree` parameter against `git worktree list` output before using it as a `docker exec -w` path. Reuse the `validateWorktreePath()` helper from R4.
