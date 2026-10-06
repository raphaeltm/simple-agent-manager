# GitHub org installation visibility for multiple users

## Problem Statement

A second staging user in the same GitHub organization could not see or use the already-installed org GitHub App installation. GitHub user-context discovery showed the user had access to installation `114422957` for `tmp-srv-prs-org`, but SAM did not persist the per-user link.

## Critical Operational Note

Migration `0055_github_installations_external_id.sql` has already been deployed to staging via the official `deploy-staging.yml` workflow on branch `sam/verify-org-visibility-staging-01ksjn`.

- Deployed commit: `3fc7e3c1`
- Staging workflow run: `26466251676`
- Deploy result: passed
- D1 migration and post-migration integrity gate: passed
- Smoke tests: passed, `12 passed`

Any follow-up must treat the staging database as already migrated. Do not redesign this as if the migration has not run.

## Research Findings

- Staging D1 schema had a legacy table-level `UNIQUE` constraint on `github_installations.installation_id`.
- The existing migration `0022_org_installation_sharing.sql` added a composite uniqueness model but could not remove the deployed table-level unique constraint.
- Rebuilding `github_installations` to drop the table-level constraint is unsafe because `projects` references `github_installations` with cascade semantics; the repository migration safety check rejected that approach.
- GitHub logs confirmed the secondary user could access the org installation via `/user/installations`; the failing operation was the D1 insert for the second SAM user.
- The correct narrow fix is to preserve the legacy unique storage key while adding a separate external GitHub installation id used for GitHub API calls and API responses.

## Implementation Checklist

- [x] Add additive migration for nullable `external_installation_id`.
- [x] Backfill existing rows with `external_installation_id = installation_id`.
- [x] Add index and per-user unique index for `(user_id, external_installation_id)`.
- [x] Store new duplicate per-user rows with synthetic storage keys in `installation_id`.
- [x] Use `external_installation_id` for GitHub API calls and public API responses.
- [x] Keep existing DB row ids as project/workspace foreign-key targets.
- [x] Update tests and seed helpers for stored-vs-external installation ids.
- [x] Deploy to staging through official GitHub Actions pipeline.
- [x] Verify primary and secondary staging test users both see `tmp-srv-prs-org`.

## Acceptance Criteria

- [x] Secondary staging user can see `tmp-srv-prs-org` without GitHub redirect/configure flow.
- [x] API returns external GitHub installation id `114422957`, not a synthetic storage key.
- [x] D1 stores secondary per-user link without violating legacy unique `installation_id` constraint.
- [x] Existing GitHub API call sites use the external installation id.
- [x] Migration safety check passes.
- [x] Focused GitHub route/service tests pass.
- [x] API typecheck passes.
- [x] API lint has no errors.

## Validation Evidence

Local:

- `pnpm quality:migration-safety` passed.
- `pnpm --dir apps/api exec vitest run tests/unit/routes/github-installations.test.ts tests/unit/services/github-app.test.ts` passed, 26 tests.
- `pnpm --dir apps/api run typecheck` passed.
- `pnpm --dir apps/api exec eslint 'src/**/*.ts' 'tests/**/*.ts' --quiet` passed.

Staging:

- `gh workflow run deploy-staging.yml --ref sam/verify-org-visibility-staging-01ksjn` completed successfully as run `26466251676`.
- Staging deploy, D1 migration, post-migration data integrity, health check, and smoke tests all passed.
- `SAM_PLAYWRIGHT_PRIMARY_USER` and `SAM_PLAYWRIGHT_SECONDARY_USER` both received `tmp-srv-prs-org` from `https://api.sammy.party/api/github/installations` with `installationId: 114422957`.
- Staging D1 contains the secondary row with synthetic `installation_id` and `external_installation_id = 114422957`.

## References

- Branch: `sam/verify-org-visibility-staging-01ksjn`
- Commit: `3fc7e3c1`
- Staging workflow run: `26466251676`
- Migration: `apps/api/src/db/migrations/0055_github_installations_external_id.sql`
