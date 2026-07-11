# GitLab Repository And Workspace Support WIP

## Status

Active WIP stacked PR branch on top of #1545 (`sam/gitlab-platform-config-wip`).

## Constraints

- DRAFT PR. DO NOT MARK READY. DO NOT MERGE.
- DO NOT DEPLOY TO STAGING, DO NOT RUN STAGING VERIFICATION, AND DO NOT MUTATE STAGING. Other agents are actively using staging.
- Skip /do Phase 6 by explicit user instruction and document that staging was intentionally skipped.
- Stop /do Phase 7 after updating the draft PR and observing/reporting CI; never merge.
- Do not commit a task file directly to main. Keep task records/state on this existing feature branch because the stack is intentionally unmerged.
- Avoid force-push unless absolutely unavoidable; preserve linear stacked ancestry with normal branch merges.
- Do not alter or merge PR #1545; consume its published branch head only.
- Do not create, update, or deploy any staging environment.
- Use the platform-level GitLab OAuth configuration added in the base PR.

## Context

PR #1545 adds the runtime platform configuration foundation for GitLab OAuth:

- GitLab OAuth host/client ID/client secret can be stored in the platform settings/credentials store.
- GitLab sign-in is visible when the provider is configured.
- Environment fallbacks remain available for self-hosters.

This follow-up implements repository/workspace support around that foundation.

The linked SAM idea is `01KV7ZFD6HZS5N7J45VA798KN1`, "GitLab integration using platform-level config". The important security invariant from that idea is that GitLab OAuth tokens are broader than GitHub App installation tokens, so they must not be exported as static workspace environment variables. Git credentials should be minted through the VM credential-helper path, checked against the exact GitLab host/project path, and refreshed on demand.

## Scope

- Allow GitLab-backed projects to be created from the project onboarding flow.
- Verify the signed-in user has GitLab project access at project creation and task start.
- Let VM workspaces clone GitLab projects and push branches using the existing callback-based credential helper.
- Support GitLab project browsing through the existing provider-agnostic repo browser routes.
- Keep GitHub and Artifacts behavior unchanged.

## Implementation Plan

1. Extend shared contracts:
   - Add `gitlab` to `RepoProvider` and `VALID_REPO_PROVIDERS`.
   - Extend create-project request fields with GitLab project metadata.
   - Extend VM agent create-workspace request with optional provider metadata.

2. Add persistence:
   - Add an additive D1 migration for `project_gitlab_repositories`.
   - Store project ID, GitLab host, numeric project ID, path with namespace, web URL, HTTPS clone URL, default branch, and timestamps.
   - Mirror the Drizzle schema.

3. Add GitLab service layer:
   - Resolve host/API base URL from `getGitLabOAuthConfig`.
   - Retrieve user OAuth tokens through BetterAuth, not by reading `accounts` directly.
   - Implement project search/list, branch list, project lookup, access verification, tree/file/raw/compare helpers.

4. Add API routes:
   - Add authenticated GitLab routes for project and branch selection.
   - Extend project creation for `repoProvider: "gitlab"`.
   - Extend task-start access guards to re-verify GitLab repository access.
   - Extend workspace `git-token` to mint GitLab credentials only for the bound project metadata.

5. Add workspace runtime support:
   - Thread GitLab provider metadata through task runner config, workspace creation, and node-agent request payloads.
   - Extend VM repo URL normalization so GitLab clone URLs are preserved.
   - Extend VM credential helper host/path checks and configure `credential.useHttpPath` for GitLab.
   - Keep `GH_TOKEN` injection and `gh` wrapper behavior GitHub-only.

6. Add UI support:
   - Add GitLab as a project onboarding provider.
   - Add a GitLab project selector backed by the new API routes.
   - Preserve current GitHub and Artifacts flows.

7. Validate:
   - Add focused API tests around GitLab project creation/access and git-token behavior.
   - Add Go tests for VM credential-helper and create-workspace contract.
   - Run local typecheck/test/build checks.
   - Run local specialist review skills relevant to API/env/security/Go/UI.
   - Do not deploy or verify on staging.

## Acceptance Criteria

- GitLab provider can be selected during project creation when platform GitLab OAuth is configured.
- A GitLab project stores durable repository metadata and is returned as `repoProvider: "gitlab"`.
- Task starts against GitLab projects re-check current GitLab access.
- Workspaces for GitLab projects receive enough metadata to clone with HTTPS and authenticate through the credential helper.
- The VM agent does not persist or export static GitLab OAuth tokens.
- GitLab repo browsing supports branch/tree/file/raw/compare paths through the existing project repo routes.
- Draft PR is opened on top of #1545, with staging and merge explicitly skipped.

## Validation Notes

- Local API/web/shared typechecks pass.
- Focused API tests pass for GitLab metadata normalization and GitLab/GitHub repo browsing.
- Focused web unit tests pass for GitLab onboarding state and payload propagation.
- Focused VM Go tests pass for bootstrap credential helper behavior, persistence, workspace metadata, git credential host/path checks, and GitLab MR creation.
- Project onboarding Playwright audit passes on iPhone SE and desktop viewports.
- Full `packages/vm-agent/internal/server` Go package test passes after installing Docker locally and running `dockerd` on `/tmp/sam-docker.sock`.
- Staging validation is intentionally skipped by user instruction.
- Refreshed onto foundation SHA `570f4a5090fe05e5b382b585cd2ea8be5ec0d2be` with merge commit `e06e820b2`.
- Renumbered the GitLab sidecar migration from stale slot `0088` to additive slot `0091`.
- Added route-level tests for GitLab workspace token exchange, exact identity drift rejection, and task/project access re-verification.
- Full repository typecheck passed. The exhaustive test run passed 402/403 API files and 5,905/5,906 API tests before exposing one stale provider-count assertion; the repaired provider contract and all focused GitLab boundary tests pass.
- Full repository build passed.
- Full VM-agent `go test -race ./...`, touched-package coverage, and `go vet ./...` passed on Go 1.25.0.
- Local mocked Playwright audit passed 10/10 across iPhone SE (375x667) and desktop (1280x800).

## Review Notes

- GitLab OAuth tokens are only returned through the workspace callback `git-token` flow and are not persisted/exported as static workspace env vars.
- VM credential responses are constrained by host and GitLab repository path, with `credential.useHttpPath=true` configured.
- GitLab repository metadata now stores the bare host required by Git/VM paths while continuing to use the platform config origin for OAuth/API calls.
- Known WIP deferrals: GitLab-specific member/invite repository access routes and GitLab webhook/task trigger support are not included in this stacked PR.

## Phase 5 Specialist Review (2026-07-11 continuation)

All 8 required local reviewers were re-run successfully (prior session could not launch them due to a `bwrap` sandbox failure). In-scope findings fixed in this continuation:

- **task-completion-validator / test-engineer (CRITICAL/HIGH):** `POST /api/projects` GitLab branch had no direct route-level behavioral test. Added `apps/api/tests/unit/routes/project-gitlab-creation.test.ts` (9 scenarios: happy path + sidecar persistence, missing id 400, no-token 401, insufficient-access 403, not-found 404, non-default branch exists/absent, duplicate 409, sidecar-insert rollback).
- **constitution-validator / cloudflare-specialist (HIGH/MED, Principle XI):** `gitlabFetch` had no timeout. Added `GITLAB_API_TIMEOUT_MS` env (default `DEFAULT_GITLAB_API_TIMEOUT_MS=30_000`) via shared `fetchWithTimeout`; documented in `env.ts` and `.env.example`.
- **security-auditor / go-specialist (HIGH):** `isAllowedCredentialPathForWorkspace` failed open (`return true`) for unregistered workspaces. Now falls back to `s.config` RepoProvider/RepositoryPath, mirroring `isAllowedCredentialHostForWorkspace` (preserves standalone mode, does not fail open). Added `TestIsAllowedCredentialPathForWorkspaceFallsBackToConfig`.
- **test-engineer (H1):** Added `verifyGitLabProjectAccess` error-branch tests (<Developer → 403, 404 → not-found, group-access inheritance).
- **ui-ux-specialist (H2):** Playwright audit `/api/gitlab/branches` mock returned an object wrapper; real route returns a bare array. Fixed the mock so screenshot evidence reflects real branch population.
- **doc-sync-validator (HIGH/MED):** Removed stale "future" qualifier from `security.md` GitLab row; documented required `read_user`+`api` GitLab OAuth scopes in `self-hosting.mdx`.

Verified-correct (no fix needed): the VM-agent create-workspace cross-boundary field mapping is consistent camelCase across `node-agent.ts` → Go `createWorkspaceRequest` json tags → shared `CreateWorkspaceAgentRequestSchema` (no snake/camel mismatch).

Deferred to explicit later stack layers (documented, not blocking this draft):

- MR-layer hardening (go-specialist HIGH): `RepositoryHost` URL validation + a dedicated external HTTP client for GitLab MR API calls. `RepositoryHost` is trusted platform config (not user input) and comprehensive MR/change-request handling is the later MR/control-plane layer.
- Hardcoded GitLab OAuth scopes (constitution/security MED): kept at parity with the existing hardcoded GitHub scopes; scope narrowing can follow.
- GitLabProjectSelector keyboard/ARIA combobox + no-results/provider-reset polish (ui H1/M2): later discovery/UX layer; matches existing BranchSelector/RepoSelector pattern.
- Per-request config/D1 lookup de-duplication in the GitLab path (cloudflare MED): later optimization.
- Fail-closed VM credential exchange when host/path are omitted on the request side; per-user OAuth refresh serialization; stale-host/account token lifecycle: later security layer.
