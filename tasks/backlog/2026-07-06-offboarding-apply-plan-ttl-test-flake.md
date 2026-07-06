# Offboarding apply tests flake on `expired_plan` (plan TTL vs slow CI)

## Problem
`apps/api/tests/unit/routes/project-members-offboarding-apply.test.ts` fails intermittently in the CI `Test` job with `{"error":"expired_plan","message":"Offboarding plan has expired; preview again"}` — the apply step returns **409 expired_plan** where the test expects **200** (and one case expects `stale_plan` but gets `expired_plan`).

Observed failing on `main` (commit `616666575`, CI run at 2026-07-06T09:45Z) and on unrelated PR #1520 — i.e. it is a **pre-existing flake blocking merges**, not caused by either change.

## Context / likely root cause
Offboarding is preview→apply with a plan that carries a TTL. The tests preview a plan then apply it; on a slow CI runner the wall-clock between preview and apply exceeds the plan's expiry window, so apply rejects with `expired_plan` before the assertions run. Introduced with the offboarding apply work (PRs #1510/#1513/#1515/#1518, July 5).

## Acceptance criteria
- [ ] Identify the plan-TTL source used by the apply route and the test's timing assumption.
- [ ] Make the tests deterministic: inject/mccck the clock or the plan `expiresAt`, or set the TTL via an env override in the test setup, so wall-clock CI speed cannot expire the plan mid-test.
- [ ] Do NOT simply widen the real TTL to paper over the flake — fix the test's time control.
- [ ] Re-run the `Test` job several times to confirm the flake is gone.
- [ ] Add a regression note: the `stale_plan` vs `expired_plan` case must assert the intended branch deterministically.

## References
- Failing file: `apps/api/tests/unit/routes/project-members-offboarding-apply.test.ts`
- Discovered during PR #1520 (agent-agnostic tool-card recognition) CI — unrelated change.
