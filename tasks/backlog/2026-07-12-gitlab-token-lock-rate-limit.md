# Add refresh-aware rate limiting to GitLabUserAccessTokenLock

## Problem

Security review of the GitLab integration (PRs #1545/#1547) flagged (HIGH-3) that the
GitLab token vending path has no per-principal rate limit. Rule 28 requires credential
rotation endpoints to have an atomic per-principal rate limit.

The finding was **deferred** (not fixed in the GitLab PRs) for these reasons:

- The vending endpoint (`POST /api/workspaces/:id/git-token`) is not publicly reachable:
  it requires a valid workspace-scoped callback JWT, and the handler fail-closes on a
  `project_gitlab_repositories.user_id` ↔ `workspaces.user_id` mismatch before any token
  mint (`apps/api/src/routes/workspaces/runtime.ts`, gitlab branch).
- The catastrophic abuse vector — concurrent refresh replaying a consumed single-use
  GitLab refresh token and revoking the whole token family — is already eliminated by the
  per-user `GitLabUserAccessTokenLock` DO mutex
  (`apps/api/src/durable-objects/gitlab-user-access-token-lock.ts`).
- A naive per-call rate limit inside the DO would be incorrect: BetterAuth's
  `auth.api.getAccessToken` only performs an upstream refresh when the stored token is
  expired. Most calls are cached reads serving legitimate git credential-helper fetches
  (every `git fetch`/`push` in a workspace hits this path). Throttling calls would break
  normal git operations while providing little protection.

## Correct Fix (this task)

Rate-limit **upstream refreshes**, not calls:

1. Track when a call actually triggered an upstream GitLab refresh (compare
   `accessTokenExpiresAt` before/after, or read the account row's token before the
   BetterAuth call inside the existing lock).
2. Maintain an atomic per-user refresh counter in DO storage (the DO is per-user via
   `idFromName(userId)`, and the existing promise-chain mutex serializes access, so a
   storage-backed counter is atomic by construction — satisfies rule 28 #4).
3. On exceeding N refreshes per window (env-configurable, `DEFAULT_*` constant per
   Constitution Principle XI), return `429`/`token_unavailable` without calling upstream.
4. Behavioral tests per rule 28: at-limit rejection, window rollover reset, and cached
   reads NOT counted against the limit.

## Acceptance Criteria

- [ ] Refresh-aware counter in DO storage (not KV), env-configurable window + limit
- [ ] Cached token reads are never throttled
- [ ] At-limit upstream refresh attempts are rejected without contacting GitLab
- [ ] Tests: at-limit rejection, window rollover, cached-read exemption
- [ ] No secret values logged

## Context

- Discovered during: security-auditor review of GitLab PRs #1545/#1547 (2026-07-12
  overnight hardening session, task `01KXC7NZHVQYQ4D9KNAM3MZ7FR`)
- Related rules: `.claude/rules/28-credential-resolution-fallback-tests.md` (rate limit
  requirement), `.claude/rules/45-durable-object-concurrency-mutex.md` (the existing lock)
