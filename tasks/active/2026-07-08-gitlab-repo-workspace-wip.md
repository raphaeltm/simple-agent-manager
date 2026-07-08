# GitLab Repository And Workspace Support WIP

## Status

Active WIP stacked PR branch on top of #1545 (`sam/gitlab-platform-config-wip`).

## Constraints

- Draft/WIP PR only.
- Do not deploy to staging.
- Do not mutate staging.
- Do not merge.
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
- Full `packages/vm-agent/internal/server` Go package test is not runnable in this workspace because `docker` is missing; the failing test is Docker-dependent and not GitLab-specific.
- Staging validation is intentionally skipped by user instruction.

## Review Notes

- GitLab OAuth tokens are only returned through the workspace callback `git-token` flow and are not persisted/exported as static workspace env vars.
- VM credential responses are constrained by host and GitLab repository path, with `credential.useHttpPath=true` configured.
- GitLab repository metadata now stores the bare host required by Git/VM paths while continuing to use the platform config origin for OAuth/API calls.
- Known WIP deferrals: GitLab-specific member/invite repository access routes and GitLab webhook/task trigger support are not included in this stacked PR.
