# Workspace git credential for GitLab projects should be scoped to the project

## Problem

`POST /api/workspaces/:id/git-token` (`apps/api/src/routes/workspaces/runtime.ts`) returns the
workspace owner's personal GitLab OAuth access token for GitLab-backed projects. That token is
minted with `read_user api read_repository write_repository` (`apps/api/src/auth.ts`); `api` is
GitLab's broadest scope, so the agent holds access to every GitLab project the owner can reach.

GitHub projects get a GitHub App installation token scoped to the project repository that expires
within an hour, so the two providers are not at parity.

## Context

Found by the security re-review of shared chat sessions (idea `01M59MYE4GY91BWTE8TZF1ZB5D`,
2026-10-19). Since a chat can be shared, any teammate the owner shares with can ask the agent to
run `git credential fill` and keep the owner's GitLab token. This is documented as accepted risk in
`apps/www/src/content/docs/docs/architecture/security.md` and `guides/collaboration.md`; this task
reduces it.

## Acceptance Criteria

- [ ] Workspaces on GitLab projects receive a credential limited to the project's repository
      (for example a project access token or a short-lived job-style token), with an expiry
- [ ] The owner's personal OAuth token is never returned to a workspace
- [ ] Clone, fetch and push from the workspace keep working on staging
- [ ] Docs no longer describe the account-wide GitLab exposure
