# Atomic First-Signup Superadmin Bootstrap

## Problem

With signup approval enabled, `apps/api/src/auth.ts` decides whether a newly
created user is the first real human in Better Auth's
`databaseHooks.user.create.before` hook. The hook reads `users` and returns
`role='superadmin'` when no non-sentinel row exists. Two concurrent signups can
both finish that read before either user insert commits, so both inserts can
persist privileged rows.

This is audit finding BA-01 from backend audit task
`01KZSZ5HDBARX61Q0PCASP1650` (session
`c9487e09-e90d-4e46-84af-f8ecf30f178c`) against main SHA
`fc1e394217248c3bd004b2e6619cf2344eade7e3`.

## Preflight Classification

- `security-sensitive-change`: the affected decision grants the deployment's
  highest application role.
- `business-logic-change`: first-user bootstrap must become a race-safe invariant.
- `external-api-change`: Better Auth lifecycle and adapter return semantics govern
  whether persisted and returned roles agree; the public response contract must
  remain unchanged.
- `cross-component-change`: the flow crosses `apps/api/src/auth.ts`, Better Auth's
  Drizzle adapter, D1/SQLite migrations, Miniflare worker tests, and public
  self-hosting documentation.
- `docs-sync-change`: the public first-login guarantee currently describes only
  login-time atomicity, not concurrent create-time election.

## Research Findings

1. Better Auth runs `databaseHooks.*.create.before` before its adapter `create`
   call. Better Auth 1.5+ deliberately runs database `after` hooks after a
   transaction commits, and its adapter guidance says atomic single-use claims
   need a native database operation rather than a read/delete fallback without a
   real transaction. Therefore neither a separate before-hook read/write nor an
   after-hook write is the same atomic unit as the user insert.
   - Official docs: <https://better-auth.com/docs/concepts/database>
   - Official transaction guidance: <https://better-auth.com/docs/guides/create-a-db-adapter>
   - Official 1.5 hook change: <https://better-auth.com/blog/1-5>
   - Installed 1.6.11 evidence:
     `node_modules/better-auth/dist/db/with-hooks.mjs` calls the before hook,
     adapter create, and queued post-transaction after hook in that order.
2. D1 uses SQLite semantics. SQLite allows only one writer at a time, so an
   insert-time trigger can evaluate and enforce the election in the same atomic
   write statement. Cloudflare documents D1's SQLite semantics and transactional,
   sequential batch behavior; SQLite documents serialized writes and row triggers.
   - <https://developers.cloudflare.com/d1/>
   - <https://developers.cloudflare.com/d1/worker-api/d1-database/#batch>
   - <https://www.sqlite.org/isolation.html>
   - <https://www.sqlite.org/lang_createtrigger.html>
3. SQLite `INSERT ... RETURNING` reports the top-level insert values and does not
   include later changes made by an `AFTER INSERT` trigger. Better Auth's Drizzle
   adapter uses `returning()` for SQLite, so the adapter must reload a trigger-
   eligible user after creation to preserve Better Auth/API response contracts.
   - <https://www.sqlite.org/lang_returning.html#limitations_and_caveats>
   - Installed adapter evidence:
     `node_modules/@better-auth/drizzle-adapter/dist/index.mjs` implements SQLite
     create with `insert(...).values(...).returning()`.
4. `LOGIN_SELF_HEAL_SQL` and migration
   `0062_login_time_superadmin_self_heal.sql` are single-statement atomic heals,
   but deliberately require a sole real user. They cannot prevent two concurrent
   create-before hooks from both choosing `superadmin`.
5. The `system_anonymous_trials` row and custom sentinels are reliably excluded by
   `status='system'`; `.claude/rules/40-sentinel-rows-excluded-from-counts.md`
   requires this exclusion at the database predicate.
6. D1 migrations run before the API Worker is deployed, so both upgrades and clean
   installs receive the trigger before code starts relying on it. The retained
   migration-order task is
   `tasks/archive/2026-07-18-safe-d1-migration-deploy-order.md`.
7. The migration must be additive and retry-safe. `users` is a foreign-key parent,
   so no table recreation or destructive constraint/index retrofit is acceptable.
   `CREATE TRIGGER IF NOT EXISTS` is append-only and does not rewrite user data.
8. The existing worker harness applies the genuine migration chain to real
   Miniflare D1. `apps/api/tests/workers/superadmin-self-heal.test.ts` is the right
   place for concurrency, clean-install, upgrade, sentinel, suspension, and
   login-self-heal compatibility coverage.
9. Root-cause history traces the vulnerable read-then-insert pattern to
   `ebe9588224` (`feat: add user approval / invite-only mode with admin panel`).
   The sentinel exclusion and login self-heal fixed different failure modes but
   did not add a concurrent create test.

Every finding above maps to an implementation or validation item below.

## Data Flow and Proposed Smallest Durable Election

`signup/OAuth user creation` → `createAuth` → Better Auth
`user.create.before` assigns ordinary pending state when approval is enabled →
Drizzle adapter inserts the `users` row and then its usable `accounts` link → an
additive SQLite `AFTER INSERT ON accounts` trigger atomically promotes that user
only if no active superadmin already exists → wrapped adapter reloads the
persisted user → Better Auth builds the unchanged response/session from the final
role and status. A second insert trigger demotes duplicate superadmins created by
legacy Worker code during the migration-before-code upgrade window.

The account-linked `users.role/status` row is the durable claim. No process-memory
lock, lease, eventual login ordering, or uniqueness-conflict 500 is involved. If
an attempt fails before its account link, it leaves no claim; if the link commits,
the trigger's election commits in the same statement.

## Implementation Checklist

- [x] Add a failing real-D1 regression test that forces concurrent approval-enabled
      first-user hooks to observe the empty baseline before concurrent inserts and
      proves the vulnerable code creates multiple superadmins.
- [x] Add the next additive D1 migration with idempotent `AFTER INSERT` triggers
      that promotes exactly one eligible pending user and leaves later users
      pending, excluding system and suspended rows.
- [x] Replace the non-atomic create-before read with deterministic pending defaults
      for approval-enabled creates while preserving open-registration defaults.
- [x] Wrap the Better Auth Drizzle adapter so trigger-eligible user creates reload
      the persisted row after its account link; validate the reloaded identity and
      privilege fields with Valibot before Better Auth builds its response.
- [x] Add real-Miniflare positive and negative controls for sequential first/later
      users; two and three concurrent distinct users; duplicate/retried hooks;
      default and custom sentinels; suspended rows; an existing active superadmin;
      interrupted/failed pre-insert and post-insert attempts; approval enabled and
      disabled; clean migration replay and upgrade application; OAuth-style
      transactional creation; and login-time self-heal compatibility.
- [x] Preserve and update focused unit tests for runtime approval overrides and the
      before-hook contract without relying on substring/source mocks.
- [x] Update the public self-hosting explanation to describe account-link election,
      keep login-time self-heal semantics accurate, and make no operator workflow
      claim beyond actual behavior.
- [x] Add a process rule/checklist improvement requiring database-backed concurrent
      interleaving tests for first-row/empty-table privilege bootstrap decisions.
- [ ] Run focused API unit and worker/D1 tests, full API tests, migration ordering
      and safety gates, clean-install/upgrade replay, lint, typecheck, build, full
      repository tests, security scans, and PR evidence validators.
- [ ] Run and reconcile local `security-auditor`, `test-engineer`,
      `cloudflare-specialist`, `constitution-validator`, `doc-sync-validator`,
      `task-completion-validator`, and a fresh adversarial concurrency review using
      the original finding and aggregate diff.
- [ ] Open exactly one non-draft PR against current `main`, do not stage, do not
      merge, and monitor/fix every applicable CI check to terminal green.

## Acceptance Criteria

- On a clean approval-enabled install, concurrent first signups persist exactly
  one active superadmin and every other real user as `role='user', status='pending'`.
- Sequential approval-enabled signup still creates one active superadmin followed
  by pending users; open registration still creates active ordinary users and
  retains login-time self-heal behavior.
- Better Auth's created-user value and public response observe the same final role
  and status as D1 after the trigger; no temporary privileged response or cached
  privileged session is issued to a losing signup.
- No expected concurrent signup fails because of a uniqueness conflict.
- Default/custom sentinel and suspended rows are never promoted or counted as an
  active operator; an existing active non-system superadmin prevents bootstrap.
- Retried hooks/elections are idempotent, and interrupted attempts cannot leave a
  completed set of later signups permanently without an active operator.
- The new migration is append-only, idempotent under replay, safe on upgrade, and
  replayable from an empty database with the full chain.
- Existing OAuth, token, device, approval, sentinel, and login self-heal contracts
  remain compatible; public API shapes do not change.
- All mandatory local reviewers finish with `PASS` or `ADDRESSED`; all applicable
  CI checks are terminal green; the sole PR remains open, non-draft, unstaged, and
  unmerged.

## Post-Mortem

### What broke

Two concurrent first signups on an approval-enabled fresh installation can both
receive and persist the deployment's highest role.

### Root cause

Commit `ebe9588224` introduced an empty-table read in a Better Auth before-create
hook and made a later insert depend on that result. The read and inserts are
separate database operations with no shared transaction or compare-and-set gate.

### Timeline

- 2026-02-23: `ebe9588224` introduced signup approval and first-user bootstrap.
- 2026-05-26/2026-06-05: sentinel handling and sole-user self-heal repaired
  sentinel/orphan cases, but kept the create-time read-before-write decision.
- 2026-08-12: backend audit BA-01 identified the concurrent first-signup race.

### Why It Wasn't Caught

Existing tests invoke hooks sequentially with in-memory Drizzle mocks or validate
sole-user self-heal against D1. No test forced two create-before reads to complete
against the same empty real-D1 state before either insert.

### Class of Bug

Read-then-write privilege bootstrap without a database compare-and-set/election,
hidden by sequential mocks.

### Process Fix

This PR will extend the sentinel/first-user rule so any empty-table or first-row
privilege decision requires a durable database election plus a real-D1 concurrent
interleaving regression test.

## References

- `apps/api/src/auth.ts`
- `apps/api/tests/workers/superadmin-self-heal.test.ts`
- `apps/api/src/db/migrations/0062_login_time_superadmin_self_heal.sql`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/40-sentinel-rows-excluded-from-counts.md`
- `tasks/archive/2026-05-26-fix-auto-superadmin-sentinel.md`
- `tasks/archive/2026-06-05-login-time-superadmin-self-heal.md`
- `tasks/archive/2026-07-18-safe-d1-migration-deploy-order.md`
