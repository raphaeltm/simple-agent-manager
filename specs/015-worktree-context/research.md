# Research: Worktree Context Switching

**Feature**: 015-worktree-context
**Date**: 2026-02-17

## Research Questions & Findings

### RQ-1: How to make worktree directories visible inside the devcontainer?

**Context**: Git worktrees are created as sibling directories to the primary checkout. For the container to see them, the mount must include the parent directory.

**Decision**: No change needed — the existing named volume setup already mounts at `/workspaces` (the parent directory).

**Rationale**:
The current devcontainer override config (from `bootstrap.go`) already sets:
```json
{
  "workspaceMount": "source=sam-ws-<id>,target=/workspaces,type=volume",
  "workspaceFolder": "/workspaces/<repo>"
}
```
The named volume `sam-ws-<workspaceId>` is mounted at `/workspaces` (the parent), not at `/workspaces/<repo>`. The `populateVolumeFromHost()` function copies the host clone into `/workspaces/<repoDirName>` within the volume. This means any new directories created under `/workspaces/` — including git worktree siblings — are automatically visible inside the container.

**No alternatives needed**: The existing architecture already supports this. Git worktree operations running inside the container (e.g., `git worktree add ../my-repo-wt-feature /workspaces/my-repo-wt-feature`) create sibling directories within the same volume mount.

**Implementation Notes**:
- No devcontainer config changes required
- No volume mount changes required
- New worktrees created at `/workspaces/<repo-name>-wt-<branch>` are immediately accessible
- The `ContainerWorkDir` for the primary worktree remains unchanged
- Security: worktree path validation ensures only paths within `/workspaces/` are accessible
- Multi-workspace nodes: each workspace has its own isolated volume, so worktrees are per-workspace (correct isolation)

### RQ-2: How should worktree path validation work?

**Context**: The `worktree` query parameter on git/files/agent endpoints must be validated server-side to prevent directory traversal attacks.

**Decision**: Validate against `git worktree list --porcelain` output, cached per workspace with 30-second TTL.

**Rationale**:
- `git worktree list --porcelain` is the canonical source of truth for valid worktree paths
- Caching avoids re-running the command on every request while staying reasonably fresh
- Path must appear verbatim in the output (no normalization tricks)
- Additional check: path must be under `/workspaces/` prefix

**Alternatives Considered**:
1. **No caching, validate every request**: Rejected due to performance — every git/files/agent call would require a `docker exec git worktree list` round-trip.
2. **Validate path prefix only** (e.g., starts with `/workspaces/`): Rejected because it allows access to any directory under `/workspaces/`, not just valid worktrees.
3. **Maintain an in-memory worktree registry**: Rejected as more complex and prone to stale state vs. querying git directly.

**Implementation Notes**:
- Cache key: `worktreeList:<workspaceId>`
- Cache TTL: 30 seconds (configurable via `WORKTREE_CACHE_TTL_SECONDS` env var)
- Invalidate cache on create/remove operations (immediate freshness after mutations)
- Porcelain format output parsing: `worktree <path>\nHEAD <sha>\nbranch refs/heads/<name>\n\n`

### RQ-3: Is the devcontainer mount already compatible with worktrees?

**Context**: Git worktrees require sibling directories to be visible inside the container.

**Decision**: No changes needed — the current mount is already compatible.

**Rationale**:
The existing `bootstrap.go` implementation already sets `workspaceMount` to `target=/workspaces` (the parent directory) and `workspaceFolder` to `/workspaces/<repo>`. This was implemented as part of the devcontainer-named-volumes work. The volume contains the entire `/workspaces/` directory tree, so any sibling worktree directories created by `git worktree add` are automatically visible.

**Key code** (from `writeMountOverrideConfig()` in `bootstrap.go`):
```go
configJSON := fmt.Sprintf(`{
  "workspaceMount": "source=%s,target=/workspaces,type=volume",
  "workspaceFolder": "/workspaces/%s"
}`, volumeName, repoDirName)
```

**Implementation Notes**:
- No devcontainer or volume changes required for this feature
- This simplifies the implementation plan — Phase 7 (devcontainer mount change) is eliminated

### RQ-4: How should the ACP session CWD be set for worktree-scoped sessions?

**Context**: The ACP protocol's `NewSession` and `LoadSession` accept a `Cwd` parameter. Currently this is always `ContainerWorkDir` (e.g., `/workspaces/my-repo`).

**Decision**: Pass the worktree path as the `Cwd` parameter instead of `ContainerWorkDir` when a worktree is specified.

**Rationale**:
- The ACP protocol already supports arbitrary CWD — no protocol changes needed
- `NewSession(Cwd: "/workspaces/my-repo-feature-auth")` starts the agent in the worktree directory
- This is the agent's permanent CWD for the session lifetime
- `LoadSession` also receives the worktree CWD for session recovery

**Alternatives Considered**:
1. **Set CWD to primary worktree and let agent `cd`**: Rejected because the agent's initial context (file tree, git status) would be wrong until it navigates.
2. **Use environment variable to hint the worktree**: Rejected as unnecessary — CWD is the direct, clean mechanism.

**Implementation Notes**:
- `agent_ws.go`: Accept `worktree` query param on WebSocket upgrade
- Validate worktree path before creating SessionHost
- Pass validated worktree path to `GatewayConfig.ContainerWorkDir`
- If no worktree param, fall back to existing `runtime.ContainerWorkDir` (backward-compatible)
- The worktree path must be persisted in the agent session record (DB + VM Agent local SQLite)

### RQ-5: How should terminal PTY sessions be scoped to worktrees?

**Context**: PTY sessions currently inherit the workspace's `ContainerWorkDir` from the PTY Manager. For worktree support, new terminals should start in the active worktree's directory.

**Decision**: Accept an optional `worktree` query parameter on the terminal WebSocket connection that sets the CWD for new PTY sessions created on that connection.

**Rationale**:
- Minimal change to the existing architecture
- The multi-terminal protocol already supports creating sessions via the WebSocket
- The worktree CWD is set at session creation time and is immutable (changing directory is up to the user)
- Existing terminals are unaffected (they keep their original CWD)

**Alternatives Considered**:
1. **Per-session CWD in the create-session message**: Would require multi-terminal protocol changes. More complex, deferred to future enhancement.
2. **Modify PTY Manager's WorkDir dynamically**: Rejected because it would affect ALL sessions, not just new ones.

**Implementation Notes**:
- Terminal WebSocket URL: `wss://ws-{id}.domain/terminal/ws/multi?token=JWT&worktree=/workspaces/my-repo-feature`
- On connection, validate worktree path
- New sessions on this connection use the worktree path as CWD via `docker exec -w <worktreePath>`
- PTY Manager gains `CreateSessionWithWorkDir(sessionID, userID, rows, cols, workDir string)` method

### RQ-6: What is the worktree naming convention for sibling directories?

**Context**: When creating a new worktree, we need a predictable, safe directory name for the sibling worktree directory.

**Decision**: Use `<repo-dir-name>-wt-<sanitized-branch-name>` as the worktree directory name, placed as a sibling to the primary worktree.

**Rationale**:
- The `-wt-` infix clearly identifies worktree directories vs. other directories
- The sanitized branch name is human-readable (useful for debugging via `ls`)
- Placed as siblings under `/workspaces/` — visible in the container

**Examples**:
- Primary: `/workspaces/my-repo`
- Branch `feature/auth`: `/workspaces/my-repo-wt-feature-auth`
- Branch `bugfix-42`: `/workspaces/my-repo-wt-bugfix-42`
- New branch `experiment/ui`: `/workspaces/my-repo-wt-experiment-ui`

**Sanitization Rules**:
- Replace `/` with `-`
- Remove leading/trailing `-`
- Collapse multiple `-` into one
- Truncate to 50 characters to avoid filesystem limits
- Lowercase

### RQ-7: How to persist worktree association for agent sessions across page reloads?

**Context**: Agent sessions are bound to a worktree at creation time. On page reload, the UI needs to know which worktree each session belongs to.

**Decision**: Add `worktree_path` column to the `agent_sessions` D1 table and include it in API responses.

**Rationale**:
- The control plane DB already stores agent session metadata (id, workspaceId, label, status)
- Adding `worktree_path` is a minimal schema change (nullable TEXT column, backward-compatible)
- The API already returns session data on list/create — adding the field is straightforward
- VM Agent local SQLite already stores tab metadata — `worktree_path` can be added there too

**Alternatives Considered**:
1. **Store in localStorage only**: Rejected because it doesn't survive browser changes and doesn't support multi-device access.
2. **Derive from agent session's actual CWD**: Rejected because querying the agent's CWD requires the agent to be running.
3. **Store in URL only**: Rejected because URLs are per-tab, not per-session — a session created on one tab needs to show its worktree on another tab.

**Implementation Notes**:
- D1 migration: `ALTER TABLE agent_sessions ADD COLUMN worktree_path TEXT;`
- `CreateAgentSessionRequest` gains optional `worktreePath?: string`
- `AgentSession` response type gains `worktreePath?: string | null`
- VM Agent `agentSessions.Create()` gains worktree path parameter
- VM Agent local SQLite tabs table gains `worktree_path` column
