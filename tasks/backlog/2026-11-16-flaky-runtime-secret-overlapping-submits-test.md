# Flaky test: runtime secret overlapping submits assume call order

## Problem

`apps/api/tests/integration/runtime-secret-requests.test.ts` > "hardening > two overlapping submits by
the same person in the same millisecond: the loser writes nothing" failed on main CI run 43905441847
(head 64a264da, job 133434491210): `expected 409 to be 200` at `first.status`.

The test holds the first `DATABASE.batch()` call and releases it when the second arrives, then
asserts `first.status === 200` and `second.status === 409`. Both `fulfill()` calls start together under
`Promise.all`, and either can reach `batch()` first. When the second call's pre-checks resolve first, it
becomes the winner, so the statuses swap. The test also asserts the stored value is `SENTINEL` (the
first call's value), which is wrong in that ordering. The property under test still holds; the test
hard-codes which call wins.

## Context

Found while monitoring the production deploy of Insights slice F (#2789), which the failure blocked.
The same test passed on the neighbouring main CI runs (3a92e84c, d2e59766), which points to timing
dependence rather than a regression. Failed jobs were rerun.

## Acceptance Criteria

- [ ] The test records which call reached `batch()` first, and asserts that call got 200 and the other
      got 409, the stored value and env value are the winner's, and the loser wrote nothing.
- [ ] Alternatively, the test serializes the two calls' pre-checks so the order is fixed by the test,
      not by scheduling (rule 62, controlled ordering).
- [ ] Run the test 50 times in a loop locally with no failure.
