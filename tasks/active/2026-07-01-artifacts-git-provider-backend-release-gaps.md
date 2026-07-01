# Artifacts Git Provider Backend Release Gaps

## Problem

Cloudflare Artifacts-backed repositories are close to usable, but several backend gaps block release:

- vm-agent credential helper filtering prevents Artifacts fetch/push after the initial short-lived token expires.
- Provider-unaware `GH_TOKEN` injection can expose Artifacts tokens to GitHub tooling and produces incorrect auth behavior.
- Wrangler Artifacts bindings need per-environment opt-in so self-hosters and forks without Artifacts access can still deploy.
- `/git-token` should defensively handle both `expiresAt` and `expires_at` from the beta binding.
- Artifacts repos are silently orphaned when projects are deleted unless a supported binding deletion API exists.

UI onboarding is explicitly out of scope for this task.

## Research Findings

- Source spec: SAM idea `01KWFTHC623QX7RG756SS9FG8T`, "Artifacts git provider: release-gap fixes".
- vm-agent files:
  - `packages/vm-agent/internal/bootstrap/bootstrap.go`
  - `packages/vm-agent/internal/server/git_credential.go`
  - `packages/vm-agent/internal/server/agent_ws.go`
  - `packages/vm-agent/internal/acp/session_host_startup.go`
- API/deploy files:
  - `apps/api/src/env.ts`
  - `apps/api/src/routes/workspaces/runtime.ts`
  - `apps/api/src/routes/projects/crud.ts`
  - `scripts/deploy/sync-wrangler-config.ts`
  - `apps/api/wrangler.toml`
- Existing tests to extend:
  - `packages/vm-agent/internal/bootstrap/bootstrap_test.go`
  - `packages/vm-agent/internal/server/git_credential_test.go`
  - `packages/vm-agent/internal/server/agent_ws_test.go`
  - `packages/vm-agent/internal/acp/session_host_startup.go` related tests
  - `apps/api/tests/unit/artifacts-project-creation.test.ts`
  - deploy script tests under `scripts/deploy` or adjacent test setup
- Applicable rules:
  - `.claude/rules/14-do-workflow-persistence.md`
  - `.claude/rules/27-vm-agent-staging-refresh.md`
  - `.claude/rules/35-vertical-slice-testing.md`
  - `.claude/rules/06-vm-agent-patterns.md`
  - `.claude/rules/32-cf-api-debugging.md`

## Implementation Checklist

### PR 1: Workstream A, vm-agent

- [x] Move `isGitHubRepo`, `isArtifactsHost`, and `isKnownGitHost` into a small shared internal package imported by bootstrap and server code.
- [x] Update the rendered `git-credential-sam` shell script to allow GitHub and Artifacts hosts while silently ignoring unknown hosts.
- [x] Forward the requested credential host to `/git-credential` without changing the existing loopback auth model.
- [x] Add server-side host/provider mismatch handling in `handleGitCredential` that returns no credential for mismatched requested hosts.
- [x] Gate gh-wrapper installation on GitHub repositories only.
- [x] Gate shell startup `GH_TOKEN` fallback generation on GitHub repositories only.
- [x] Gate ACP `GitTokenFetcher` setup on GitHub repositories only, including secondary workspace repository resolution.
- [x] Extend Go tests for credential helper rendering, host mismatch handling, and `GH_TOKEN`/`GitTokenFetcher` gating.
- [x] Run `go test ./...` and `go test -race ./...` in `packages/vm-agent`.
- [ ] Verify staging with fresh vm-agent nodes: delete staging nodes first, deploy branch, test GitHub-path non-regression in a fresh project chat, and document Artifacts live-path gap if staging still lacks the binding.

### PR 2: Workstreams C + D, deploy gating and token expiry shape

- [ ] Uncomment top-level `[[artifacts]]` in `apps/api/wrangler.toml` only with safe env gating in the sync script.
- [ ] Add explicit per-environment Artifacts binding opt-in to `scripts/deploy/sync-wrangler-config.ts`, following existing conditional binding patterns.
- [ ] Keep runtime `ARTIFACTS_ENABLED` coherent with the binding and disabled by default.
- [ ] Verify/update `quality:wrangler-bindings` expectations if needed for top-level-present/env-conditional bindings.
- [ ] Update `apps/api/src/env.ts` binding type to support both `expiresAt` and `expires_at`.
- [ ] Update `apps/api/src/routes/workspaces/runtime.ts` to return `tokenResult.expiresAt ?? tokenResult.expires_at`.
- [ ] Add tests for generated Wrangler config with Artifacts binding enabled and disabled.
- [ ] Add tests for both Artifacts token expiry field shapes.

### PR 3: Workstream B, Artifacts repo lifecycle

- [ ] Verify the real Cloudflare Artifacts binding API surface before adding any repo delete call.
- [ ] If a supported delete API exists, perform best-effort repo deletion before D1 row deletion and log structured cleanup failures without blocking project deletion.
- [ ] If no supported delete API exists, emit a structured orphan log on project delete with `action: 'orphaned_artifacts_repo_on_delete'`.
- [ ] Add a code comment clarifying that `ARTIFACTS_MAX_REPOS_PER_USER` counts project rows and orphans require manual reconciliation for now.
- [ ] Add tests for artifacts project delete cleanup/orphan behavior, cleanup failure preserving project deletion, and GitHub project delete not touching Artifacts.

## Acceptance Criteria

- GitHub-backed projects keep current behavior by default.
- Artifacts-backed projects can refresh credentials through the helper without leaking tokens into `GH_TOKEN`.
- Unknown git hosts continue to receive no credential response.
- Artifacts Worker binding remains disabled by default for environments without opt-in.
- `/git-token` responds with an expiry value for both beta binding field shapes.
- Project delete either best-effort deletes the Artifacts repo using a verified API or logs a structured orphan event.
- No tokens or plaintext credentials are logged.
- Each PR passes required local tests, specialist review, staging verification where applicable, CI, and merge gates.
