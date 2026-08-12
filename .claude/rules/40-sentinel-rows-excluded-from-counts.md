# Internal/Sentinel Rows Must Be Excluded From Business-Logic Counts

## The Problem

The `users` table (and others) contains internal **sentinel rows** that are not real humans — most notably `system_anonymous_trials` (`status='system'`, seeded by migration 0043). Any business-logic check that counts rows to make a decision MUST exclude these sentinel rows. Counting them produces off-by-one logic that silently breaks the feature.

## Incident That Created This Rule

The first-user-superadmin promotion in `apps/api/src/auth.ts` (`user.create.before` hook) counted _all_ existing user rows to decide "is this the first human?". On a freshly forked deployment the `system_anonymous_trials` sentinel already existed, so the genuine first human was counted as the _second_ user, created as `role='user'` instead of `role='superadmin'`, and locked out of every superadmin-gated admin surface — with no in-product recovery (the role-change endpoint is itself superadmin-gated). The fix (idea `01KTBCWSTJ83YM280YP7MTE967`) was a login-time + migration self-heal whose every guard had to re-derive the `status != 'system'` exclusion the original count omitted.

## Rule

When writing any query or in-memory check whose result depends on **how many** rows exist (or whether _any_ real row exists) in a table that can hold internal/sentinel rows:

1. **Exclude sentinel rows in the WHERE clause**, e.g. `WHERE status != 'system'`. Do NOT count first and subtract — exclude at the source so the count is correct by construction.
2. **`status` (and similar discriminators) are `input:false` additionalFields** — only migrations ever write `'system'`, so the filter is reliable without a CHECK constraint.
3. **Never treat "a row exists" as "a human exists."** "First user", "single operator", "no users yet", and "only one account" checks all require the sentinel exclusion.
4. **Make the sentinel id env-overridable** where it is referenced directly (`env.TRIAL_ANONYMOUS_USER_ID ?? TRIAL_ANONYMOUS_USER_ID`) — do not hardcode it (Constitution Principle XI).

## Concurrent First-Row Privilege Decisions

Never grant a privileged first-row role from an application-level existence read
followed by a later insert. Concurrent requests can all observe the same empty
state. Put the election in the durable database write that makes the identity
usable, and keep later candidates non-privileged without surfacing expected
uniqueness failures.

The regression test must use real D1/Miniflare and force the vulnerable
interleaving: all candidates complete their pre-create work before any candidate
commits the election write. It must also cover interruption before the usable
identity is committed and verify the value returned to the auth layer matches the
persisted role after any trigger or database-side election.

## Quick Compliance Check

Before committing count-based or existence-based logic over `users` (or any sentinel-bearing table):

- [ ] Every `COUNT(*)` / existence check excludes `status = 'system'` (or the relevant sentinel discriminator) in its WHERE clause
- [ ] "First user" / "single operator" / "no real users" decisions exclude sentinel rows
- [ ] The sentinel id is referenced via a shared constant (env-overridable), not hardcoded inline
- [ ] A test asserts the check returns the correct result when a sentinel row co-exists with real rows
- [ ] First-row privilege bootstrap uses a database-backed election, not read-then-insert logic
- [ ] Real-D1 tests force concurrent pre-create interleaving and interrupted-attempt recovery
