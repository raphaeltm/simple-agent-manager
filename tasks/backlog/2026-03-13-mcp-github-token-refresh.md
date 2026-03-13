# MCP Tool for GitHub Token Refresh in Long-Running ACP Sessions

**Created**: 2026-03-13
**Priority**: High
**Classification**: `cross-component-change`, `business-logic-change`

## Problem

Long-running ACP sessions (Claude Code agent) fail to push code or interact with GitHub after ~1 hour because the `GH_TOKEN` environment variable injected at session start contains a GitHub App installation token that expires after 1 hour.

### Why existing refresh mechanisms don't fully solve this

The codebase already has two token refresh mechanisms, but neither covers all agent usage patterns:

1. **gh wrapper** (`bootstrap.go:1527-1576`): Wraps the `gh` CLI binary to call `git credential fill` before every `gh` invocation. Works for `gh pr create`, `gh pr view`, etc. — but only when the agent uses the `gh` CLI directly.

2. **git credential helper** (`bootstrap.go:1578+`): Configured in the container to call the VM agent's `/git-credential` endpoint for every `git push`/`git fetch`. Works for git operations — but only for `git` CLI commands.

**Gap**: The `GH_TOKEN` environment variable itself is never refreshed. If the agent (or any tool it uses) reads `GH_TOKEN` directly — e.g., for GitHub API calls, or if a tool caches the token from the env var at startup — it will use the expired 1-hour token. Additionally, some agent workflows may encounter confusing auth errors and not know how to recover.

### Related work

- `tasks/active/2026-02-23-gh-token-empty-in-workspaces.md` — addresses GH_TOKEN being empty at provisioning time (different issue: token absent vs. token expired)
- `docs/notes/2026-03-08-mcp-token-revocation-postmortem.md` — credential lifecycle mismatch lesson (token lifetime must match session lifetime)

## Proposed Solution: `refresh_github_token` SAM MCP Tool

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
