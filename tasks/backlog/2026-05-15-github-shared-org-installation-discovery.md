# Discover GitHub Shared Org Installations

## Problem

Users who belong to a GitHub organization should passively discover a GitHub App installation that SAM already knows for that organization, even when the installation row was created by another SAM user. The current `/api/github/installations` sync only records installations returned by GitHub's `GET /user/installations`, so a user can miss an already-installed org app and be forced through an unnecessary Install/Configure redirect.

The final authorization gate must be GitHub verification with the signed-in user's token for the specific installation. Organization membership is only a candidate narrowing step.

## Research Findings

- `apps/api/src/routes/github.ts` currently calls `syncUserInstallations()` from `GET /api/github/installations`.
- `syncUserInstallations()` already keeps the existing `GET /user/installations` user-context sync and inserts missing per-user rows.
- `apps/api/src/services/github-app.ts` contains `getUserAccessibleInstallations()` for `GET /user/installations`.
- `github_installations` has a unique `(user_id, installation_id)` index but no org-wide unique key, so shared external installation IDs can have per-user rows.
- Route tests in `apps/api/tests/unit/routes/github-installations.test.ts` mock Drizzle builders and GitHub app service calls for sync/callback behavior.
- Service tests in `apps/api/tests/unit/services/github-app.test.ts` cover GitHub REST request construction and logging without leaking tokens.
- Relevant postmortem: `docs/notes/2026-04-25-migration-cascade-data-loss-postmortem.md`. No migration is needed for this task.
- GitHub REST docs confirm user-context endpoints for listing the authenticated user's organizations and listing repositories accessible to a user for a specific app installation.

## Implementation Checklist

- [ ] Add GitHub service helper to fetch signed-in user's org memberships with the user token.
- [ ] Add GitHub service helper to verify access to one installation using `GET /user/installations/{installation_id}/repositories?per_page=1`.
- [ ] Extend `/api/github/installations` sync with a second best-effort shared-org discovery pass after existing `/user/installations` sync.
- [ ] Candidate selection must intersect user org logins with known organization installation rows and exclude installations already recorded for the current user.
- [ ] Do not scan every known installation before narrowing by user org memberships.
- [ ] Skip `403`/`404` verification failures with diagnostic logs and no insert.
- [ ] Treat transient GitHub/token/network errors as best-effort failures that do not delete existing rows and do not block returning local rows.
- [ ] Add route tests for shared org discovery insert, org exclusion, `403`/`404` skip, existing sync preservation, and fallback error behavior.
- [ ] Add service tests for org membership fetch and installation-specific verification.

## Acceptance Criteria

- [ ] Existing `/user/installations` discovery still works.
- [ ] A known org installation is inserted for the current user only when the user's org memberships include the org and installation-specific user-token verification succeeds.
- [ ] Known org installations outside the user's org memberships are not verified or inserted.
- [ ] `403`/`404` verification responses skip the candidate and log useful context.
- [ ] Fallback discovery errors do not erase existing rows and do not prevent returning current local installations.
- [ ] No app-wide installation enumeration or installation-token org member checks are introduced.

## References

- Idea: `01KRPY2RCG9JYHKP843BYA41DV`
- Task: `01KRPY3EM8307SDQYPVTK2668G`
- `apps/api/src/routes/github.ts`
- `apps/api/src/services/github-app.ts`
- `apps/api/tests/unit/routes/github-installations.test.ts`
- `apps/api/tests/unit/services/github-app.test.ts`
