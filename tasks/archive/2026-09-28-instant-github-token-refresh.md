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
- [x] Add standalone `gh` shim so `gh` refreshes through the SAM credential helper instead of using stale inherited `GH_TOKEN` (final design: one boot-time shim in `/var/lib/vm-agent/agents/bin`, see Independent Review).
- [x] Add API cache tests proving expired cached installation tokens are ignored and unexpired cached tokens are reused.
- [x] Add an expiry refresh margin with a `DEFAULT_*` constant and env override.
- [x] Verify full-VM credential path is not regressed.
- [x] Query production logs for Instant git-token failures / 401s.
- [x] Deploy to staging, start an Instant session, force or simulate expiry, prove git/gh operation succeeds, and clean up.
  - First staging pass proved `git credential fill` returned a redacted GitHub credential, but `gh auth status` still failed when `GH_TOKEN=<invalid GitHub-shaped test token>`; container inspection showed `PATH=/var/lib/vm-agent/agents/bin:/var/lib/vm-agent/agents/npm/bin:/usr/local/bin:/usr/bin:/bin`, `command -v gh=/usr/bin/gh`, no `/usr/local/bin/gh`, and no `.real` wrapper.
  - Follow-up fix installs a `/usr/local/bin/gh` shim when that directory precedes the discovered real `gh` in `PATH`, leaving `/usr/bin/gh` untouched. (Superseded: that shim could never be written as `node`; see Independent Review.)
- [x] Open a draft PR and leave it draft: https://github.com/raphaeltm/simple-agent-manager/pull/2174

## Acceptance Criteria

- Exact stale-token source is cited in the PR.
- Instant git and gh credential paths return fresh, unexpired tokens by refreshing before expiry.
- Regression test goes through the real helper/endpoint path and fails on current main.
- Control test proves unexpired cached tokens are reused.
- Full-VM control remains passing.
- Production log query and staging verification evidence are recorded in the PR.
- VM-agent rollout compatibility is considered; any API contract change is additive/backward compatible.

## Validation Evidence

> Historical record of the first implementation. The shipped design and its evidence are in "Independent Review" below.

- Red-before-fix regression: `go test ./internal/server -run TestStandaloneGitCredentialHelperDelegatesGitHubToLocalExchange -count=1` failed on the stale `GH_TOKEN` path, returning `<expired fixture token>` instead of the endpoint token.
- Passing focused vm-agent credential and `gh` wrapper tests: `go test ./internal/server -run 'TestStandaloneGitCredentialHelper|TestStandaloneGhWrapper|TestConfigureStandaloneGhWrapper|TestHandleGitCredential|TestPerSessionGitTokenFetcher|TestTwoWorkspaceGitTokenIsolation|TestGitHubTokenFetcherForWorkspace' -count=1`.
- Passing full vm-agent control: `go test ./...` in `packages/vm-agent` before and after the staging-discovered `/usr/local/bin/gh` shim fix.
- Passing API cache tests: `pnpm vitest run apps/api/tests/unit/services/github-installation-token-cache.test.ts`.
- Passing API checks: `pnpm --filter @simple-agent-manager/api typecheck` and `pnpm --filter @simple-agent-manager/api lint`.
- Passing formatting/diff checks for touched files: Prettier ratchet and `git diff --check`.

## Production Log Query

- Workers Observability SQL query endpoint returned 403 for the available production debugging token, so I used the supported telemetry query endpoint and the production observability D1 database.
- Telemetry over the last 7 days found `git-token` traces, but no `workspace_git_token` or `Failed to fetch git token` traces. Path/status filtering in telemetry returned zero results even for all `/git-token` paths, so I did not treat it as complete request-status evidence.
- Production observability D1 `platform_errors` returned no rows in the last 7 days for git-token/GitHub-installation failures or 401/unauthorized variants.

## Staging Verification Notes

> Historical record of staging runs against superseded heads (up to `6aa2cc6ac`). Final-head staging evidence is in "Independent Review" below.

- Deploy run `36417133346` for `da0f91153` passed deploy and smoke tests. Manual Instant verification showed `git credential fill` could return a redacted GitHub credential but `gh auth status` failed with the deliberately invalid inherited `GH_TOKEN`, proving `gh` still bypassed the wrapper.
- Deploy run `36420384172` for `5e8c8c28c` passed deploy and smoke tests. Manual inspection in Instant workspace `01M3M01NM7FND9YHPBD7AC274H`, session `c719bad0-8ff9-40ee-a10f-ed734245fbbe`, showed `PATH=/var/lib/vm-agent/agents/bin:/var/lib/vm-agent/agents/npm/bin:/usr/local/bin:/usr/bin:/bin`, `command -v gh=/usr/bin/gh`, no `/usr/local/bin/gh`, no `/usr/bin/gh.real`, and `git credential fill` returned redacted credentials. This identified the need for a shadow shim in `/usr/local/bin`.
- Deploy run `36422950111` for `e33a24860` passed deploy and smoke tests; follow-up manual verification showed the `/usr/local/bin` shim still was not present in the Instant agent shell, so the fix moved the agent-facing shim to `/var/lib/vm-agent/agents/bin` and forced that directory first in standalone ACP `PATH`.
- Attempted staging KV invalidation for the GitHub installation-token key was blocked by Cloudflare auth error code 10000 with the available token; remote KV key listing worked, deletion did not.

- Deploy run `36425315441` for `20b5302a5` passed deploy and smoke tests, but manual Instant workspace `01M3M2J7ZASWHJSZZ0DZGT9ZPF`, session `296540b9-225e-4fd0-a842-c10c8b6c959c`, still resolved `gh` to `/usr/bin/gh` with no `/usr/local/bin/gh`; this showed `exec.LookPath("gh")` in the vm-agent process can miss `gh` even when user shells find it. Added explicit `/usr/bin/gh` and `/bin/gh` fallback discovery.

- Added ACP standalone startup shim in `/var/lib/vm-agent/agents/bin/gh` because staged Instant shells put that directory first in `PATH`; this directly covers the Claude/Codex process path where `/usr/local/bin/gh` was not present.

- Added explicit standalone ACP `PATH=/var/lib/vm-agent/agents/bin:/usr/local/bin:/usr/bin:/bin` so the agent process resolves the managed `gh` shim before `/usr/bin/gh`.

- Deploy run `36433161674` for `6aa2cc6ac` passed deploy and smoke tests. Final Instant verification in task `01M3M66T78MW6KK609YENG1AAT`, session `342721ad-867a-406c-8859-7e747475fcec`, workspace `01M3M66TXM7CNE0TCZSPD7FAF8`, showed `GH_PATH=/var/lib/vm-agent/agents/bin/gh`; with `GH_TOKEN=<invalid GitHub-shaped test token>`, `git fetch --dry-run origin` succeeded, `gh auth status -h github.com` succeeded, and `git credential fill` returned `FINAL_CREDENTIAL_PREFIX_OK=<redacted GitHub token prefix>`. Cleanup note: session stop route returned staging 500 requestId `68c50057-7ad6-4613-82ba-2faa2a956c21`, while workspace stop reported `Workspace is stopped` (already cleaned up).

## Independent Review (task 01M3M8H10XQ426GNFQHRW1EZG7, 2026-09-28)

Adversarial second look before shipping. Findings and fixes, all on this branch:

- [x] HIGH: the forced standalone ACP `PATH=/var/lib/vm-agent/agents/bin:/usr/local/bin:/usr/bin:/bin` dropped `/var/lib/vm-agent/agents/npm/bin`, the image's `NPM_CONFIG_PREFIX` bin directory, so every `npm install -g` tool vanished from agent shells. The override was also redundant: `apps/api/Dockerfile.vm-agent-container` already puts `/var/lib/vm-agent/agents/bin` first on PATH. Removed; `TestAgentEnvLeavesPATHToTheRuntime` pins both runtimes (red with the override re-added).
- [x] HIGH: dead and duplicated `gh` wrapper code. The boot-time `/usr/local/bin/gh` wrapper can never be written because the vm-agent runs as `node` and `/usr/local/bin` is root-owned (staging runs showed no `/usr/local/bin/gh`); its rename-to-`gh.real` branch double-wraps on re-run; a second copy of the script (and `shellSingleQuote`) lived in the acp package and was rewritten on every agent start. Replaced by one boot-time shim, `standalone_gh_shim.go`, installed by `ConfigureStandaloneGitCredentialHelper` into the node-owned first-on-PATH directory. It also covers terminals, which inherit the image PATH.
- [x] HIGH: unrelated SAM auto-commit (`chore: save agent work`) deleted `model_reasoning_effort` from `.codex/config.toml`. Reverted.
- [x] MEDIUM: the shim fell back to the inherited, possibly stale `GH_TOKEN` when the exchange failed, and it depended on `git credential fill` (user git config such as `gh auth setup-git` resets the helper list and routes the refresh back to the stale `GH_TOKEN`; git could also prompt on a TTY). The shim now calls `/usr/local/bin/git-credential-sam get` directly and, when the exchange yields nothing, unsets the inherited `GH_TOKEN` with a one-line stderr diagnostic (policy: fail closed instead of insecure fallback). The VM wrapper (`bootstrap.go:installGhWrapper`) keeps its fallback; parity is tracked in SAM idea `01KTXY97S095SKNGDXWYYWVB6T` (its Fix 2).
- [x] MEDIUM: `GITHUB_INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS` was unbounded; a margin at or above GitHub's one-hour lifetime would mint on every credential exchange. Capped at 1800 s (half the lifetime) through `resolveInstallationTokenRefreshMarginSeconds`; divergence and convergence tests go through `getInstallationToken`.
- [x] Rule 62: the helper regression used a fake endpoint and the gh test used a fake `git` that hand-fed the token. Replaced by capability tests that enter the way production does: real `git credential fill` → rendered helper → real `/git-credential` handler → fake control plane, and `gh` resolved by PATH → shim → helper → handler. Red-before-fix against main's helper: the git test, the gh test, and `TestStandaloneGitCredentialHelperNoWorkspaceNoOutput` all fail (they receive the stale session token); the GitLab control passes. Each shim guard was deleted once and its test went red.
- [x] Test hermeticity: the standalone tests inherited the developer's `SAM_WORKSPACE_ID`, `GH_TOKEN`, and `GIT_CONFIG_COUNT`-injected helper. `hermeticEnv` now scrubs them.
- [x] Docs: public `reference/configuration.md` gained the margin row; env reference, `.env.example`, and `env.ts` state the cap.
- [x] Contract: `cf-container-runtime-contract.test.ts` ties the Go shim directory to the first image PATH entry.

Pre-existing gap found, not caused by this PR (tracked in SAM idea `01M25BMJ7FCB3RWQSNE38GAYKX`, the idea this PR implements, under "Still open after #2174"): the vm-agent's own git and `gh` calls in standalone mode (task-completion auto-push, `gh pr create`, lazy partial-clone blob fetches) run with the vm-agent environment, which has neither `SAM_WORKSPACE_ID` nor `GH_TOKEN`, so the helper yields no credential both before and after this PR. Terminals have the same gap.

Second review round (same task), all fixed on the branch:

- [x] cloudflare-specialist HIGH (pre-existing, amplified here): the `/git-token` owner check called `assertRepositoryAccess` without `env`, so its user-access KV cache never engaged and every exchange paid a paginated GitHub repository listing on the owner's OAuth quota. Now forwards `env`; `workspace-git-token.test.ts` pins the forwarded env (red without the fix). Commit `1cdff5f8c`.
- [x] go-specialist / task-completion-validator HIGH (test-only): parallel gh-shim subtests appended PATH into one shared env backing array (a real race, also causing flaky `gh: not found` without `-race`). `runGh` appends to a clipped slice and `hermeticEnv` returns a clipped slice; five races reproduced without the fix, none with it; full `go test -race ./...` green. Commit `05fed9bb5`.
- Deferred with justification (pre-existing, unchanged lines, need corruption or a manual sub-60s TTL edit): KV cache hardening for malformed JSON and the 60 s `expirationTtl` floor, SAM idea `01M3MBHQPB0R1WQREWXTBX0TPG`.

---

_Reconciled 2026-09-30 (weekly queue reconciliation): shipped via PR #2174 (`397c6f2e5`, merged 2026-09-28), first successful production deploy run 36505648204. Every checklist item was already ticked._
