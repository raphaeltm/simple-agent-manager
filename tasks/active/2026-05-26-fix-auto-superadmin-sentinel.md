# Fix Auto-Superadmin Sentinel Handling

## Problem

The BetterAuth `user.create.before` hook checks for any existing row in `users` before auto-promoting the first account to `superadmin`. Migration `0043_trial_foundation.sql` seeds the `system_anonymous_trials` sentinel user before any human signs in, so self-hosted deployments with approval enabled never get an auto-promoted first real user.

## Research Findings

- `apps/api/src/auth.ts` performs the first-user lookup in the BetterAuth `databaseHooks.user.create.before` hook.
- `apps/api/src/db/migrations/0043_trial_foundation.sql` seeds `system_anonymous_trials` into `users`.
- `packages/shared/src/trial.ts` exports `TRIAL_ANONYMOUS_USER_ID`, matching the migration seed.
- `apps/api/tests/unit/auth.test.ts` already captures BetterAuth config options and can exercise the hook directly with mocked `drizzle`.
- `docs/guides/self-hosting.md` already states the first GitHub OAuth user is assigned `superadmin` and explains approval mode.

## Implementation Checklist

- [ ] Import `ne` and `TRIAL_ANONYMOUS_USER_ID` in `apps/api/src/auth.ts`.
- [ ] Exclude the sentinel user from the first-real-user query.
- [ ] Add a unit test proving sentinel-only databases still promote the new user to `superadmin` and `active`.
- [ ] Add a unit test proving sentinel plus a real user produces `user` and `pending`.
- [ ] Verify the self-hosting guide needs no doc update or update it if stale.
- [ ] Run targeted and relevant validation.

## Acceptance Criteria

- With `REQUIRE_APPROVAL=true`, a database containing only `system_anonymous_trials` treats the next created user as the first real user.
- With `REQUIRE_APPROVAL=true`, a database containing the sentinel and at least one real user treats the next created user as pending approval.
- Existing auth tests continue to pass.
- Self-hosting documentation accurately describes the first-user onboarding path.

## References

- `apps/api/src/auth.ts`
- `apps/api/src/db/migrations/0043_trial_foundation.sql`
- `packages/shared/src/trial.ts`
- `docs/guides/self-hosting.md`
