# GH_TOKEN Empty in SAM Workspaces

**Created**: 2026-02-23
**Priority**: High
**Classification**: `cross-component-change`, `business-logic-change`

## Context

The `GH_TOKEN` environment variable is empty in SAM workspaces despite the GitHub token being available — the git credential helper at `/usr/local/bin/git-credential-sam` successfully fetches it on-demand from the VM agent's `/git-credential` endpoint, proving the token exists on the host side.

Recent PR #158 (commit `87a94ad`) attempted to fix this by:
1. Renaming `GITHUB_TOKEN` to `GH_TOKEN` (gh CLI preference)
2. Adding `-l` flag to bash for login shell (sources `/etc/profile.d/`)
3. Adding `ReadContainerEnvFiles()` to inject env vars into ACP sessions

## Root Cause Analysis

The suspected issue is that `ensureSAMEnvironment` in `bootstrap.go` is called with an empty `githubToken` argument because the token isn't yet available at bootstrap time.

### Call chain:

**Node-mode workspace provisioning** (primary path for multi-workspace nodes):
1. `workspace_provisioning.go:84` — `gitToken, err := s.fetchGitTokenForWorkspace(provisionCtx, runtime.ID, callbackToken)`
2. `git_credential.go:48-68` — `fetchGitTokenForWorkspace()` makes HTTP POST to `/api/workspaces/{workspaceId}/git-token`
3. `workspaces.ts:1799-1823` — API endpoint fetches GitHub installation token
4. `workspace_provisioning.go:103` — Token passed to `PrepareWorkspace()` as `bootstrap.ProvisionState{GitHubToken: gitToken}`
5. `bootstrap.go:169` — `ensureSAMEnvironment(ctx, cfg, state.GitHubToken)` writes env files

**Where it can fail:**
- `git_credential.go:84-90`: If `/git-token` endpoint fails, code logs warning and **continues with empty token** — does not fail provisioning
- `workspaces.ts:1806-1809`: If workspace has no `installationId`, returns 404
- The token fetch happens during provisioning, which may race with other setup

### Environment file generation:
- `bootstrap.go:1610-1620`: `buildSAMEnvScript()` — if `githubToken` is empty, the `GH_TOKEN` entry is **skipped entirely** (empty values are omitted)
- Files written: `/etc/profile.d/sam-env.sh` and `/etc/sam/env`

## Plan

1. Trace why the token fetch fails during provisioning — add better error logging
2. Consider making the git token fetch retry with backoff
3. If token unavailable at bootstrap, implement a mechanism to update env files when token becomes available
4. Alternatively, have the env script source the token dynamically via the credential helper

## Detailed Tasklist

- [ ] Read `packages/vm-agent/internal/server/workspace_provisioning.go` to understand the full provisioning flow
- [ ] Read `packages/vm-agent/internal/server/git_credential.go` to understand token fetch
- [ ] Read `apps/api/src/routes/workspaces.ts` around the `/git-token` endpoint (lines 1799-1823)
- [ ] Check if `fetchGitTokenForWorkspace` has proper retry logic or if it fails silently
- [ ] Check workspace records in the database — do workspaces have valid `installationId`?
- [ ] Add retry logic to `fetchGitTokenForWorkspace` if it doesn't exist
- [ ] Improve error logging when git token fetch fails
- [ ] Consider adding a "refresh env" mechanism that re-fetches the token and updates env files
- [ ] Alternatively: make `/etc/profile.d/sam-env.sh` dynamically source GH_TOKEN via the credential helper on shell startup
- [ ] Test that GH_TOKEN is available in PTY sessions after fix
- [ ] Test that GH_TOKEN is available in ACP agent sessions after fix
- [ ] Run Go tests: `cd packages/vm-agent && go test ./...`

## Files to Modify

| File | Change |
|------|--------|
| `packages/vm-agent/internal/server/workspace_provisioning.go` | Improve token fetch error handling/retry |
| `packages/vm-agent/internal/server/git_credential.go` | Add retry logic to token fetch |
| `packages/vm-agent/internal/bootstrap/bootstrap.go` | Possibly make env script dynamically source token |
| `apps/api/src/routes/workspaces.ts` | Verify /git-token endpoint correctness |
