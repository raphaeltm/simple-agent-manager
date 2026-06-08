# Same-org GitHub submodules under tightly scoped workspace tokens

**Idea:** 01KTHVE80Q4BVJYRG7D23A6WPY
**Task ID:** 01KTJWXTDN9T4QZV3PZED0DPA3
**Branch:** sam/implement-idea-01kthve80q4bvjyrg7d23a6wpy-support-01ktjw
**Base (STACKED ON):** sam/implement-idea-01kthtzsjdhsj7eg6shs3pw6gq-securit-01ktjv (GitHub-token hardening, COMPLETED staging-green, 5 commits ahead of main, NO PR opened)
**HARD CONSTRAINT:** DO NOT MERGE. Draft PR / clearly marked DO NOT MERGE. Stop after PR + evidence even if CI/staging pass.

## Problem

The GitHub-token hardening base now mints `/git-token` scoped to exactly one repository
(`repositoryIds: [githubRepoId]`). This is correct for the primary repo but **breaks same-org
submodules**: a workspace cloning a repo with `.gitmodules` pointing at other repos in the same
GitHub App installation can no longer authenticate the submodule fetch, because the single-repo
token has no access to the submodule repos. The hardening agent explicitly flagged this as its
residual risk.

## Goal (Codespaces-style "additional Repository Access" model)

Add a **project-scoped Repository Access** model for additional same-installation/same-org repos.

- Primary project repo is always included.
- Users select additional repos from the same GitHub App installation in **Project Settings**
  (NOT task submission).
- `.gitmodules` discovery suggests repos to add.
- SAM verifies user∩app access for every selected additional repo **before storing** and again
  **at token mint boundaries**.
- Workspace tokens minted with explicit `repository_ids: [primaryRepoId, ...selectedAdditionalRepoIds]`
  plus the active profile's GitHub/platform policy permissions. NEVER omit `repository_ids`.
- Selected additional repos inherit generated permissions (permissions apply set-wide).
  Unselected repos fail clearly.
- UI shows selected repo statuses (active, access revoked, app not installed, unsupported URL).
  Profile Platform Policy copy clarifies permissions apply to the selected project repository
  **set**, not only the primary repo.

## Research findings (integration points on the hardening base)

- **Schema** `apps/api/src/db/schema.ts`: model new `projectGithubRepositories` table on
  `projectRuntimeEnvVars` (line 355). FK cascade `projectId`→projects, `userId`→users; unique
  index on `(projectId, repository)`; store `githubRepoId` (int) + `githubRepoNodeId` + `repository`
  (full name). New migration `0065_project_github_repositories.sql` in
  `apps/api/src/db/migrations/` (latest is 0064). ADD COLUMN-safe — brand new table, no DROP.
- **CRUD API** `apps/api/src/routes/projects/crud.ts`: runtime-config pattern (lines 412-546).
  Add list / add (with `assertRepositoryAccess` verification + repo-id capture) / remove endpoints,
  plus `.gitmodules` discovery endpoint reusing `getUserInstallationRepositories`
  (`apps/api/src/services/github-app.ts:510`). Owner check via `requireOwnedProject`.
- **Project delete batch** `crud.ts` (lines 855-936): D1 does not enforce ALTER-added FKs — must
  add explicit `db.delete(projectGithubRepositories)` before project delete.
- **Mint boundary** `apps/api/src/routes/workspaces/runtime.ts`:
  - `verifyWorkspaceGitHubOwnerAccess` (lines 60-107) → extend to fetch owner token once, verify
    primary + each active additional repo, return primary id + verified additional ids.
  - `/git-token` handler `scopedTokenOptions.repositoryIds` (line 861-866) → becomes
    `[githubRepoId, ...verifiedAdditionalRepoIds]`. Permissions in `tokenOptions` apply set-wide.
- **Token policy** `apps/api/src/services/github-cli-policy.ts`: permissions are set-wide; adding
  ids to `repositoryIds` is sufficient for additional repos to inherit permissions.
- **VM agent** `packages/vm-agent/internal/bootstrap/bootstrap.go`: `ensureRepositoryReady`
  (line 767) clones then sanitizes origin (line 816). Add submodule sync/update after clone using
  inline `-c url.https://x-access-token:TOKEN@github.com/.insteadOf=...` (origin is sanitized),
  non-fatal on failure. Single minted token covers all selected repos; credential helper reuse OK.
- **UI** `apps/web/src/pages/ProjectSettings.tsx`: new "Repository Access" section
  (glass-surface pattern). Platform Policy copy in
  `apps/web/src/components/agent-profiles/ProfileFormDialog.tsx` (lines 484-486) → clarify the
  token is narrowed to the selected project repository **set**.
- **Shared types** `packages/shared/src/types/project.ts` + api client
  `apps/web/src/lib/api/projects.ts`.

## Implementation checklist

- [ ] Schema: `projectGithubRepositories` table + types in `schema.ts`
- [ ] Migration `0065_project_github_repositories.sql`
- [ ] Shared types in `packages/shared/src/types/project.ts`
- [ ] API: list/add/remove repo-access endpoints + `.gitmodules` discovery in `crud.ts`
- [ ] API: add additional-repo cleanup to project delete batch
- [ ] Mint: extend `verifyWorkspaceGitHubOwnerAccess` + `repositoryIds` in `/git-token`
- [ ] VM agent: submodule sync/update in `ensureRepositoryReady`
- [ ] UI: Repository Access section in `ProjectSettings.tsx` + api client functions
- [ ] UI: Platform Policy copy clarification in `ProfileFormDialog.tsx`
- [ ] Tests: storage/verification; mint scoping; revoked/unselected fail; policy applies to set;
      no GitHub mint omits repo scoping; VM submodule bootstrap; `.gitmodules` discovery; UI
- [ ] Staging verification (GitHub Actions Deploy Staging; clear nodes first — VM agent changes)
- [ ] Draft DO-NOT-MERGE PR stacked on hardening branch w/ evidence + residual risks

## Notes

- Hardening agent flagged this feature as its residual risk: "single-repo scoping may break
  same-org submodules until a future explicit multi-repo policy exists." This task closes it.
- Hardening base has NO PR — surface that caveat in the draft PR.
