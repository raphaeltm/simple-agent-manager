# Backfill `github_repo_id` for legacy GitHub-backed projects

**Date:** 2026-06-07
**Origin:** Follow-up to the git-token outage fix (PR #1238, `fix(git-token): scope by repository name for legacy projects without repo id`). PR #1236 introduced per-repo token scoping; #1238 added a name-based fallback so legacy projects (those created before `github_repo_id` was captured) could keep minting tokens. That fallback is a **stopgap** — this task delivers the durable fix.

## Problem Statement

Some GitHub-backed projects have `projects.github_repo_id IS NULL` (created before the numeric repo id was captured at project creation). The git-token mint path (`apps/api/src/routes/workspaces/runtime.ts:711-765`) prefers `repositoryIds: [githubRepoId]` scoping and falls back to `repositories: [repoShortName]` (repo **name**) scoping when the id is missing. Name-based scoping has two real defects:

1. **Rename fragility.** GitHub repo *names* can change; the numeric *id* is rename-stable. The webhook handler only refreshes `projects.repository` on `renamed`/`transferred` events for rows that **already have** a `github_repo_id` (`apps/api/src/routes/github-webhook.ts:137-145` — the `UPDATE ... WHERE github_repo_id = ?`). Legacy projects (null id) therefore never get their stored name updated, so a rename silently breaks `repositories: ['old-name']` scoping → 403 on token mint → broken `gh`/push inside the workspace.
2. **Custom-CLI-policy 403.** Legacy projects that also have a custom GitHub CLI policy still 403. `resolveWorkspaceGitHubTokenOptions` (runtime.ts:743) runs before scoping and requires the numeric id to apply policy-based permission scoping (`apps/api/src/services/github-cli-policy.ts`). The name-fallback never reaches a working policy path.

Backfilling the numeric id for every legacy github-backed project unifies everyone onto the rename-stable, policy-compatible id path and lets the name-fallback shrink back to a true last-resort guard.

## Why this is NOT a pure SQL migration

The numeric `github_repo_id` does not exist anywhere in the database — it must be fetched from the GitHub API per project. A `.sql` migration cannot make network calls. This requires runtime code (Worker route + GitHub API), not a Drizzle migration.

## Verified Research Findings

| ID | Finding | Evidence | Action |
|----|---------|----------|--------|
| R1 | `github_repo_id` (int, nullable) + `github_repo_node_id` (text, nullable) live on `projects` | `apps/api/src/db/schema.ts:288-289` | Backfill writes both |
| R2 | Unique index `idx_projects_user_github_repo_id` on `(user_id, github_repo_id)` WHERE id NOT NULL | `schema.ts:344-346` | Backfill must tolerate a would-be unique collision (two legacy rows → same repo for one user) → skip + log, don't crash |
| R3 | Normal capture path uses a **user** access token via `assertRepositoryAccess` → `verifiedRepo.id`/`.nodeId` | `apps/api/src/routes/projects/crud.ts:200-213`, `apps/api/src/routes/projects/_helpers.ts:212-237` | Backfill can't use this (no user in loop). Use an **installation** token instead |
| R4 | `getInstallationToken(externalInstallationId, env, options?)` mints an installation token with **no user token**; `options` is optional | `apps/api/src/services/github-app.ts:256-264` | Backfill primitive: mint installation token, then `GET /repos/{owner}/{repo}` → `{ id, node_id, full_name }` |
| R5 | Webhook refreshes `repository` on rename ONLY for rows with a non-null `github_repo_id` | `apps/api/src/routes/github-webhook.ts:137-145` | Confirms rename-fragility for legacy rows; after backfill they self-heal on future renames |
| R6 | git-token fallback + custom-policy ordering | `runtime.ts:711-765` (policy resolved at :743 before scoping at :754) | Lazy self-heal must fetch+persist the id BEFORE `resolveWorkspaceGitHubTokenOptions` so the custom-policy edge is also fixed |
| R7 | Target legacy set | `repo_provider = 'github' AND github_repo_id IS NULL` (exclude `artifacts` projects and detached/deleted as appropriate) | Backfill selection predicate |

## Design

Two complementary mechanisms (mirrors the project's existing login-time self-heal pattern in migration `0062_login_time_superadmin_self_heal.sql`):

### Part A — Lazy/opportunistic self-heal on the git-token mint path (primary)
In `runtime.ts`, when the GitHub branch is reached with `githubRepoId == null` but a valid installation + repository name exist:
1. Mint an installation token (`getInstallationToken`, no scoping or name-scoped).
2. `GET /repos/{owner}/{repo}` → read `id`, `node_id`, canonical `full_name`.
3. Persist to `projects`: set `github_repo_id`, `github_repo_node_id`, and refresh `repository` to the canonical `full_name` (handles a rename that happened while id was null). Guard against the R2 unique collision (skip persist + log, continue with name-fallback for this one mint).
4. Continue with the normal **id-based** path — crucially **before** `resolveWorkspaceGitHubTokenOptions`, so custom-policy projects now resolve correctly.
5. If the fetch fails (repo deleted/inaccessible → 404), fall through to the existing name-based fallback (no regression) and log.

This self-heals every legacy project the first time it mints a token — which is exactly the moment correctness matters.

### Part B — One-time bulk backfill for dormant projects (secondary)
Projects that never mint a token won't be healed by Part A. Add a bulk backfill that iterates `repo_provider='github' AND github_repo_id IS NULL`, groups by installation, mints one installation token per installation, fetches each repo's id/node_id, and updates rows. Implement as either:
- an **admin-only** route (`superadmin`-gated, mirroring existing `/admin/*` patterns), invoked once; or
- a guarded scheduled/cron one-shot.

Decide A-only-vs-A+B with the reviewer during `/do`; if B is deferred, file it explicitly per `.claude/rules/09-task-tracking.md` (no silent research-only findings). Recommended: ship both — the user's intent is "all legacy projects."

## Implementation Checklist

- [ ] Add a `GET /repos/{owner}/{repo}` helper (installation-token-authenticated) returning `{ id, nodeId, fullName }`; reuse existing GitHub fetch/error conventions in `services/github-app.ts`.
- [ ] Part A: lazy self-heal in `runtime.ts` git-token handler — fetch+persist id/node_id/canonical name BEFORE policy resolution; guard unique collision; fall through to name-fallback on fetch failure.
- [ ] Part B: bulk backfill (superadmin route or one-shot job) over legacy github projects, batched per installation with a sane concurrency cap.
- [ ] Idempotency: both parts only touch rows where `github_repo_id IS NULL`; safe to re-run.
- [ ] Rename handling: when the fetched canonical `full_name` differs from stored `repository`, update `repository` too.
- [ ] Structured logging on every skip/failure (project id, installation id, reason) per `.claude/rules/11-fail-fast-patterns.md`.
- [ ] Docs sync: update any self-hosting/architecture docs that describe repo-id capture if behavior is documented (`.claude/rules/01-doc-sync.md`).

## Acceptance Criteria (each maps to a test)

- [ ] Legacy github project (id null, has installation + repo name) mints a git token → `github_repo_id`/`github_repo_node_id` are persisted and `repositoryIds` scoping is used (NOT `repositories`). *(vertical-slice test, rule 35)*
- [ ] Legacy github project **with a custom GitHub CLI policy** mints a git token successfully (no 403) after self-heal. *(regression test — the class of bug that motivated this task, rule 02)*
- [ ] Bulk backfill updates every dormant legacy github project across multiple installations; a project whose repo returns 404 is skipped + logged and does NOT abort the batch.
- [ ] Stored name was stale (repo renamed while id was null) → backfill updates `repository` to the canonical `full_name` and sets the id.
- [ ] Re-running either path is a no-op on already-backfilled rows (idempotent).
- [ ] Would-be `(user_id, github_repo_id)` unique collision is handled gracefully (skip + log), no 500.
- [ ] The personal-installation leak fix is preserved: post-backfill scoping is `repositoryIds: [id]` (strictly tighter than name scoping).

## Out of Scope / Notes
- Not changing the `repositories: [name]` last-resort guard's existence — it remains for the no-project / fetch-failure path, but should rarely fire after backfill.
- Staging verification (rule 13): provision a workspace on a legacy-style github project (id null), mint a git token, confirm 200 + that the row now has a numeric id (query D1 via `$CF_TOKEN`, rule 32), and confirm `gh`/push works inside the workspace.

## Execution
Execute this task using the `/do` skill (full workflow: research → worktree → implement → tests → specialist review → staging verification → PR). Open a normal PR through the standard gates; do not commit directly to main.
