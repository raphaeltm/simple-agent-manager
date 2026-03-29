# GH_TOKEN Empty in SAM Workspaces

**Created**: 2026-02-23
**Updated**: 2026-03-29
**Priority**: High
**Classification**: `cross-component-change`, `business-logic-change`

## Context

The `GH_TOKEN` environment variable is empty in SAM workspaces despite the GitHub token being available — the git credential helper at `/usr/local/bin/git-credential-sam` successfully fetches it on-demand from the VM agent's `/git-credential` endpoint, proving the token exists on the host side.

PR #179 added dynamic fallback infrastructure (shell-level credential helper for PTY sessions, `GitTokenFetcher` for ACP sessions), but a remaining bug caused the `GitTokenFetcher` to use the **node-level** workspace ID instead of the **per-session** workspace ID.

## Root Cause Analysis

### Original issue (PR #179 — resolved)
Token unavailable at bootstrap time → empty GH_TOKEN in env files. Fixed by adding dynamic fallback in `/etc/profile.d/sam-env.sh` and `GitTokenFetcher` in `session_host.go`.

### Remaining issue (this PR)
`GitTokenFetcher` is wired at the **server level** (`server.go:377`) as `s.fetchGitToken`, which always uses `s.config.WorkspaceID` (the node-level workspace ID). On multi-workspace nodes, this is wrong — each ACP session targets a different workspace but the fetcher always requests the token for the initial/node-level workspace.

**Root cause chain:**
1. `server.go:377`: `s.acpConfig.GitTokenFetcher = s.fetchGitToken` — binds server-level config
2. `git_credential.go:44-46`: `fetchGitToken()` calls `fetchGitTokenForWorkspace(ctx, s.config.WorkspaceID, s.config.CallbackToken)` — hardcoded to node config
3. `agent_ws.go:225`: `cfg := s.acpConfig` — copies the wrong fetcher to each session
4. `session_host.go:853-854`: Session calls `GitTokenFetcher` which hits the wrong workspace's `/git-token` endpoint → 404 or wrong token

### Fix
Override `GitTokenFetcher` per-session in `getOrCreateSessionHost()` with a closure that captures the correct workspace ID. The closure calls `fetchGitTokenForWorkspace(ctx, workspaceID, "")` which falls back to the per-workspace callback token via `callbackTokenForWorkspace()`.

## Detailed Tasklist

- [x] Read `packages/vm-agent/internal/server/workspace_provisioning.go` to understand the full provisioning flow
- [x] Read `packages/vm-agent/internal/server/git_credential.go` to understand token fetch
- [x] Read `apps/api/src/routes/workspaces.ts` around the `/git-token` endpoint
- [x] Check if `fetchGitTokenForWorkspace` has proper retry logic — it fails silently with warning
- [x] Analyze root cause: token unavailable at provisioning time → empty GH_TOKEN in env files
- [x] For PTY sessions: add dynamic GH_TOKEN fallback in `/etc/profile.d/sam-env.sh` via credential helper
- [x] For ACP sessions: add `GitTokenFetcher` to GatewayConfig, inject fresh GH_TOKEN in session_host.go
- [x] Separate shell script (with dynamic commands) from static env file (/etc/sam/env)
- [x] Update tests for new behavior (dynamic fallback block always present)
- [x] Fix: Override GitTokenFetcher per-session with correct workspace ID closure
- [x] Fix: Upgrade GH_TOKEN fetch failure logging from DEBUG to WARN
- [x] Add regression test: TestPerSessionGitTokenFetcherUsesCorrectWorkspaceID
- [x] Run Go tests: `cd packages/vm-agent && go test ./...`
- [ ] Test that GH_TOKEN is available in PTY sessions after fix (requires deployed workspace)
- [ ] Test that GH_TOKEN is available in ACP agent sessions after fix (requires deployed workspace)

## Files Modified

| File | Change |
|------|--------|
| `packages/vm-agent/internal/server/agent_ws.go` | Override GitTokenFetcher per-session with correct workspace ID |
| `packages/vm-agent/internal/server/server.go` | Clarify server-level fetcher is a default, overridden per-session |
| `packages/vm-agent/internal/acp/session_host.go` | Upgrade error logging from DEBUG to WARN, add success info log |
| `packages/vm-agent/internal/server/git_credential_test.go` | Add regression test for per-session workspace ID |

## Acceptance Criteria

- [ ] Per-session GitTokenFetcher uses the session's workspace ID, not the node-level ID
- [ ] GH_TOKEN fetch failures are logged at WARN level (visible in production)
- [ ] Successful GH_TOKEN injection is logged at INFO level
- [ ] Regression test verifies correct workspace ID is used
- [ ] Go tests pass
