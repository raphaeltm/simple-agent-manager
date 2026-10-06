-- Login-time superadmin self-heal: deterministic backfill for sentinel-orphaned
-- deployments (idea 01KTBCWSTJ83YM280YP7MTE967).
--
-- BACKGROUND: During a buggy window, the BetterAuth `user.create.before` first-user
-- promotion counted the `system_anonymous_trials` sentinel (seeded by migration
-- 0043 with status='system') as an existing user, so the genuine first human on a
-- fresh fork was created as role='user' instead of role='superadmin'. Such a user
-- has no access to the superadmin-gated admin dashboards and no in-product path to
-- self-promote (the role-change endpoint is itself superadmin-gated).
--
-- THIS MIGRATION is the path-independent companion to the login-time
-- `session.create.after` self-heal hook in apps/api/src/auth.ts. The hook fires
-- on every session creation (OAuth, token-login, and device-flow all route
-- through internalAdapter.createSession -> createWithHooks). This migration is the
-- deploy-time guarantee: it backfills the single known-orphaned victim when
-- migrations run, so recovery does not depend on that victim ever signing in again.
--
-- SAFETY (Rule 31): row-only UPDATE. No ALTER, no DROP, no table recreation, so
-- there is zero CASCADE risk to the child tables that FK `users`. The WHERE clause
-- carries every guard, so the statement is a no-op in every state except the exact
-- "one real user, no superadmin" orphaned case:
--   * status NOT IN ('system','suspended') — never touch an internal row, never
--     auto-elevate a deliberately suspended account.
--   * role != 'superadmin'                  — idempotent; skip already-promoted rows.
--   * exactly one non-system user exists     — the deployment is single-operator.
--   * no non-system superadmin exists        — we are not stepping on an existing admin.
-- NOTE on suspended users: the "exactly one non-system user" guard (u2.status !=
-- 'system') COUNTS a suspended user, but the row-level `status NOT IN
-- ('system','suspended')` filter excludes it from the SET. So a deployment whose
-- sole non-system user is suspended is a deliberate no-op — the suspended user is
-- counted (the deployment is single-operator) yet never promoted.
-- `status` is an input:false additionalField, so only migrations ever write
-- 'system'; the status filter reliably excludes the sentinel without a CHECK
-- constraint (which SQLite cannot add via ALTER on a CASCADE parent).
UPDATE users
SET role = 'superadmin', status = 'active'
WHERE status NOT IN ('system', 'suspended')
  AND role != 'superadmin'
  AND (SELECT COUNT(*) FROM users u2 WHERE u2.status != 'system') = 1
  AND (SELECT COUNT(*) FROM users u3
       WHERE u3.role = 'superadmin' AND u3.status != 'system') = 0;
