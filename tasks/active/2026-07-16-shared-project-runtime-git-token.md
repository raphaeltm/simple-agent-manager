# Fix shared-project runtime assets and GitHub clone tokens

## Problem Statement

Multiplayer task execution currently has two creator/user ownership mismatches:

1. A project member can select project-scoped profiles/skills created by another member, but workspace runtime asset resolution still requires some project-scoped resources to have `user_id = workspace.user_id`. This causes VM startup to fail with `runtime-assets endpoint returned HTTP 403` for valid shared-project usage.
2. A project member can pass task-submit GitHub repo access checks, but workspace `/git-token` later requires the stored project GitHub installation row to be owned by the workspace user. In shared projects that row often belongs to the project creator, so token vending fails and the VM agent continues into an unauthenticated `git clone`, producing `fatal: could not read Username for 'https://github.com'`.

The desired v1 product rule is:

- Project-scoped profiles, skills, project env/secrets/files, profile env/secrets/files within the project, and skill env/secrets/files within the project are shared resources usable by any active project member.
- Nodes remain user-scoped.
- Personal/global resources remain user-scoped unless explicitly attached to the project.
- LLM credential attribution remains separate: use the running user's LLM credentials or configured shared project credentials.
- GitHub repo access remains user-scoped: the running user must have GitHub access to the repo; SAM must not authorize the user by borrowing another user's identity.

## Research Findings

- `apps/api/src/services/workspace-runtime-assets.ts`
  - `validateProfileId()` and `validateSkillId()` currently require resource `user_id` to match `workspace.user_id`.
  - `resolveProjectAssets()` reads `project_runtime_env_vars` and `project_runtime_files` by `project_id + workspace.user_id`.
  - `getProfileRuntimeAssets()` and `getSkillRuntimeAssets()` are called with `workspace.user_id`, so profile/skill runtime rows are also treated as running-user-owned.
- `apps/api/src/services/profile-runtime-assets.ts`
  - Runtime config helpers and asset readers currently filter profile/skill runtime env/files by `user_id`.
  - Unique indexes are already resource-scoped (`profile_id + env_key`, `skill_id + env_key`, etc.), so `user_id` is acting more like attribution than a real uniqueness boundary.
- `apps/api/src/routes/projects/crud.ts` and `apps/api/src/routes/projects/_helpers.ts`
  - Project runtime env/file write and config response paths still use active user/project owner `user_id` filters.
  - Unique indexes are project-scoped (`project_id + env_key`, `project_id + file_path`), so member edits should update the same shared row.
- `apps/api/src/routes/workspaces/runtime.ts`
  - Task submit already uses `requireRepositoryUserAccess()` to verify the submitting user's GitHub OAuth access through the project installation.
  - `/api/workspaces/:id/git-token` later loads `github_installations` by `workspace.installation_id + workspace.user_id`, causing owner/member mismatch for shared projects.
  - `verifyWorkspaceGitHubOwnerAccess()` already verifies the supplied user has repo access; the name is now misleading for shared projects.
  - `resolveAdditionalRepositoryIds()` also filters `project_github_repositories` by `project_id + workspace.user_id`; if additional repo access is a project setting, token minting should read project rows and still re-verify the running user's access before adding scopes.
- `packages/vm-agent/internal/server/workspace_provisioning.go`
  - `provisionWorkspaceRuntime()` logs `Proceeding without git token` on git-token fetch failure and continues.
  - For authenticated GitHub/GitLab/Artifacts projects, this hides the real authorization/token failure and leads to a misleading unauthenticated clone error.
- `packages/vm-agent/internal/bootstrap/bootstrap.go`
  - `withGitToken()` returns the plain URL when the token is empty, so `git clone` tries to prompt for credentials in a non-interactive environment.
- Relevant prior records:
  - `tasks/archive/2026-07-04-wave-1b-automation-context-membership-auth.md` migrated route authorization to project membership while preserving creator/actor attribution.
  - `tasks/archive/2026-07-04-shared-project-auth-wave-1d.md` explicitly classified runtime asset value attribution as user-scoped at that time; the newer product decision supersedes this for project-scoped runtime resources.
  - `tasks/active/2026-06-08-harden-github-token-injection.md` hardened final GitHub token vending to verify user∩app repo access and single-repo scoping.
  - `tasks/archive/2026-06-09-fix-secondary-workspace-git-credential-gate.md` documents that token freshness/exchange remains per-workspace and tightly scoped.
  - `tasks/archive/2026-03-23-scope-callback-tokens.md` documents why `runtime-assets` and `git-token` remain workspace-scoped callback endpoints and must not accept node-level secret access.
- Relevant rules:
  - `.claude/rules/11-fail-fast-patterns.md`: validate identity/scope at boundaries and include project scope in project-scoped write predicates.
  - `.claude/rules/35-vertical-slice-testing.md`: cross-boundary changes need vertical slice tests with realistic state.

## Implementation Checklist

- [x] Add/adjust failing API tests proving a member-owned workspace can fetch project/profile/skill runtime assets created by another project member.
- [x] Add/adjust failing route tests proving project/profile/skill runtime config APIs update shared project-scoped rows rather than per-user shadow rows.
- [x] Add/adjust failing `/git-token` tests proving a member workspace can mint through a project creator's installation row only after member GitHub access is verified.
- [x] Add/adjust VM-agent tests proving git-token fetch failures fail early for authenticated repo providers instead of falling through to unauthenticated clone.
- [x] Update workspace runtime asset resolution to validate project/resource scope without requiring creator `user_id = workspace.user_id`.
- [x] Update project/profile/skill runtime config read/write/delete helpers to use project/resource-scoped predicates; keep current user only as attribution on insert/update.
- [x] Update GitHub workspace `/git-token` route to load the project installation row by id, verify running user repo access, then mint scoped installation tokens from the project installation external id.
- [x] Update additional GitHub repository access token scope resolution to read project-scoped rows and re-verify running user access before adding repository ids.
- [x] Update VM-agent provisioning to fail fast with the git-token fetch error for non-empty authenticated repositories.
- [x] Keep nodes user-scoped and avoid broadening personal/global resources.
- [x] Run focused API and Go tests.
- [x] Run full local quality gates in proportion to the changed packages.
- [x] Run local specialist review: task completion validator, Cloudflare/API, security, Go, and test coverage.
- [x] Skip staging deployment/verification by explicit user instruction if local vertical slice coverage is thorough; document that in the PR.

## Validation Notes

- Focused API shared-project regressions pass:
  - `workspace-runtime-assets-shared-project.test.ts`
  - `profile-runtime-assets.test.ts`
  - `projects-runtime-config-shared-project.test.ts`
  - `workspace-git-token.test.ts`
- Full standalone API suite passes: 428 files / 6078 tests.
- Targeted VM-agent regression passes with temporary Go 1.25.0 in `/tmp`.
- Full `packages/vm-agent` `go test ./...` is blocked by unrelated local image prerequisites (`docker`/compose missing); the touched targeted server test passes.
- Root `pnpm typecheck`, `pnpm lint`, and `pnpm build` pass.
- After rebasing onto latest `origin/main`, the PR-specific CI drift fixes pass locally:
  - `pnpm lint`
  - `pnpm quality:file-sizes`
  - `env GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH=/tmp/pr-event-1607.json pnpm tsx scripts/quality/check-preflight-evidence.ts`
  - Focused API shared-project regressions and targeted VM-agent git-token regression
- Root `pnpm test` exposed unrelated API failures in two files under full turbo concurrency; those two files pass in isolation immediately afterward.
- Task-completion, API/Cloudflare boundary, security, Go, and test-coverage reviews completed locally; no blocking findings.

## Acceptance Criteria

- A project member can run a task/workspace using a project-scoped profile created by another project member.
- A project member can use project-scoped skill runtime assets created by another project member.
- Project, profile, and skill runtime env vars/files/secrets are injected for any active project member's workspace after callback auth.
- Runtime config API/MCP operations mutate the shared project-scoped row for a key/path, not a user-specific shadow row.
- A member-owned workspace can call `/api/workspaces/:id/git-token` when `workspace.installation_id` points to the project creator's GitHub installation row, provided the member has GitHub repo access.
- `/git-token` fails closed and mints no installation token when the running user's GitHub OAuth token is missing or their repo access is revoked.
- Additional repository access remains scoped to repos the running user can access.
- VM provisioning surfaces token vending failures directly for authenticated private repo providers and does not continue to an unauthenticated GitHub clone.
- Nodes remain user-scoped; personal/global resources remain user-scoped.
- Staging is not deployed or mutated for this task unless the user later asks for it.

## References

- Idea `01KXN60TJRY5ZGH39Y8GWGBCXR`
- `apps/api/src/services/workspace-runtime-assets.ts`
- `apps/api/src/services/profile-runtime-assets.ts`
- `apps/api/src/routes/projects/crud.ts`
- `apps/api/src/routes/projects/_helpers.ts`
- `apps/api/src/routes/profile-runtime.ts`
- `apps/api/src/routes/skill-runtime.ts`
- `apps/api/src/routes/mcp/profile-tools.ts`
- `apps/api/src/routes/workspaces/runtime.ts`
- `packages/vm-agent/internal/server/workspace_provisioning.go`
- `packages/vm-agent/internal/bootstrap/bootstrap.go`
- `.claude/rules/11-fail-fast-patterns.md`
- `.claude/rules/35-vertical-slice-testing.md`
