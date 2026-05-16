# Canonical GitHub Installation State Follow-Up

## Problem

The canonical GitHub App installation account design from idea
`01KRRRJ6BABJ5NK8E3BDZPFJHF` is already present on `main`, including
`github_installation_accounts`, route upserts, shared-org discovery from
canonical rows, webhook uninstall tombstoning, and tests.

One acceptance detail still needs verification and repair: canonical backfill
must dedupe by external `installation_id` while preferring organization
metadata when any duplicate per-user link says the account is an organization.
The existing `0052_github_installation_accounts.sql` backfill chooses the latest
row by timestamps, which can preserve a newer personal row over an older
organization row for the same external installation.

## Research Findings

- `apps/api/src/db/migrations/0052_github_installation_accounts.sql` creates
  the canonical table and performs the initial backfill. It excludes the trial
  sentinel installation id `0`, but ranks only by `updated_at`, `created_at`,
  and row id.
- `apps/api/src/db/schema.ts` defines `githubInstallationAccounts` keyed by the
  external GitHub installation id, with normalized account lookup and
  `uninstalled_at` tombstone state.
- `apps/api/src/routes/github.ts` already upserts canonical rows from callback,
  direct sync, and installation-created webhook flows; shared org discovery now
  reads active canonical organization rows narrowed by authenticated user's
  GitHub org memberships and verifies each candidate with
  `verifyUserInstallationAccess()`.
- Per-user unlink uses only `github_installations` by internal row id plus
  current user id and includes a comment warning not to delete canonical shared
  state. GitHub-source uninstall webhooks tombstone canonical state and remove
  all per-user links for that external installation.
- `apps/api/tests/unit/routes/github-installations.test.ts` covers callback,
  direct sync, shared discovery, per-user unlink isolation, and webhook
  uninstall cleanup.
- `apps/api/tests/unit/db/github-installation-accounts-migration.test.ts` covers
  canonical migration backfill but does not yet test the mixed personal/org
  duplicate preference.
- Relevant postmortems:
  - `docs/notes/2026-04-25-migration-cascade-data-loss-postmortem.md`: avoid
    destructive migrations and understand FK relationships before touching data
    model tables.
  - `docs/notes/2026-04-25-artifacts-broken-merge-postmortem.md`: staging
    verification must test changed behavior, not just a surface response.
  - `docs/notes/2026-03-07-chat-session-leakage-postmortem.md`: data isolation
    boundaries need both positive and negative tests.

## Implementation Checklist

- [ ] Add a forward D1 repair migration that reselects canonical metadata from
  existing per-user links, deduping by external `installation_id` and preferring
  organization rows over personal rows.
- [ ] Keep the migration additive/idempotent and avoid destructive table
  changes.
- [ ] Extend the migration test to apply the canonical migration sequence and
  prove organization metadata wins over a newer personal duplicate.
- [ ] Run focused API tests and migration safety checks.
- [ ] Run required specialist reviews and staging verification before PR/merge.

## Acceptance Criteria

- Canonical GitHub installation account state exists and remains distinct from
  per-user `github_installations` linkage rows.
- Backfill/repair canonical rows dedupe by external `installation_id` and
  prefer organization metadata when any duplicate row says organization.
- Existing tests continue proving two-user/shared discovery/unlink/uninstall
  behavior.
- The account deletion invariant remains documented: deleting or unlinking a
  SAM user may delete only that user's per-user linkage rows, never canonical
  shared organization installation state.
