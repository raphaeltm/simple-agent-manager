# Fix GitHub OAuth refresh reauth failures

## Problem

New-session chat submits can return an opaque 500 when a user's GitHub OAuth access token is expired and BetterAuth refresh fails. GitHub returns some refresh failures as HTTP 200 JSON error bodies, BetterAuth 1.6.11 treats that as success, falls back to the stale stored access token, and SAM then hits GitHub with an expired token. The repository access gate throws a plain `Error`, which reaches `app.onError` as `INTERNAL_ERROR`.

GitHub App refresh tokens are single-use and rotating, so concurrent refreshes at the expiry boundary can also consume the refresh token twice and wedge the account until logout/login.

## Research Findings

- Full investigation: SAM idea `01KWK7HB6T68R0EPTR32BQ2TAW`.
- `apps/api/src/auth.ts` configures the GitHub social provider and can supply a provider-level `refreshAccessToken` override.
- `apps/api/src/services/github-user-access-token.ts` currently trusts any non-null `auth.api.getAccessToken` result and does not reject already-expired `accessTokenExpiresAt` values.
- `apps/api/src/services/github-app.ts:getUserInstallationRepositories` currently throws a plain `Error` for GitHub API non-OK responses.
- New-session submit reaches the failure via `apps/api/src/routes/tasks/submit.ts` -> `requireRepositoryUserAccess` -> `assertRepositoryAccess`.
- Other `assertRepositoryAccess`/repository list callers include `apps/api/src/routes/workspaces/runtime.ts`, `apps/api/src/routes/projects/repository-access.ts`, `apps/api/src/routes/projects/crud.ts`, and GitHub UI routes.
- Existing `CodexRefreshLock` demonstrates the required DO mutex pattern and rule-45 test style.
- Required rules: `.claude/rules/28-credential-resolution-fallback-tests.md`, `.claude/rules/35-vertical-slice-testing.md`, `.claude/rules/45-durable-object-concurrency-mutex.md`.

## Implementation Checklist

- [x] Add a custom GitHub `refreshAccessToken` override in `apps/api/src/auth.ts`.
  - [x] POST to `https://github.com/login/oauth/access_token` with `Accept: application/json`.
  - [x] Throw on non-2xx.
  - [x] Throw on 2xx JSON bodies containing `error`.
  - [x] Return BetterAuth-compatible OAuth2 token fields on success.
- [x] Serialize GitHub refresh per user.
  - [x] Add a GitHub OAuth refresh lock Durable Object modeled on `CodexRefreshLock`.
  - [x] Read the account state inside the lock.
  - [x] Refresh only if the token is still expired/near expiry.
  - [x] Persist rotated tokens before releasing the lock.
  - [x] Wire Worker env bindings and exports.
- [x] Harden token boundaries.
  - [x] Make `getGitHubUserAccessTokenWithHeaders` return null and structured warn when `accessTokenExpiresAt` is in the past.
  - [x] Convert GitHub repository-list 401 to `AppError(401, 'GITHUB_REAUTH_REQUIRED', ...)`.
  - [x] Convert GitHub repository-list 403 to a typed forbidden error.
  - [x] Ensure GitHub API repository-list failures do not escape as plain `Error` and produce opaque 500s.
- [x] Frontend re-auth handling.
  - [x] In `apps/web/src/lib/api/client.ts`, special-case `GITHUB_REAUTH_REQUIRED`.
  - [x] Surface a clear sign-out/re-login affordance instead of a generic error.
- [x] Regression tests.
  - [x] GitHub refresh endpoint returns HTTP 200 with `{"error":"bad_refresh_token"}` -> wrapper returns null, never stale token.
  - [x] Expired stored token and failed refresh -> `POST /api/projects/:projectId/tasks/submit` returns typed 401 `GITHUB_REAUTH_REQUIRED`, not 500, via a vertical-slice route test with realistic D1 state.
  - [x] `accessTokenExpiresAt` in the past -> wrapper returns null.
  - [x] Rule-45 concurrency test: two overlapping refresh requests with dynamic state-mutating mocks produce exactly one GitHub refresh POST and both callers get usable tokens.
  - [x] Frontend behavioral test renders and simulates the re-auth flow.
- [ ] Validation and delivery.
  - [ ] Run relevant unit/integration tests during implementation.
  - [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
  - [ ] Run specialist reviews: task-completion-validator, cloudflare-specialist, security-auditor, test-engineer, ui-ux-specialist, constitution-validator.
  - [ ] Deploy to staging and verify changed behavior end to end.
  - [ ] Open PR, wait for CI, merge if unblocked.

## Acceptance Criteria

- GitHub refresh failures represented as HTTP 200 JSON error bodies are treated as failed refreshes, not stale-token success.
- Concurrent expired GitHub OAuth refreshes for a single user are serialized so only one upstream refresh POST happens.
- Expired or unavailable GitHub user authorization produces typed `401 GITHUB_REAUTH_REQUIRED` from new-session submit, not an opaque 500.
- GitHub repository access authorization failures are typed and actionable.
- Frontend shows a clear GitHub re-auth prompt with sign-out/re-login affordance.
- No token values are logged.
- Required regression tests pass and are discriminating for the concurrency mutex.
