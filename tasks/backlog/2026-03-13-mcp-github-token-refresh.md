# MCP Tool for GitHub Token Refresh in Long-Running ACP Sessions

**Created**: 2026-03-13
**Priority**: High
**Classification**: `cross-component-change`, `business-logic-change`

## Problem

Long-running ACP sessions (Claude Code agent) fail to push code or interact with GitHub after ~1 hour because the `GH_TOKEN` environment variable injected at session start contains a GitHub App installation token that expires after 1 hour.

### Live environment observation (2026-03-13)

Tested from inside a running ACP session. The current state:

1. **`GH_TOKEN` env var** — set at session start (40 chars), static, will expire after ~1 hour
2. **`gh` CLI wrapper** (`/usr/bin/gh`) — IS installed and working. Calls `git credential fill` before every `gh` invocation. `gh` commands survive token expiration.
3. **Git credential helper** (`/usr/local/bin/git-credential-sam`) — IS configured. `git push`/`git fetch` get fresh tokens on demand.
4. **`gh auth setup-git`** — was NOT run automatically. Initial `git push` via HTTPS failed until this was run manually, which sets up the gh credential helper for git operations.

### Why existing refresh mechanisms don't fully solve this

The codebase has two token refresh mechanisms that cover most cases, but gaps remain:

1. **gh wrapper** (`bootstrap.go:1527-1576`): Wraps `gh` CLI to call `git credential fill` before every invocation. Works for `gh pr create`, `gh pr view`, etc.

2. **git credential helper** (`bootstrap.go:1578+`): Configured in container for `git push`/`git fetch`. Calls VM agent → control plane for fresh tokens.

**Remaining gaps:**

- **`gh auth setup-git` not automatic**: The git credential helper for HTTPS remotes requires `gh auth setup-git` to be run, which doesn't happen during bootstrap. First `git push` fails until the agent figures this out. (This may be the primary failure mode the user is seeing.)
- **Raw `GH_TOKEN` reads**: Any tool/script that reads `$GH_TOKEN` directly (not through `gh` or `git`) uses the expired static token.
- **Token caching**: If Claude Code or any tool caches the token value at startup, it won't pick up the credential helper refresh.
- **Error recovery UX**: When auth fails, the agent has no structured way to get a fresh token — it has to guess at running `git credential fill` or similar.

### Diagnosis needed

Before implementing, we should confirm which specific failure mode is hitting in practice:

1. **Is `gh auth setup-git` the missing piece?** If so, adding it to bootstrap may be the simpler fix.
2. **Is something reading `GH_TOKEN` directly?** If so, the MCP tool approach is the right fix.
3. **Is the credential helper chain broken?** E.g., callback token expired, VM agent endpoint unreachable.

### Related work

- `tasks/active/2026-02-23-gh-token-empty-in-workspaces.md` — addresses GH_TOKEN being empty at provisioning time (different issue: token absent vs. token expired)
- `docs/notes/2026-03-08-mcp-token-revocation-postmortem.md` — credential lifecycle mismatch lesson (token lifetime must match session lifetime)

## Two-Part Solution

### Part 1 (Quick fix): Run `gh auth setup-git` during bootstrap

The gh wrapper is installed but `gh auth setup-git` is never called. This means the git credential helper isn't registered for HTTPS remotes — `git push` fails on the first attempt. Adding this single command to the bootstrap sequence (`bootstrap.go`, after `installGhWrapper()`) would likely fix the most common failure mode.

### Part 2 (Robust fix): `refresh_github_token` SAM MCP Tool

Add a new tool to the SAM MCP server that agents can call to obtain a fresh GitHub token. This follows the existing pattern of SAM MCP tools (`get_instructions`, `update_task_status`, `complete_task`) and leverages the existing infrastructure for GitHub App installation token generation.

### Architecture

```
Agent encounters auth failure
  → Calls `refresh_github_token` via SAM MCP server
  → MCP handler (apps/api/src/routes/mcp.ts)
     → Looks up workspace from MCP token data (KV)
     → Gets workspace's installationId from DB
     → Calls getInstallationToken() (apps/api/src/services/github-app.ts:146-175)
     → Returns { token, expiresAt } to agent
  → Agent exports new GH_TOKEN in its shell environment
  → Continues working
```

### Why MCP tool (vs other approaches)

1. **Agent-initiated**: The agent knows when it hits an auth error and can proactively refresh
2. **Existing infrastructure**: SAM MCP server is already injected into every ACP session with auth
3. **No VM agent changes needed**: The API handles token generation; MCP auth handles authorization
4. **Consistent pattern**: Follows the same tool pattern as `complete_task` and `update_task_status`
5. **Instruction-driven**: `get_instructions` can tell the agent to call this tool preemptively or on auth failure

### Alternative considered: Proactive env var refresh

A background process on the VM agent could periodically refresh `GH_TOKEN` in `/etc/sam/env` and the running process. Rejected because:
- Cannot update env vars in a running `docker exec` process
- Would require a sidecar or signal-based refresh mechanism — overengineered
- The agent is best positioned to know when it needs a fresh token

## Detailed Tasklist

### Bootstrap fix (packages/vm-agent/)

- [ ] Add `gh auth setup-git` call in `bootstrap.go` after `installGhWrapper()` returns
  - Run inside the container: `docker exec <containerID> gh auth setup-git`
  - Non-fatal: log warning on failure (same pattern as gh wrapper install)
  - This registers the gh credential helper for HTTPS git operations
- [ ] Verify the git credential helper is properly configured after bootstrap
- [ ] Test: `git push` works without manual `gh auth setup-git` in a fresh workspace

### API changes (apps/api/)

- [ ] Add `refresh_github_token` to `MCP_TOOLS` array in `apps/api/src/routes/mcp.ts`
  - Name: `refresh_github_token`
  - Description: "Fetch a fresh GitHub token when the current one has expired. Returns a new token valid for ~1 hour. Use this when you encounter GitHub authentication failures (401/403) during git push, gh CLI, or GitHub API calls."
  - Input schema: empty object (no parameters needed)
- [ ] Implement `handleRefreshGithubToken()` handler in `mcp.ts`
  - Authenticate via MCP token (existing `authenticateMcpRequest`)
  - Look up workspace by `tokenData.workspaceId` to get `installationId`
  - Call `getInstallationToken(env, installationId)` from `github-app.ts`
  - Return `{ token, expiresAt }` as MCP tool result content
  - If workspace has no `installationId`, return helpful error message
- [ ] Add routing for new tool in the MCP `tools/call` handler switch
- [ ] Add unit tests for the new handler (happy path, no installation, expired MCP token)

### Agent instruction changes

- [ ] Update `handleGetInstructions()` in `mcp.ts` to include guidance about token refresh
  - Add to instructions: "If you encounter GitHub authentication errors (HTTP 401 or 403, or 'bad credentials' messages), call the `refresh_github_token` tool to get a fresh token, then run `export GH_TOKEN=<returned_token>` before retrying."
- [ ] Consider adding proactive refresh guidance: "For sessions longer than 45 minutes, consider calling `refresh_github_token` before critical git operations."

### Testing

- [ ] Unit test: `refresh_github_token` returns fresh token for workspace with valid installation
- [ ] Unit test: `refresh_github_token` returns error for workspace without GitHub App installation
- [ ] Unit test: `refresh_github_token` with invalid/expired MCP token returns 401
- [ ] Integration consideration: verify end-to-end on staging with a long-running session

## Acceptance Criteria

- [ ] Agent in ACP session can call `refresh_github_token` MCP tool and receive a valid GitHub token
- [ ] Agent instructions mention the tool and when to use it
- [ ] Token returned matches the same format/scope as the initial injection
- [ ] MCP token auth is required (no unauthenticated access to token generation)
- [ ] Error cases handled gracefully (no installation, missing workspace)
- [ ] Existing MCP tools (`get_instructions`, `update_task_status`, `complete_task`) unaffected

## Key Files

| File | Change |
|------|--------|
| `apps/api/src/routes/mcp.ts` | Add tool definition + handler |
| `apps/api/src/services/github-app.ts` | No changes (existing `getInstallationToken` reused) |
| `apps/api/src/routes/workspaces/runtime.ts` | Reference only (existing `/git-token` endpoint pattern) |
| `packages/vm-agent/` | No changes needed (MCP server config already injected) |

## Security Considerations

- The MCP token is already scoped to a specific workspace/task/user — no additional auth needed
- Installation tokens are short-lived (~1 hour) and scoped to the GitHub App's permissions
- Token is returned over the existing MCP HTTPS channel (same security as `get_instructions`)
- No credential storage changes — tokens are ephemeral and used immediately
