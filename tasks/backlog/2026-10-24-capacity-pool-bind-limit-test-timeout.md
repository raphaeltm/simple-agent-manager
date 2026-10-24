# The D1 bind-limit capacity-pool test times out under full-suite load

## Problem

`apps/api/tests/unit/routes/project-capacity-pools.test.ts:803`, "chunks catalog addition source
reads below the D1 bind limit", fails with `Test timed out in 15000ms` when the whole suite runs
with coverage on a CI runner. It passes in 4.4s when its file is run alone.

It failed main CI run
[40073253970](https://github.com/raphaeltm/simple-agent-manager/actions/runs/40073253970) on
`35f14a954` (the T4 linked-work merge), which blocks Deploy Production for whatever is on main at
the time — in that run it was the only failure out of 948 files, 946 passed, 1 skipped. A re-run
of the failed job passed.

The test is genuinely heavy: it seeds 99 cloud credentials, then drives two full app requests
(`POST .../capacity-pools/defaults/reconcile` and `PATCH .../capacity-pools/defaults`) through a
real in-memory SQLite D1. Its own 15s timeout is already an override of the default, which says
someone has met this before and raised the number rather than addressed the cost.

## Why this is worth fixing rather than re-running

A timeout flake on `main` is not a test problem, it is a release problem: it stops the production
deploy and the next agent has to decide, under time pressure, whether a red main is their fault.
That decision costs more than the fix. Raising the timeout again just moves the threshold.

## Context

Found by T4 (linked-work) while watching the post-merge production deploy for PR #2431. T4's diff
contains zero `apps/api` files and the identical API tree passed the same job on the PR head
(run 40070088890), so the failure was unrelated to that change; it was re-run once and passed,
per `.claude/rules/25`'s treatment of an unrelated CI failure.

A near-identical timeout was seen the same day in
`apps/api/tests/unit/.../session-snapshot-recovery-attempt-id-migration.test.ts` during a local
full-suite run (5000ms timeout, passes in 1.65s alone), so this is likely a class rather than one
test. `tasks/archive/2026-10-22-automation-attention-card-test-flake.md` is the previous instance.

## Acceptance criteria

- [ ] The bind-limit behaviour is still proven — the point of the test is that the catalog
      addition source read is chunked below the D1 bind limit, and that must not be weakened to
      make it fast.
- [ ] The test no longer depends on wall-clock headroom: either the 99-credential fixture is
      built once and shared, the two full app requests are reduced to the one that exercises the
      chunking, or the chunking is asserted at the function that does it rather than through two
      HTTP round trips.
- [ ] No timeout override is needed; it passes at the suite default.
- [ ] Measured before and after, with the suite running under coverage, and both numbers recorded.
- [ ] Check the sibling case: run the API suite with coverage and list any other test within 2x of
      its timeout, so this is fixed as a class rather than one symptom.
