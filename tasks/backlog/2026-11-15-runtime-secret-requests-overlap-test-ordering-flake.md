# Flaky: runtime-secret-requests "two overlapping submits" assumes call order equals batch order

## Problem

`apps/api/tests/integration/runtime-secret-requests.test.ts` > hardening > "two overlapping submits
by the same person in the same millisecond: the loser writes nothing" failed once in CI
(run 43710511927, job Test, 2026-11-15, branch `sam/task-h1-self-host-7c5dke` on
`sam/selfhost-pass-2`): `expected 409 to be 200` at the `first.status` assertion.

The test holds the first D1 `batch` call and releases it when the second arrives, then asserts
that the request started first by `Promise.all` (`first`) wins. But the batch counter is keyed on
arrival at `env.DATABASE.batch`, not on which `fulfill()` call made it. Under CI load the second
`fulfill()` can reach its batch first, become "batch 1", win, and leave the first call with the
409. The production behaviour (exactly one winner, the loser writes nothing) still holds; only the
test's labelling of the winner is wrong.

## Context

Found while running CI for task H1 (hosted git in the self-host build only). The test and the
secret-request service are untouched by that change; the test passed 3/3 locally and in the local
full API run (1,091 files).

## Acceptance Criteria

- [ ] The test asserts "exactly one 200 and one 409, and the stored value is the winner's",
      identifying the winner by which call's batch ran first, not by `Promise.all` position
- [ ] Still discriminating: with the pre-fix INSERT (keyed on resolved_by + resolved_at) the
      loser's value overwrites the winner's and the test fails
- [ ] Repeated runs (for example 50 with `--repeat`) pass under parallel load
