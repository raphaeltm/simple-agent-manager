# Server-side KV caching for slow Files and Triggers pages

## Problem

The Files and Triggers project pages repeat expensive backend work on every request. Files re-checks GitHub access, re-mints installation tokens, and re-fetches full repository trees without cache reuse. Triggers repeats project multiplayer and credential-attribution queries and the UI does not use the app's TanStack Query cache.

## Research findings

- `apps/api/src/routes/projects/repo-browse.ts` calls `requireRepositoryUserAccess()`, then re-loads the same installation row before resolving the GitHub repo browser.
- `apps/api/src/routes/projects/_helpers.ts` performs the GitHub user∩installation repository access check through `assertRepositoryAccess()`.
- `apps/api/src/services/github-app.ts` mints installation tokens through `getInstallationToken()` and paginates user installation repositories through `assertRepositoryAccess()`.
- `apps/api/src/services/repo-browse/github.ts` fetches `git/trees/{ref}?recursive=1` directly. Git tree responses are immutable by commit SHA, so branch refs should be resolved to SHA before cache lookup.
- `apps/api/src/services/project-multiplayer.ts` computes project multiplayer state with three count queries that repeat across trigger-bearing pages.
- `apps/api/src/services/credential-attribution-health.ts` recomputes project credential attribution from triggers, profiles, attachments, and users.
- `apps/web/src/pages/ProjectTriggers.tsx` uses hand-rolled state/effect loading while `apps/web/src/hooks/useAgentProfiles.ts` demonstrates the current TanStack Query mutation/invalidation pattern.
- `.specify/memory/constitution.md` Principle XI requires cache TTLs to be env-configurable with default constants.

## Checklist

- [x] Add env-configurable defaults for GitHub installation token, repo-access, git-tree, multiplayer-state, and credential-attribution caches.
- [x] Cache GitHub App installation tokens in KV with a ~50 minute default TTL.
- [x] Cache user+installation+repo access results in KV with a ~5 minute default TTL and invalidate by TTL.
- [x] Thread the installation row from the repo-access gate into repo browser resolution to eliminate the duplicate D1 query.
- [x] Cache GitHub git tree responses in KV by commit SHA with a 24h default TTL, resolving branch refs to SHA first.
- [x] Preserve Cloudflare Artifacts repo browser behavior.
- [x] Cache project multiplayer state per isolate with a short env-configurable TTL and explicit invalidation hook.
- [x] Cache credential attribution health per project with a short env-configurable TTL and explicit invalidation hook.
- [x] Invalidate relevant caches after trigger/profile/member mutations touched by this change.
- [x] Migrate `ProjectTriggers.tsx` to TanStack Query using the existing query-key/query-options style.
- [x] Add/extend tests for KV hits, misses, TTL expiry, duplicate D1 elimination, token reuse, invalidation, and trigger query behavior.
- [x] Run focused and full validation.
- [x] Run Phase 5 specialist reviews and stop with a draft PR; do not deploy staging or merge.

## Acceptance criteria

- Files page GitHub App token minting reuses cached tokens across requests.
- Files page user repository access checks reuse cached positive results for the TTL.
- Files page tree fetches reuse immutable commit-SHA cache entries.
- Files page Artifacts-backed projects continue to bypass GitHub-only caches.
- The duplicate installation D1 lookup in repo browse is removed.
- Triggers list uses TanStack Query and invalidates after mutations.
- Multiplayer state and credential attribution health use configurable short-lived server caches with tests.
- All new cache TTLs have `DEFAULT_*` constants and env overrides.
- Draft PR is pushed and left open; staging and merge are skipped by explicit instruction.
