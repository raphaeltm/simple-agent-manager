# Harden github-webhook installation.created owner guard + one-time residual leak-row sweep

- **SAM idea:** 01KTFA4VBT1HVS9HV256QFFYBM
- **SAM task:** 01KTGKGP0BGADZKTE3BVWAWBYS
- **Severity:** MEDIUM
- **Branch:** sam/implement-sam-idea-01ktfa4vbt1hvs9hv256qffybm-01ktgk

## Problem Statement

PR #1236 added a personal-install owner guard to the OAuth callback / sync-discovery
path so that a SAM user can only own a GitHub *personal* installation whose account
identity matches their own GitHub identity. This closed a leak where a personal
installation belonging to GitHub user A could be recorded under SAM user B.

Two gaps remain:

1. **Webhook insert path is unguarded.** `apps/api/src/routes/github-webhook.ts`
   handles `installation.created`: it looks up the SAM user by the webhook
   `sender.id` and inserts a `github_installations` row **without** the
   personal-owner guard. A crafted/forwarded delivery (or any case where the
   installer differs from the account owner) can insert a personal installation
   row owned by the wrong user. The OAuth/sync path is guarded; the webhook path
   is not. The two paths can also silently diverge over time.

2. **Residual leaked rows already in the DB.** Two rows were manually deleted in
   prod (`01KTEWYMY2QASTZRD78XD3B673`, `01KTF1PY8D4NBQPGA7WHCFW1DZ`). The read-path
   self-heal (`filterVisibleInstallations`) only cleans rows for users who revisit
   repo selection. Users who never revisit keep their leaked rows indefinitely.
   A one-time generalized reconciliation is needed.

## Research Findings

### Existing owner-guard logic (the thing to reuse)
- `apps/api/src/routes/github.ts:isAuthenticatedUsersPersonalInstallation()`
  (~698-709): for personal installs prefers numeric `account.id === user.id`,
  falls back to case-insensitive `account.login === user.login`.
- Callback owner-guard (~347-363): logs `github.personal_installation_owner_mismatch`
  and calls `deleteInstallationRow(db, userId, rowId)` if a row exists.
- `filterVisibleInstallations()` (~496-543): read-path self-heal, deletes
  mismatched personal rows and logs `github.installations_sync.removed_mismatched_personal_installation`.
- `deleteInstallationRow()` (~545-558): `DELETE ... WHERE id = ? AND user_id = ?`
  (no cascade guard — acceptable for single-row read-path heal).

### Account-type normalization
- GitHub raw `account.type` is `'User'` / `'Organization'`.
- `normalizeAccountType()` (`services/github-installation-accounts.ts`) -> `'personal'` / `'organization'`.
- DB `github_installations.account_type` stores the **normalized** value.

### CRITICAL: pure-SQL generic sweep is impossible
- `users` has `githubId` (numeric string) but **no GitHub login**.
- `github_installation_accounts` has `accountName` (login) but **no numeric account id**.
- `github_installations` stores neither the canonical numeric account id nor the user login.
- => There is no in-DB way to compare "installation's true GitHub account identity"
  against "owning user's GitHub identity" generically. Detection requires calling
  the GitHub App API to resolve the installation's account, then comparing its
  numeric id to the owning user's `githubId`.

### CRITICAL: github_installations IS a CASCADE parent (idea text is wrong)
- `projects.installationId` -> `githubInstallations.id` with `onDelete: 'cascade'`.
- Deleting a `github_installations` row cascade-deletes its `projects` (and downstream
  tasks/triggers). The bulk sweep MUST skip rows referenced by any project and
  surface them in the summary rather than silently destroying project data.
  (Rule 31 migration-safety + general data-integrity.)

### Precedent for the admin sweep (Part B pattern)
- `routes/admin-github-repo-id-backfill.ts`: superadmin-only POST route
  (`use('/*', requireAuth(), requireApproved(), requireSuperadmin())`), parses
  optional `limit`, calls a bulk service, returns `{ summary }`.
- `services/github-repo-id-backfill.ts:bulkBackfillGithubRepoIds()`: batched,
  idempotent, caches installation tokens, returns a summary with `hasMore`.
  This is the template for the sweep service.

### github-app.ts helpers
- `generateAppJWT(env)`, `getInstallationToken(installationId, env)` exist.
- **No** helper that GETs `/app/installations/{id}` to return the account object —
  a new helper is needed for the sweep to resolve `account.{id, login, type}`.

## Design

### Part 1 — Webhook owner guard (Gap 1)
1. Add a shared primitive (in `services/github-installation-accounts.ts`):
   `personalInstallationOwnerMatches(account, owner)` — for the personal case,
   prefer numeric id match (`account.id === owner.id`), fall back to
   case-insensitive login match. Returns boolean.
2. Refactor `github.ts:isAuthenticatedUsersPersonalInstallation()` to delegate to
   the shared primitive (keep the `normalizeAccountType !== 'personal'` short-circuit).
3. In `github-webhook.ts` `installation.created`, before inserting the per-user row:
   - If the install is personal and the account owner does NOT match `sender`,
     **skip the per-user insert** and `log.warn('github.webhook.personal_installation_owner_mismatch', { installationId, senderId, accountId })`.
   - Org installs and matching personal installs insert as before.
   - The canonical-account upsert stays unconditional (unchanged).

### Part 2 — One-time residual sweep (Gap 2)
1. New github-app helper `getInstallationAccount(installationId, env)` — GET
   `/app/installations/{id}` with the app JWT, return `{ id, login, type }` (or
   null on 404/not-found).
2. New service `services/github-installation-leak-sweep.ts`:
   `bulkSweepMismatchedPersonalInstallations(db, env, options?)`:
   - Select a batch of `github_installations` rows with `account_type = 'personal'`
     (limit via env `GITHUB_INSTALLATION_LEAK_SWEEP_BATCH_SIZE` default 50).
   - For each: resolve owning user's `githubId`; resolve installation account via
     the new helper; if `String(account.id) !== String(user.githubId)` -> mismatch.
   - **Cascade guard:** if any `projects` row references this installation row,
     SKIP and count as `skippedReferenced` (do not delete).
   - Delete confirmed mismatches scoped by `(id, userId)`. Log each deletion.
   - Return summary: `{ total, deleted, matched, skippedReferenced, noUser,
     accountUnresolved, fetchFailed, hasMore }`. Idempotent — re-runnable.
3. New superadmin route `routes/admin-github-installation-leak-sweep.ts`
   (mirrors backfill route), mounted in `index.ts` at
   `/api/admin/github-installation-leak-sweep`, returns `{ summary }`.

## Implementation Checklist
- [ ] Add `personalInstallationOwnerMatches()` shared primitive in `github-installation-accounts.ts`
- [ ] Refactor `github.ts:isAuthenticatedUsersPersonalInstallation()` to delegate
- [ ] Add webhook personal owner guard in `github-webhook.ts` (skip + warn on mismatch)
- [ ] Add `getInstallationAccount()` helper in `github-app.ts` (GET /app/installations/{id})
- [ ] Add `bulkSweepMismatchedPersonalInstallations()` service with cascade guard
- [ ] Add superadmin admin route + mount in `index.ts`
- [ ] Add env var `GITHUB_INSTALLATION_LEAK_SWEEP_BATCH_SIZE` (default const, documented)
- [ ] Test (a): webhook personal mismatch -> no per-user row inserted
- [ ] Test (b): webhook personal match -> per-user row inserted
- [ ] Test (c): webhook org install (with user link) -> row inserted regardless
- [ ] Test (d): sweep -> mismatched personal deleted; valid personal kept; valid
      org kept; project-referenced mismatched personal SKIPPED (not deleted)
- [ ] Update docs (security architecture / env reference) if behavior/config surface changes
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green

## Acceptance Criteria
- [ ] Webhook `installation.created` does NOT insert a per-user personal row when
      the account owner differs from the sender (verified by test a).
- [ ] Webhook still inserts personal rows on owner match (test b) and org rows
      regardless of owner (test c).
- [ ] The owner-match logic is a single shared primitive used by both the sync
      path and the webhook path (no duplicated divergent logic).
- [ ] Admin sweep deletes only mismatched personal rows, never org rows, never
      project-referenced rows (test d), is idempotent, and returns a summary with `hasMore`.
- [ ] No `DROP TABLE`; all deletes are scoped `DELETE ... WHERE` (rule 31).
- [ ] Staging: admin sweep endpoint returns a valid summary; webhook endpoint
      still accepts a valid signed delivery without error.

## References
- PR #1236 (personal installation leak fix), PR #1240 (repo-id backfill durable)
- `.claude/rules/31-migration-safety.md` (no DROP TABLE; scoped DELETE)
- `.claude/rules/28-credential-resolution-fallback-tests.md` (branch coverage for trust boundaries)
- `.claude/rules/11-fail-fast-patterns.md` (identity validation at boundaries)
- `services/github-repo-id-backfill.ts` + `routes/admin-github-repo-id-backfill.ts` (Part B precedent)
