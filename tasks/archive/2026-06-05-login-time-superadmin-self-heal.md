# Login-Time Superadmin Self-Heal for Sentinel-Orphaned Deployments

## Problem

When a self-hoster forks SAM and deploys to their own Cloudflare account, the
first real human is supposed to be auto-promoted to `superadmin`. That promotion
lives in the BetterAuth `databaseHooks.user.create.before` hook in
`apps/api/src/auth.ts`. Migration `0043_trial_foundation.sql` seeds the
`system_anonymous_trials` sentinel user (`status='system'`) into `users` before
any human signs in.

During a buggy window, the `create.before` first-user lookup counted the sentinel
as an existing user and therefore demoted the genuine first human to
`role='user'` instead of `superadmin`. The `2026-05-26-fix-auto-superadmin-sentinel`
task patched the **create-time** query to exclude the sentinel — but it did
**not** backfill users who were already created during the buggy window.

At least one known real user is in this state: sole human on their deployment,
stuck as `role='user'`, with no access to the admin dashboards (which require
`role='superadmin'` via `requireSuperadmin()`), and no in-product path to fix it
(the role-change endpoint is itself superadmin-gated → chicken-and-egg lockout).

## Goal

Add a **login-time self-heal**: when a human authenticates and they are the only
real (non-internal) user on the deployment AND no superadmin exists, promote them
to `role='superadmin', status='active'`. This recovers orphaned deployments the
next time the affected user logs in, with no manual DB surgery.

## Key Facts Established During Research

- **Admin dashboards require `superadmin`, not `admin`.**
  `apps/api/src/routes/admin.ts` mounts `adminRoutes.use('/*', requireAuth(),
  requireApproved(), requireSuperadmin())`. `requireSuperadmin()`
  (`middleware/auth.ts:151`) rejects anything except `role === 'superadmin'`.
  → The fix MUST assign `superadmin` (and `active`). Assigning `admin` would not
  restore dashboard access.
- **Create-time promotion is gated on `REQUIRE_APPROVAL === 'true'`**
  (`auth.ts:214`). In open-registration mode the create hook returns defaults
  (`role='user', status='active'`) and never promotes anyone. So a victim could
  be stuck regardless of approval mode.
- **The sentinel is identifiable two ways:**
  1. `id === TRIAL_ANONYMOUS_USER_ID` (`'system_anonymous_trials'`), env-overridable
     via `env.TRIAL_ANONYMOUS_USER_ID` (helpers.ts uses `env.X ?? constant`;
     `auth.ts:224` currently uses ONLY the hardcoded constant — inconsistency to
     align).
  2. `status === 'system'` (migration 0043 seeds the sentinel with this status;
     comment: "keeps it out of the 'active' admin list filter"). This is the most
     robust, future-proof discriminator for any internal/system user.
- **Session cookie cache is 5 minutes** (`auth.ts:104-108`,
  `session.cookieCache.maxAge = 5*60`). A role change mid-session is not visible
  to `requireAuth()` until the cache expires (≤5 min) or the user re-authenticates.
- **Existing test harness** (`apps/api/tests/unit/auth.test.ts`) mocks
  `betterAuth` to capture `databaseHooks`, mocks `drizzle`, and invokes
  `databaseHooks.user.create.before` directly with an `installExistingUsersQuery`
  helper. A new session-hook test follows the same pattern.

## Design

This task ships **two complementary mechanisms** that share the same guard set:

1. **A data migration** — an idempotent, guarded `UPDATE` that deterministically
   backfills the one known orphaned victim (and any future deployment in the same
   state) at deploy time. It does not depend on the hook firing or on the victim
   re-authenticating.
2. **A login-time self-heal hook** (`session.create.after`) — fires on **OAuth
   login** (not token-login or device-flow; see "Which login paths fire the hook")
   and re-applies the same guarded promotion. This covers fresh forks going forward
   and any deployment that reaches the orphaned state after this migration runs.

Both run the **same single atomic guarded `UPDATE`** (below). Running both is
belt-and-suspenders, not redundancy: the migration fixes the known victim
immediately and deterministically; the hook keeps the invariant self-healing for
the future without another deploy.

### Atomic, race-free promotion (single SQL statement)

Rather than read-then-write (which has TOCTOU races), encode every guard into the
WHERE clause of one UPDATE so it is atomic in SQLite/D1:

```sql
UPDATE users
SET role = 'superadmin', status = 'active'
WHERE id = :currentUserId
  AND role != 'superadmin'                 -- (a) idempotent: skip if already superadmin
  AND status != 'system'                   -- never promote an internal/system row
  AND status != 'suspended'                -- (d) never auto-elevate a suspended account
  AND (
    SELECT COUNT(*) FROM users u2
    WHERE u2.id != :currentUserId
      AND u2.status != 'system'            -- every OTHER user is internal
      AND u2.id != :sentinelId             -- belt-and-suspenders for env-overridden sentinel
  ) = 0                                     -- (b) current user is the ONLY real user
  AND (
    SELECT COUNT(*) FROM users u3
    WHERE u3.role = 'superadmin'
      AND u3.status != 'system'
  ) = 0;                                    -- (c) no existing superadmin anywhere
```

`:sentinelId = env.TRIAL_ANONYMOUS_USER_ID ?? TRIAL_ANONYMOUS_USER_ID`.

> **Migration variant (no `:currentUserId`).** The data migration cannot bind a
> "current user" — there is no request context. It instead promotes the single real
> user *if and only if* exactly one exists and no superadmin exists. The migration
> SQL drops the `id = :currentUserId` predicate and instead asserts a single
> eligible target. Because `status` is `input:false` (only migrations ever write
> `'system'`), the `status != 'system'` filter reliably excludes every internal row:
>
> ```sql
> UPDATE users
> SET role = 'superadmin', status = 'active'
> WHERE status NOT IN ('system', 'suspended')
>   AND role != 'superadmin'
>   AND (SELECT COUNT(*) FROM users u2 WHERE u2.status != 'system') = 1   -- exactly one real user
>   AND (SELECT COUNT(*) FROM users u3
>        WHERE u3.role = 'superadmin' AND u3.status != 'system') = 0;     -- no superadmin yet
> ```
>
> This is `ALTER`-free and `DROP`-free — it only mutates rows, so it is safe under
> Rule 31 (no table recreation, no CASCADE risk).

### Hook choice and the mandatory try/catch

Add `databaseHooks.session.create.after` in `apps/api/src/auth.ts`. The session
object carries `userId`, which is all the heal needs. The session row does not store
`role`; `role` is read from the `users` table by `getSession` via `additionalFields`,
so updating the `users` row is sufficient — no session mutation required.

**Which login paths fire the hook (important scope limitation).** The hook fires only
on session creation that goes through better-auth's own `auth.handler()` path — i.e.
**OAuth (GitHub) login**. It does NOT fire on:
- **token-login** — `session-factory.ts` calls `internalAdapter.createSession`
  (~line 29) directly, bypassing `databaseHooks.session.create.after`.
- **device-flow** — reaches `internalAdapter.createSession` *transitively* via
  `buildSessionLoginResponse()` → `createSessionCookieForUser()` →
  `internalAdapter.createSession`, so it bypasses `session.create.after` for the same
  underlying reason (the session is created through better-auth's internal adapter,
  not `auth.handler()`). It also runs `assertUserCanCreateSession`, so it shares the
  token-login pending-block behavior.

So the hook self-heals on OAuth login only. The **migration** is the path-independent
backfill for the known victim (and for users who can only reach token-login/device-flow).
This scope limitation must be stated in the docs and PR description rather than claiming
"fires on every login."

### How `env` reaches the hook at runtime

`createAuth(env)` is invoked **per request** (`middleware/auth.ts:41` →
`createAuth(c.env)`), and `databaseHooks` is defined *inside* `createAuth`. The hook
closure therefore captures the request's `env`, giving it `env.DATABASE` and
`env.TRIAL_ANONYMOUS_USER_ID` with no extra plumbing. This is the exact mechanism the
existing `user.create.before` hook already relies on (it reads `env.REQUIRE_APPROVAL`
and `env.DATABASE` the same way), so it is a proven pattern, not a new assumption.

**The try/catch is load-bearing, not precautionary.** In better-auth 1.6.11,
`session.create.after` hooks are *awaited* (the framework drains `pendingHooks`)
before the login response is returned to the client. An uncaught throw from the
hook therefore surfaces as a **500 that breaks login**. The entire heal block MUST
be wrapped in try/catch that swallows and logs the error so login always succeeds
even if the heal write throws.

### Use `prepare().bind().run()`, not Drizzle, for the UPDATE

Drizzle's query builder cannot express a correlated-subquery `UPDATE` like the one
above. The heal MUST be issued via the raw D1 binding:
`env.DATABASE.prepare(sql).bind(...).run()`. Using the raw D1 binding with
`prepare().bind().run()` for a guarded conditional write is an established pattern in
this codebase — see `apps/api/src/services/scheduler-state-sync.ts:57-58` (a
`WHERE ... AND scheduler_state != ?` conditional UPDATE) and
`apps/api/src/services/github-trigger-handler.ts:76-79` (an `INSERT OR IGNORE`
dedupe). NOTE: neither of those uses a *correlated subquery* in its WHERE — there is
no prior correlated-subquery guard in the codebase, so this UPDATE introduces that
shape. That is acceptable: the justification is solely the Drizzle limitation, and
the SQL is plain SQLite. The cited files establish the `prepare().bind().run()`
mechanism, not the subquery shape. A `drizzle(env.DATABASE, { schema })` instance is
only needed if a separate typed read is required; the promotion itself is one
prepared statement.

Guards explained:
- **(a)** never re-write an already-superadmin user (avoids redundant writes / log noise).
- **(b)** the logging-in user is the only non-internal user → orphaned deployment.
- **(c)** no superadmin exists anywhere → we are not stepping on an existing admin.
  (Largely implied by (b) but stated explicitly for defense-in-depth.)
- **(d)** suspended accounts are a deliberate admin action; do not auto-un-suspend
  and elevate them. A deployment whose sole user is suspended must be fixed via DB
  (acceptable edge case — flag for reviewers).
- `status != 'system'` on the target prevents ever mutating the sentinel itself.

Because it is a single statement with all conditions in WHERE, concurrent logins of
the same user are safe (second is a no-op), and there is no read-modify-write window.

### NOT gated on `REQUIRE_APPROVAL` (deliberate, blessed behavior change)

The login self-heal runs regardless of `REQUIRE_APPROVAL`. Rationale:
- The victim may be in open-registration mode, where create-time promotion never
  fires; gating on approval would leave them stuck forever.
- Guards (b)+(c) are strong enough to be safe in both modes: the heal only fires
  when there is exactly one real user and zero superadmins — precisely the
  "brand-new / orphaned deployment" state. Once a second real user or any
  superadmin exists, it can never fire again.

**This is an explicit, intentional behavior change for open registration — blessed
here.** Today, with `REQUIRE_APPROVAL` unset/false, the create hook returns defaults
and **no user is ever auto-promoted to superadmin**. After this change, the *first
and only* real user of an open-registration deployment becomes superadmin on their
first login. That is the desired outcome (a self-hoster's first human should own
their deployment), but it is a real change from current behavior and must be called
out in docs and the PR description.

**Open-registration first-login race caveat.** In open-registration mode there is a
narrow window: if two brand-new users sign in nearly simultaneously on a fresh
deployment before either has a session that ran the heal, the atomic guard (c)
("no superadmin exists") still guarantees **at most one** of them wins the promotion
— the second login's UPDATE finds a superadmin already present and is a no-op. There
is no double-promotion. The only non-determinism is *which* of two simultaneous
first-ever users becomes admin; for the realistic single-operator fork this is a
non-issue. Document this caveat in `self-hosting.md`.

### Deployment-mode matrix

| Mode | First user, fresh deploy | Orphaned (sentinel + 1 real user, no superadmin) | ≥2 real users or any superadmin |
|------|--------------------------|--------------------------------------------------|---------------------------------|
| `REQUIRE_APPROVAL=true` | create hook already sets superadmin → login heal is a no-op (guard a/c) | **login heal promotes** (and migration backfills) | no promotion (guard b/c) |
| open registration | create hook sets defaults; **login heal promotes the sole user** (new behavior) | **login heal promotes** | no promotion (guard b/c) |

### Sentinel-id alignment (small adjacent fix)

`auth.ts:224` (create hook) uses the hardcoded `TRIAL_ANONYMOUS_USER_ID` and
ignores `env.TRIAL_ANONYMOUS_USER_ID`. The new code will resolve the sentinel id
as `env.TRIAL_ANONYMOUS_USER_ID ?? TRIAL_ANONYMOUS_USER_ID`. Consider aligning the
create hook to the same resolution for consistency (low risk; flag for reviewers
whether to bundle or defer). The primary `status != 'system'` filter makes both
robust regardless.

## Alternatives Considered

- **One-off data migration as the ONLY mechanism**: not chosen as the *sole* fix,
  but it IS adopted as one of the two mechanisms (see Design). The earlier draft
  rejected the migration on "riskier blast radius" grounds — that reasoning was
  **wrong** and has been corrected. The migration's `UPDATE` carries the exact same
  guard set as the hook; its blast radius is identical (it can only ever touch the
  single eligible row, and only when no superadmin exists). It is in fact *more*
  deterministic than the hook for the known victim because it does not depend on the
  hook firing or on the victim re-authenticating. We therefore do **both**: the
  migration for the deterministic known-victim backfill, the hook for ongoing
  self-healing of future forks. The user's "check during login" request is satisfied
  by the hook; the migration is the safe, immediate companion.
- **New unauthenticated "claim admin" endpoint**: rejected — adds attack surface;
  login hook needs no new route.
- **Assigning `admin` instead of `superadmin`**: rejected — dashboards require
  `superadmin` (see Key Facts).
- **Adding a `CHECK` constraint on `users.status`** (suggested by the security
  review to harden the `'system'` discriminator): **rejected** under Rule 31. SQLite
  cannot add a `CHECK` constraint via `ALTER`; it requires full table recreation, and
  `users` is a CASCADE parent (sessions, accounts, projects FK to it) — recreating it
  risks wiping every child table. The discriminator does not need a DB constraint to
  be reliable: `status` is an `input:false` additionalField, so the API never lets a
  user set it. Only migrations ever write `'system'`. `status != 'system'` is a sound
  filter in practice without the constraint.

## Edge Cases

1. Only sentinel + current user, current user `role='user'` → **promote**.
2. Sentinel + current user + another real user → **no promotion** (guard b).
3. Current user already `superadmin` → **no-op** (guard a).
4. Another real superadmin already exists → **no promotion** (guard c).
5. Current user `status='suspended'` (sole user) → **no promotion** (guard d).
6. Internal users identified by `status='system'`, not just sentinel id → still
   counted as internal (status filter), so promotion still fires.
7. Env-overridden sentinel id → counted via `:sentinelId` AND `status='system'`.
8. `REQUIRE_APPROVAL` unset/false → **still promotes** (ungated; key assertion).
9. Concurrent double-login of the victim → idempotent, single no-op second write.
10. **Sole real user with `status='pending'` under `REQUIRE_APPROVAL=true`** →
    **promote** (guard d only blocks `suspended`, not `pending`; the heal sets
    `status='active'` alongside `role='superadmin'`). NOTE: such a pending user
    cannot heal via the **token-login OR device-flow** paths — both call
    `internalAdapter.createSession` directly and
    `session-factory.ts:assertUserCanCreateSession` (~lines 105-117) throws 403 for
    a non-active, non-admin user *before* the session (and therefore the
    `session.create.after` hook) is reached. Only the OAuth login path creates the
    session and fires the hook. So the **migration** is the reliable backfill for a
    pending sole user; the hook heals them only on OAuth login. Add explicit tests
    for this subclass covering both the token-login and device-flow bypasses.
11. **Cookie-cache staleness (precise).** `setSessionCookie` writes the cached
    session payload from a user snapshot fetched *before* the `session.create.after`
    hook mutates the row. So the **first** post-heal session caches the *stale*
    `role='user'` for up to `cookieCache.maxAge` (5 min) **by design** — the new
    role becomes visible only after the cache expires (≤5 min) or on the next login.
    This is documented, not worked around. The user described logging out and back
    in, which yields a fresh session that reads the freshly-promoted row immediately.
12. Fresh post-create-fix deployment → create hook already set superadmin; login
    hook is a no-op (guard a or c). No double-promotion.
13. **Two real users where one is `suspended`** (sentinel + current `user` +
    one suspended human) → **no promotion**. Guard (b) counts the suspended human as
    a real (non-`system`) user, so the "only real user" condition fails. This is a
    deliberate no-op: a deployment that once had two humans is not treated as
    orphaned just because one was suspended. Recovery for that rare case is manual
    (DB) — acceptable and documented.

## Implementation Checklist

- [ ] **Rule 05 preflight (external-api-change)**: before writing the hook, verify
      the `session.create.after` callback argument shape and its awaited semantics
      against the installed **better-auth 1.6.11** source (node_modules) or Context7.
      Confirm: (1) the callback receives an object exposing `session.userId`;
      (2) the framework awaits `.after` hooks before returning the login response (the
      basis for the mandatory try/catch). Record the verification in the PR preflight.
- [ ] **Migration**: add an idempotent, row-only data migration as the **next
      sequential D1 migration** after `0043_trial_foundation.sql` in
      `apps/api/src/db/migrations/` (confirm the next free number at implementation
      time, e.g. `0044_*.sql`; do not hardcode here in case other migrations land
      first). No `ALTER`, no `DROP`, no table recreation — run the guarded
      migration-variant `UPDATE` (see Design) to backfill the single eligible real
      user when no superadmin exists. Passes `pnpm quality:migration-safety`
      (mutation-only; the UPDATE carries a WHERE so it is not flagged).
- [ ] Resolve sentinel id as `env.TRIAL_ANONYMOUS_USER_ID ?? TRIAL_ANONYMOUS_USER_ID`
      in `apps/api/src/auth.ts`.
- [ ] Add `databaseHooks.session.create.after` hook performing the atomic guarded
      UPDATE via `env.DATABASE.prepare(sql).bind(...).run()` (NOT Drizzle — correlated
      subqueries; cite `github-trigger-handler.ts:76-79`,
      `services/scheduler-state-sync.ts:57-58`). Wrap the entire block in try/catch + structured
      log on failure — the try/catch is **mandatory/load-bearing** because `.after`
      hooks are awaited before the login response (a throw = 500 = broken login).
- [ ] Use `createModuleLogger('auth')` (`log`) for a structured success log
      (`login_self_heal.promoted`, with `userId`) and failure log.
- [ ] Align the create hook's sentinel resolution to the same env-aware logic (bundle).
- [ ] **Type gap**: extend `UserStatus` in `packages/shared/src/types/user.ts:5` with
      `| 'system'` (the sentinel's real status, currently absent from the union), and
      make the middleware cast at `apps/api/src/middleware/auth.ts:57-58` treat
      `'system'` as an anomaly rather than silently coercing it. Bundle this small fix.
- [ ] Unit tests in `apps/api/tests/unit/auth.test.ts` mirroring the existing
      pattern: add a `session` property to the `BetterAuthOptions` mock, add a mock
      helper for the `prepare().bind().run()` chain, extract `session.create.after`,
      and cover edge cases 1–12 — including the pending-subclass (10) and the
      try/catch-swallows-throw-so-login-survives case.
- [ ] Local Miniflare integration test (Rule 10 capability test) in `tests/workers/`
      that exercises a **real session creation** and asserts the `users` row is
      mutated to `superadmin/active` — proves the hook actually fires, not just that
      the SQL is correct. **Schema/migration application gap**: `tests/workers/` is
      currently EMPTY (no precedent), so this is the first such test. The test must
      apply the schema + migrations into the Miniflare D1 binding before running —
      e.g. read the migration SQL files and `env.DATABASE.exec()` them in
      `beforeAll`/`beforeEach`, or reuse whatever apply-migrations helper the
      integration suite settles on. Document the chosen approach in the test file.
- [ ] Migration test: apply the migration against a Miniflare D1 (same
      schema-application approach as above) seeded with sentinel + 1 real user (no
      superadmin) and assert the real user is promoted; seed sentinel + 2 real users
      and assert no promotion; seed an existing superadmin and assert no promotion;
      seed a suspended sole user and assert no promotion.
- [ ] Docs sync: update
      `apps/www/src/content/docs/docs/guides/self-hosting.md` first-user onboarding
      section to describe BOTH the migration backfill and the login-time self-heal,
      the **OAuth-only** scope of the hook (token-login/device-flow rely on the
      migration), the open-registration behavior change, the first-login race caveat,
      and the **cookie-cache staleness** note (after the hook promotes mid-session,
      the new role is visible only after ≤5 min cache expiry or a fresh login — so the
      advised recovery is log out / log back in).
- [ ] Constitution check: no hardcoded values — sentinel id env-overridable,
      role/status strings are domain constants (acceptable).

## Acceptance Criteria

- The data migration promotes the single eligible real user to
  `role='superadmin', status='active'` at deploy time when exactly one real user
  exists and no superadmin exists; it is a no-op in every other state.
- A deployment containing only the sentinel plus exactly one non-superadmin human
  promotes that human to `role='superadmin', status='active'` on their next OAuth
  login (the hook), independent of the migration.
- A sole real user with `status='pending'` (REQUIRE_APPROVAL=true) is promoted by the
  migration and by OAuth login; the token-login limitation is documented.
- A deployment with the sentinel + ≥2 real users, or any existing superadmin, does
  NOT promote anyone on login or in the migration (no regression for
  multi-user/managed deployments).
- A suspended sole user is NOT auto-promoted by either mechanism.
- Promotion is idempotent and race-safe (single atomic statement); concurrent
  first-ever logins yield at most one superadmin (no double-promotion).
- Promotion fires regardless of `REQUIRE_APPROVAL` (blessed open-reg behavior change).
- Login never fails even if the self-heal write throws (try/catch verified by test).
- Unit + migration + Miniflare integration tests cover every edge case above; docs
  updated in the same PR.

## Staging Verification Plan (and its limitation)

- **Positive path is hard to trigger on staging** because staging already has real
  superadmins (guards b/c correctly block promotion) and the CF token is read-only
  for D1, so we cannot synthesize the "sole real user" state there. The positive path
  is proven by the local Miniflare integration test (hook) and the migration test.
- Verify the **negative/no-regression** path on staging: existing multi-user state
  promotes no one; admin/normal logins behave unchanged; no new console/API errors;
  the migration ran without error and changed zero rows (verify via CF API D1 query
  of `d1_migrations` and an unchanged superadmin count).
- Rely on unit + local Miniflare integration tests for the positive path, and
  document this split honestly in the PR per Rule 10 (integration verification gap).

## References

- `apps/api/src/auth.ts` (create hook + new session hook)
- `apps/api/src/middleware/auth.ts` (`requireSuperadmin`, `requireApproved`)
- `apps/api/src/routes/admin.ts` (superadmin-gated dashboards)
- `apps/api/src/services/session-factory.ts` (`internalAdapter.createSession` ~line 29
  bypasses the `session.create.after` hook for token-login AND device-flow;
  `assertUserCanCreateSession` ~105-117 403s a pending user before the hook fires)
- `packages/shared/src/types/user.ts:5` (`UserStatus` union missing `'system'` — type gap)
- `apps/api/src/middleware/auth.ts:57-58` (cast that coerces unknown status to `'active'`)
- `apps/api/src/services/github-trigger-handler.ts:76-79` (guarded `prepare().bind().run()` pattern)
- `apps/api/src/services/scheduler-state-sync.ts:57-58` (guarded conditional UPDATE pattern)
- `apps/api/src/db/migrations/0043_trial_foundation.sql` (sentinel seed, `status='system'`)
- `apps/api/src/db/schema.ts:63-81` (users table — `status` is plain text, no CHECK
  constraint). NOTE: the sentinel-excluding unique indexes live on the `projects`
  table (~`schema.ts:328-350`), not on `users`.
- `packages/shared/src/trial.ts` (`TRIAL_ANONYMOUS_USER_ID`)
- `apps/api/tests/unit/auth.test.ts` (hook test harness)
- `.claude/rules/31-migration-safety.md` (why the CHECK-constraint recommendation is rejected)
- `tasks/archive/2026-05-26-fix-auto-superadmin-sentinel.md` (prior create-time fix)
