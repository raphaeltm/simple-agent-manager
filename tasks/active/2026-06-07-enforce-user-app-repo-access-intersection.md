# Enforce user∩app GitHub repo-access intersection at spawn (fail-fast)

**SAM idea:** `01KTFG04QBD8N34A7V00PGKYJZ` — [Security HIGH]
**Branch:** `sam/implement-sam-idea-01ktfg04qbd8n34a7v00pgkyjz-01ktgk`
**Severity:** HIGH (explicit Raphaël requirement, 2026-06-06)

## Problem Statement

Every GitHub action must be authorized by the **intersection** of (a) what the
GitHub **app installation** grants AND (b) what the **user's own GitHub
authorization** allows. Today that intersection is enforced only at *project
create/update* (`projects/crud.ts`). The session/workspace **spawn** paths trust
the create-time `githubRepoId` binding and mint app-installation tokens with no
user re-check. A user removed from an org/repo *after* project creation can still
spawn workspaces that clone that repo via the app-installation token.

The requirement: a spawn must **fail fast — before any machine is provisioned or
any clone is attempted** — if the user no longer has access to the repo/org.

Same bug class as the production leak fixed in PR #1236 (5be1ea96) and PR #1238
(b8e42783), where a mismatched per-user `github_installations` row leaked another
user's private repos.

## Research Findings

### The reusable intersection check already exists
`assertRepositoryAccess(accessToken, externalInstallationId, repository, userId)`
(`apps/api/src/routes/projects/_helpers.ts:212`) calls
`getUserInstallationRepositories` → `GET /user/installations/{id}/repositories`
with the **user's OAuth token**. GitHub returns only the repos in that
installation the user can actually see — the true user∩app intersection. It
throws `forbidden` if the requested repo is not in that set.

### Token + installation helpers
- `requireGitHubUserAccessToken(c, userId)` is **private** in
  `projects/crud.ts:941` — throws `forbidden('GitHub user token unavailable')`
  when the BetterAuth OAuth token is null. Must be **extracted/shared** so spawn
  routes can reuse it.
- `getGitHubUserAccessToken(c, userId)` (`services/github-user-access-token.ts`)
  returns null on failure (BetterAuth owns refresh/encryption).
- `getExternalInstallationId(installation)`
  (`services/github-installation-ids.ts`) → `externalInstallationId ||
  installationId`.
- `requireOwnedInstallation(db, installationRowId, userId)`
  (`projects/_helpers.ts:188`) loads + scopes the installation row to the user.

### Project create already does the intersection (lock in with a test)
`projects/crud.ts:197-213`: `requireOwnedInstallation` →
`getExternalInstallationId` → `requireGitHubUserAccessToken` →
`assertRepositoryAccess` → compares `verifiedRepo.id` to client `githubRepoId`.
The repo **list** shown at create time is already the intersection (same
user-token path). Need a regression test asserting an app-granted repo the user
cannot see is excluded.

### Spawn entry points (user-initiated, live `c` — gate here)
| Entry | File | Provisioning call (gate BEFORE this) |
|-------|------|---------------------------------------|
| Workspace create | `routes/workspaces/crud.ts:183` | `createNodeRecord` (262), workspace insert (295) |
| Task submit | `routes/tasks/submit.ts:56` | `startTaskRunnerDO` (433) |
| Task run | `routes/tasks/run.ts:52` | `startTaskRunnerDO` (243) |

All three call `requireOwnedProject(db, projectId, userId)` early and have the
loaded `project` in hand. Chat-driven spawn goes through the
`POST /workspaces` endpoint (chat.ts has no direct `createNodeRecord`/
`startTaskRunnerDO` calls), so gating `workspaces/crud.ts` covers it.

### Out of scope (no user session — idea option (b), separate idea)
- `durable-objects/task-runner/*` and `trial-orchestrator/*` provision inside a
  DO with no request context → cannot call `requireGitHubUserAccessToken(c,...)`.
- `routes/mcp/dispatch-tool.ts` is **agent-initiated** via callback JWT (no user
  session). These re-intersect-at-provision paths are idea
  `01KTFA36XHHPXAC4EE03SG4FHT` / option (b). The idea's recommendation is to do
  option (a) — gate the **user-initiated dispatch routes** — now. Document the DO
  gap explicitly.

### Test pattern to mirror
`apps/api/tests/unit/routes/project-github-access-routes.test.ts` — builds the
real `projectsRoutes` Hono app, mocks `drizzle`, `requireOwnedProject`,
`getGitHubUserAccessToken`, `getUserInstallationRepositories`; asserts 403 +
that `insertedRows`/`updateCalls` stayed empty (no side effect). This is the
vertical-slice shape required by rule 35.

## Design

Add one shared helper so no spawn path can silently skip the gate (mirrors how
`requireOwnedProject` consolidates ownership):

```ts
// projects/_helpers.ts
export async function requireRepositoryUserAccess(
  c: Context<{ Bindings: Env }>,
  db: AppDb,
  project: schema.Project,
  userId: string
): Promise<void> {
  if (project.repoProvider && project.repoProvider !== 'github') return; // artifacts-backed: no intersection
  const installation = await requireOwnedInstallation(db, project.installationId, userId);
  const externalInstallationId = getExternalInstallationId(installation);
  const accessToken = await requireGitHubUserAccessToken(c, userId); // throws 403 if null
  const verifiedRepo = await assertRepositoryAccess(
    accessToken, externalInstallationId, project.repository, userId
  ); // throws 403 if repo not in user∩app set
  if (project.githubRepoId !== null && verifiedRepo.id !== project.githubRepoId) {
    throw errors.forbidden('GitHub repository access has changed; repository ID no longer matches');
  }
}
```

Takes the already-loaded `project` (callers all have it from
`requireOwnedProject`) to avoid a redundant DB load while still consolidating the
intersection logic in one place.

## Implementation Checklist

- [ ] Extract `requireGitHubUserAccessToken` from `projects/crud.ts` to
      `projects/_helpers.ts` (export); update `crud.ts` to import it. No behavior
      change.
- [ ] Add `requireRepositoryUserAccess(c, db, project, userId)` to
      `projects/_helpers.ts` (per Design). Skip non-github `repoProvider`.
- [ ] Gate `workspaces/crud.ts` POST `/` — call after `requireOwnedProject`
      (201), before `createNodeRecord` (262)/workspace insert. Remove the now
      redundant raw installation-ownership query (211-223) only if fully covered
      by the gate's `requireOwnedInstallation`.
- [ ] Gate `tasks/submit.ts` POST `/submit` — after `requireOwnedProject` (67),
      before task insert/`startTaskRunnerDO` (433).
- [ ] Gate `tasks/run.ts` POST `/:taskId/run` — after project load, before
      `startTaskRunnerDO` (243).
- [ ] Behavioral/vertical-slice tests (mirror project-github-access-routes.test):
  - [ ] Spawn fail-fast: access revoked → `POST /workspaces` returns 403 and
        `createNodeRecord`/`startTaskRunnerDO` NOT called (assert no
        node/workspace insert).
  - [ ] Spawn happy path: user still has access → spawn proceeds.
  - [ ] `githubRepoId` drift: verified repo id ≠ bound `project.githubRepoId` →
        403.
  - [ ] Org sharing preserved: a distinct user with their own access to the same
        org installation can spawn.
  - [ ] Same fail-fast assertion for `tasks/submit` and `tasks/run`.
- [ ] Regression test: project-create repo **list** is the strict intersection —
      an app-installation repo the user cannot see is excluded (extend
      `project-repository-access.test.ts` / access-routes test).
- [ ] Helper unit test: non-github project skips the gate; null user token → 403.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green.

## Acceptance Criteria

1. For github-backed projects, every user-initiated spawn
   (`workspaces` create, `tasks` submit, `tasks` run) re-verifies user∩app repo
   access BEFORE provisioning; failure returns 403 with no node/workspace/DO side
   effect. (tests: spawn fail-fast ×3)
2. Happy path unaffected — user with access spawns as before. (test)
3. `githubRepoId` drift between bound value and user-verified repo → 403. (test)
4. Project-create repo list is the strict user∩app intersection. (test)
5. Distinct user with their own org access can still spawn (org sharing
   preserved). (test)
6. DO/background + MCP-dispatch gap (no user session) documented as option (b) /
   idea `01KTFA36XHHPXAC4EE03SG4FHT`.

## References
- Idea `01KTFG04QBD8N34A7V00PGKYJZ`
- `.claude/rules/11-fail-fast-patterns.md` (identity validation at boundaries)
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/35-vertical-slice-testing.md`
- PR #1236 (5be1ea96), PR #1238 (b8e42783)
