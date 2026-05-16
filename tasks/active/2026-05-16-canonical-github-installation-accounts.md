# Canonical GitHub Installation Accounts

## Problem

`github_installations` is currently both the per-user SAM link and the only local seed for shared GitHub organization installations. Shared org discovery finds rows linked to other SAM users, narrows by the signed-in user's GitHub org memberships, verifies access with the user's token, then creates that user's row.

If the only linked SAM user for an org installation unlinks or deletes their account, the local seed row can disappear. Future org members may no longer discover the shared GitHub App installation, even though the GitHub App remains installed on the organization.

## Research Findings

- `apps/api/src/db/schema.ts` defines `githubInstallations` as per-user rows with unique `(user_id, installation_id)` and cascade on user delete.
- `apps/api/src/routes/github.ts` owns callback, webhook, delete/unlink, direct sync, and shared org discovery.
- Current shared discovery in `getSharedOrgInstallationCandidates()` reads organization rows from `githubInstallations` owned by other users and dedupes by external `installation_id`.
- `DELETE /api/github/installations/:id` removes only the signed-in user's per-user row. This behavior should stay per-user only.
- GitHub webhook `installation.deleted` deletes all per-user rows for the external installation. This is GitHub-source-of-truth uninstall cleanup and must also remove or tombstone canonical state.
- `apps/api/src/routes/projects/_helpers.ts` and `apps/api/src/routes/workspaces/crud.ts` intentionally enforce per-user ownership by row id. Existing project/workspace ownership should remain isolated through per-user rows.
- Existing tests in `apps/api/tests/unit/routes/github-installations.test.ts` mock Drizzle at the route boundary and cover callback, sync, conflict handling, and shared org discovery.
- Migration safety rule forbids table recreation/destructive parent-table changes. This task only needs additive DDL and backfill.
- Relevant postmortems:
  - `docs/notes/2026-04-25-migration-cascade-data-loss-postmortem.md`: avoid table recreation and destructive migrations.
  - `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md`: auth/routing tests must exercise real route mounting when auth boundaries change; this task does not add middleware.
  - `docs/notes/2026-04-25-artifacts-broken-merge-postmortem.md`: staging verification must test the actual changed behavior, not just surface-level responses.

## Implementation Checklist

- [x] Add `github_installation_accounts` D1 migration with canonical rows keyed by external `installation_id`, normalized account name, timestamps, and tombstone/uninstalled timestamp.
- [x] Backfill canonical rows from existing `github_installations`, deduping by external `installation_id` and preferring active non-sentinel metadata.
- [x] Add Drizzle schema and types for `githubInstallationAccounts`.
- [x] Add route helpers to upsert canonical installation account state before/alongside per-user link creation.
- [x] Update GitHub callback to upsert canonical state before inserting a per-user row.
- [x] Update direct sync to upsert canonical state for every accessible installation before inserting missing per-user rows.
- [x] Update installation-created webhook flow to upsert canonical state before inserting the installer user's per-user row.
- [x] Update installation-deleted webhook flow to remove or tombstone canonical state and remove all per-user links for that external installation.
- [x] Update shared org discovery to read active canonical organization rows narrowed by signed-in user's org memberships, then verify candidates with the user's token before creating per-user rows.
- [x] Preserve per-user unlink semantics and document that account deletion must delete only per-user `github_installations` rows.
- [x] Add focused tests for canonical upsert/backfill behavior, multi-user linking, per-user unlink isolation, canonical shared discovery, and uninstall cleanup.
- [ ] Run migration safety, lint/typecheck/tests/build.
- [ ] Run required specialist reviews and staging verification before PR/merge.

## Acceptance Criteria

- A canonical installation-account table exists and is backfilled from existing per-user rows without destructive migration patterns.
- Callback, direct sync, and webhook created flows upsert canonical account state for GitHub App installations.
- Shared org discovery no longer depends on another user's per-user row existing; it uses canonical active organization rows narrowed by the signed-in user's org memberships.
- Verification with the user's GitHub token still gates creation of a per-user row from shared canonical state.
- Unlinking or deleting one user's per-user row does not remove canonical state or another user's link.
- GitHub `installation.deleted` webhook cleanup intentionally removes/tombstones canonical state and removes all per-user links for that external installation.
- Existing project and workspace ownership behavior remains per-user and row-id based.
- Future account deletion implementation has an explicit code/doc comment warning not to delete canonical org installation state.
