# Fix Instant GitHub token refresh

## Problem

Instant (`cf-container` / standalone vm-agent) sessions can lose GitHub access after roughly one hour. GitHub App installation tokens expire after one hour, and the standalone git credential helper currently serves the process `GH_TOKEN` for GitHub operations instead of asking the vm-agent `/git-credential` endpoint for a fresh token. The standalone runtime also lacks the full-VM `gh` wrapper, so `gh` can keep reading the stale inherited `GH_TOKEN`.

## Research Findings

- `packages/vm-agent/internal/server/standalone_git.go` renders the standalone helper. Its GitHub branch reads `GH_TOKEN` directly and exits before the endpoint path; the same standalone setup did not wrap `gh`, leaving the CLI to read stale inherited `GH_TOKEN`.
- `packages/vm-agent/internal/server/git_credential.go` implements `/git-credential`; it fetches `POST /api/workspaces/:id/git-token` with the workspace callback token.
- `packages/vm-agent/internal/bootstrap/bootstrap.go` full-VM setup sanitizes remotes after clone and installs a helper plus `gh` wrapper that refresh from `git credential fill`.
- `packages/vm-agent/internal/server/standalone_workspace.go` only uses the fetched token for initial clone and then sanitizes origin, so the stale long-session source is the installed standalone helper/process environment, not a persisted remote URL.
- `apps/api/src/services/github-app.ts` caches installation tokens in KV and relies on KV TTL. It should also inspect token `expiresAt` so a too-long TTL override cannot return an expired token.
- `tasks/backlog/2026-04-08-credential-helper-per-workspace-directory.md` is related to host helper file placement for full VM mode, not this Instant token refresh path.

## Checklist

- [x] Update standalone helper so GitHub credential requests use `/git-credential` instead of static `GH_TOKEN`.
- [x] Preserve GitLab path-gated delegation and non-GitHub refusal behavior.
- [x] Add regression coverage proving a GitHub helper call with stale `GH_TOKEN` receives the fresh endpoint token.
- [x] Add standalone `gh` wrapper so `gh` refreshes through `git credential fill` instead of using stale inherited `GH_TOKEN`.
- [x] Add API cache tests proving expired cached installation tokens are ignored and unexpired cached tokens are reused.
- [x] Add an expiry refresh margin with a `DEFAULT_*` constant and env override.
- [x] Verify full-VM credential path is not regressed.
- [x] Query production logs for Instant git-token failures / 401s.
- [ ] Deploy to staging, start an Instant session, force or simulate expiry, prove git/gh operation succeeds, and clean up.
- [ ] Open a draft PR and leave it draft.

## Acceptance Criteria

- Exact stale-token source is cited in the PR.
- Instant git and gh credential paths return fresh, unexpired tokens by refreshing before expiry.
- Regression test goes through the real helper/endpoint path and fails on current main.
- Control test proves unexpired cached tokens are reused.
- Full-VM control remains passing.
- Production log query and staging verification evidence are recorded in the PR.
- VM-agent rollout compatibility is considered; any API contract change is additive/backward compatible.

## Validation Evidence

- Red-before-fix regression: `go test ./internal/server -run TestStandaloneGitCredentialHelperDelegatesGitHubToLocalExchange -count=1` failed on the stale `GH_TOKEN` path, returning `ghs_expired_boot_token` instead of the endpoint token.
- Passing focused vm-agent credential and `gh` wrapper tests: `go test ./internal/server -run 'TestStandaloneGitCredentialHelper|TestStandaloneGhWrapper|TestConfigureStandaloneGhWrapper|TestHandleGitCredential|TestPerSessionGitTokenFetcher|TestTwoWorkspaceGitTokenIsolation|TestGitHubTokenFetcherForWorkspace' -count=1`.
- Passing full vm-agent control: `go test ./...` in `packages/vm-agent`.
- Passing API cache tests: `pnpm vitest run apps/api/tests/unit/services/github-installation-token-cache.test.ts`.
- Passing API checks: `pnpm --filter @simple-agent-manager/api typecheck` and `pnpm --filter @simple-agent-manager/api lint`.
- Passing formatting/diff checks for touched files: Prettier ratchet and `git diff --check`.

## Production Log Query

- Workers Observability SQL query endpoint returned 403 for the available production debugging token, so I used the supported telemetry query endpoint and the production observability D1 database.
- Telemetry over the last 7 days found `git-token` traces, but no `workspace_git_token` or `Failed to fetch git token` traces. Path/status filtering in telemetry returned zero results even for all `/git-token` paths, so I did not treat it as complete request-status evidence.
- Production observability D1 `platform_errors` returned no rows in the last 7 days for git-token/GitHub-installation failures or 401/unauthorized variants.
