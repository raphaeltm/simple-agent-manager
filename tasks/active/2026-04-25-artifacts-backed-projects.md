# Artifacts-Backed Projects: GitHub-Optional Project Creation

## Problem Statement

Currently, all projects require a GitHub repository — users must have a GitHub account, install the SAM GitHub App, and grant repo access before they can create a project. This creates unnecessary friction for users who don't have or don't want GitHub.

This task implements Cloudflare Artifacts as an alternative "repo provider" so users can create projects backed by SAM-native Git repos. GitHub becomes one of two providers — the other being Artifacts.

## Research Findings

### Key Files to Modify

**Database Layer:**
- `apps/api/src/db/schema.ts:236-311` — `projects` table definition. `installationId` is currently NOT NULL FK. Needs: `repoProvider` column, nullable `installationId`, `artifactsRepoId` column.
- Migration `0047_artifacts_repo_provider.sql` — Add columns, update constraints.

**API Layer:**
- `apps/api/src/schemas/projects.ts:19-27` — `CreateProjectSchema` validation. Needs `repoProvider` field and conditional validation.
- `apps/api/src/routes/projects/crud.ts:62-175` — `POST /api/projects` handler. Needs Artifacts creation path that skips GitHub validation.
- `apps/api/src/routes/workspaces/runtime.ts:386-416` — `POST /:id/git-token`. Needs to return Artifacts tokens + clone URL for Artifacts-backed projects.

**Shared Types:**
- `packages/shared/src/types/project.ts` — `Project`, `CreateProjectRequest`, `ProjectSummary`, `ProjectDetail` interfaces need `repoProvider` and `artifactsRepoId`.

**VM Agent:**
- `packages/vm-agent/internal/server/git_credential.go:41` — Hardcodes `host=github.com`. Needs dynamic host based on response.
- `packages/vm-agent/internal/bootstrap/bootstrap.go:686-750` — `ensureRepositoryReady()` and `normalizeRepoURL()` assume GitHub. Need to handle full HTTPS URLs returned by the API.

**Agent Context:**
- `apps/api/src/routes/mcp/instruction-tools.ts:104-108` — `get_instructions` returns project info. Needs `repoProvider` so agents know not to use `gh pr create`.

**UI:**
- `apps/web/src/components/project/ProjectForm.tsx` — Project creation form. Needs repo provider toggle.

**Env/Binding:**
- `apps/api/src/env.ts` — Add `ARTIFACTS` binding type.
- `apps/api/wrangler.toml` — Add `[[artifacts]]` binding.

### Artifacts API Summary

- **Binding config:** `[[artifacts]] binding = "ARTIFACTS" namespace = "default"`
- **Create repo:** `const result = await env.ARTIFACTS.create("repo-name")`
  - Returns: `{ id, name, remote, token, default_branch }`
- **Get repo:** `const repo = await env.ARTIFACTS.get("repo-name")`
- **Create token:** `const token = await repo.createToken("write", ttlSeconds)`
  - Returns: `{ id, plaintext, scope, expires_at }`
- **Clone URL format:** `https://{accountId}.artifacts.cloudflare.net/git/{namespace}/{repo}.git`
- **Auth:** `https://x:{tokenSecret}@{host}/git/{namespace}/{repo}.git`

### VM Agent Git Credential Changes

The current `handleGitCredential` hardcodes `host=github.com`. For Artifacts, the git-token endpoint should return the clone URL alongside the token, so the VM agent can dynamically set the correct host. The git credential helper response format needs:
```
protocol=https
host={dynamic-host}
username=x-access-token  (or x for artifacts)
password={token}
```

**Better approach:** Have the git-token endpoint return `{ token, expiresAt, cloneUrl }`. The VM agent uses the cloneUrl to set the git remote and extract the host for the credential helper. This keeps provider logic server-side.

## Implementation Checklist

### Phase 1: Database & Shared Types

- [ ] Add D1 migration `0047_artifacts_repo_provider.sql`:
  - Add `repo_provider TEXT NOT NULL DEFAULT 'github'` column
  - Make `installation_id` nullable (remove NOT NULL)
  - Add `artifacts_repo_id TEXT` nullable column
  - Update uniqueness constraints
- [ ] Update Drizzle schema (`apps/api/src/db/schema.ts`):
  - Add `repoProvider` column with default `'github'`
  - Make `installationId` nullable (remove `.notNull()`)
  - Add `artifactsRepoId` column
- [ ] Update shared types (`packages/shared/src/types/project.ts`):
  - Add `RepoProvider = 'github' | 'artifacts'` type
  - Add `repoProvider` to `Project`, `ProjectSummary`, `ProjectDetail`
  - Add `artifactsRepoId` to `Project`
  - Update `CreateProjectRequest` — `installationId` optional, add `repoProvider`

### Phase 2: Wrangler Binding & Env

- [ ] Add `[[artifacts]]` binding to `apps/api/wrangler.toml` top-level config
- [ ] Add `ARTIFACTS` binding type to `apps/api/src/env.ts` (optional — may not exist in all envs)
- [ ] Add configurable env vars: `ARTIFACTS_ENABLED`, `ARTIFACTS_DEFAULT_BRANCH`, `ARTIFACTS_TOKEN_TTL_SECONDS`, `ARTIFACTS_MAX_REPOS_PER_USER`

### Phase 3: API — Project Creation

- [ ] Update `CreateProjectSchema` validation to accept `repoProvider` field
- [ ] Update `POST /api/projects` handler:
  - When `repoProvider === 'artifacts'`: create Artifacts repo, skip GitHub validation, store `artifactsRepoId`
  - When `repoProvider === 'github'` (or omitted): existing flow unchanged
  - Repository name for Artifacts: `sam/{project-name-slug}`
- [ ] Update `toProjectResponse()` helper to include `repoProvider`

### Phase 4: API — Git Token & Clone URL

- [ ] Update `POST /:id/git-token` endpoint:
  - Look up project via workspace to determine `repoProvider`
  - For GitHub: existing flow (installation token, no clone URL)
  - For Artifacts: create token via binding, return token + clone URL
  - Response shape: `{ token, expiresAt, cloneUrl? }`

### Phase 5: VM Agent — Dynamic Git Host

- [ ] Update `gitTokenResponse` struct to include `CloneURL` field
- [ ] Update `handleGitCredential` to use dynamic host from clone URL (parse URL for host)
- [ ] Update `ensureRepositoryReady()` to use clone URL from git-token response when available, falling back to `normalizeRepoURL()` for backward compatibility

### Phase 6: Agent Context

- [ ] Update `get_instructions` MCP tool to include `repoProvider` in project context
- [ ] Update agent prompt: for Artifacts projects, instruct agents not to use `gh pr create`

### Phase 7: UI — Project Creation Form

- [ ] Add repo provider toggle to `ProjectForm.tsx` (GitHub vs SAM Git)
- [ ] SAM Git path: simplified form (name + description only, auto-creates repo)
- [ ] GitHub path: existing flow unchanged
- [ ] Project detail: show provider indicator

### Phase 8: Tests

- [ ] Unit test: Artifacts project creation API (skip GitHub validation)
- [ ] Unit test: git-token endpoint returns clone URL for Artifacts projects
- [ ] Unit test: get_instructions includes repoProvider
- [ ] Integration test: capability test for Artifacts project → workspace → git clone flow

## Acceptance Criteria

- [ ] Users can create projects with `repoProvider: 'artifacts'` without any GitHub installation
- [ ] Artifacts projects get a working Artifacts Git repo created automatically
- [ ] Agents can clone, write, and push to Artifacts-backed repos
- [ ] `get_instructions` returns `repoProvider` so agents know the repo type
- [ ] GitHub project creation flow is unchanged (backward compatible)
- [ ] Feature is gated behind `ARTIFACTS_ENABLED` env var (default: false)
- [ ] UI provides a toggle to choose between GitHub and SAM Git when creating a project
- [ ] All configurable values follow Constitution Principle XI (no hardcoded values)

## References

- Idea: 01KQ22EK99FR547M34G9DWPMD0
- Cloudflare Artifacts docs: https://developers.cloudflare.com/artifacts/
- Artifacts Workers binding: https://developers.cloudflare.com/artifacts/get-started/workers/
- Constitution: `.specify/memory/constitution.md` (Principle XI)
