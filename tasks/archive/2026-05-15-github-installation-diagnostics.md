# GitHub Installation Diagnostics

## Problem

Shared GitHub App organization installations are not being associated with additional org members in production. The GitHub setup callback and installation sync paths currently fail without enough structured logs to determine whether the missing row is caused by unauthenticated callback access, missing BetterAuth GitHub user tokens, inaccessible installation IDs, GitHub API results, or database insert behavior.

## Research Findings

- `GET /api/github/callback` in `apps/api/src/routes/github.ts` uses `optionalAuth()`, so unauthenticated callbacks are expected and must be logged explicitly before redirecting back to the app.
- `syncUserInstallations()` in `apps/api/src/routes/github.ts` is best-effort and currently swallows per-install insert races, which hides whether a missing installation was discovered and whether an insert was attempted.
- `getGitHubUserAccessToken()` in `apps/api/src/routes/github.ts` uses BetterAuth `auth.api.getAccessToken()`. BetterAuth returns `accessToken`, `scopes`, `idToken`, and expiry metadata; logs must include only token presence, type/scope metadata, and never token values.
- `getUserAccessibleInstallations()` in `apps/api/src/services/github-app.ts` calls GitHub `GET /user/installations` but currently does not expose response status/count diagnostics to callers.
- Existing structured logging uses `log.info|warn|error('event.name', { ...details })` from `apps/api/src/lib/logger.ts`.
- Existing tests in `apps/api/tests/unit/routes/github-installations.test.ts` already mock BetterAuth, auth middleware, and GitHub accessible installations, making them the right place to assert diagnostic paths.
- `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md` and `docs/notes/2026-03-25-deployment-identity-token-middleware-leak-postmortem.md` emphasize testing auth/callback behavior through real route wiring, not source checks.
- `docs/notes/2026-04-18-project-credentials-security-hardening-postmortem.md` reinforces that token-handling logs and branches must avoid exposing credential values.

## Implementation Checklist

- [x] Add callback diagnostics for auth presence, callback installation ID, token availability, accessible installation summary, match result, and DB insert outcome.
- [x] Add explicit unauthenticated callback logging before redirecting to app login with the installation ID.
- [x] Add sync diagnostics for token availability, GitHub user-installations response status/count, missing installation count, and each insert attempt result.
- [x] Add BetterAuth token retrieval diagnostics with token-present boolean, token type if available, and scopes if available, without logging token values.
- [x] Keep logs structured with `userId` and `installationId` where available.
- [x] Add or update unit tests for diagnostic logging paths, including unauthenticated callback, callback insert success/rejection, sync inserts, and token metadata logging.
- [x] Run focused tests and relevant quality checks.

## Acceptance Criteria

- Production logs can answer whether a callback request was authenticated and which `installation_id` was received.
- Production logs can answer whether BetterAuth returned a GitHub user token without exposing the token.
- Production logs can answer what GitHub returned from `GET /user/installations` by status, count, installation IDs, and account names.
- Production logs can answer whether the callback `installation_id` matched an accessible installation.
- Production logs can answer whether each DB insert succeeded, conflicted/skipped, or errored.
- Unit tests verify the new diagnostic events and protect against accidental token-value logging.

## References

- `apps/api/src/routes/github.ts`
- `apps/api/src/services/github-app.ts`
- `apps/api/tests/unit/routes/github-installations.test.ts`
- `tasks/archive/2026-05-08-verified-shared-github-installations.md`
- `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md`
- `docs/notes/2026-03-25-deployment-identity-token-middleware-leak-postmortem.md`
- `docs/notes/2026-04-18-project-credentials-security-hardening-postmortem.md`
