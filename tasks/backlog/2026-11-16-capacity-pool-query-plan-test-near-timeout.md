# capacity-pool-edit-query-plan test runs at the 5 s default timeout

## Problem

`apps/api/tests/unit/services/capacity-pool-edit-query-plan.test.ts` ("pool edit on a large pool >
updates the edited rows and their mirrors, looking every row up by id") timed out on CI
(5,450 ms against the 5,000 ms default) on PR #2780's rebased head, run 43838791321, job 133203179677.
Locally its two cases take 4.6–4.9 s together, so a loaded runner tips it over.

## Context

Found during inbox slice G CI. The test seeds a production-sized pool on purpose (rule 69, D1 CPU
ceiling), so the cost is intrinsic; the timeout is not.

## Acceptance Criteria

- [ ] The test sets an explicit timeout sized for its fixture, or the fixture setup is made cheaper without shrinking the row count below the production shape it guards
- [ ] Ten consecutive local runs and one CI run pass
