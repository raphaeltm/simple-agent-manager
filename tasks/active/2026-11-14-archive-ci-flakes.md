# Archive compatibility and lifecycle ordering CI flakes

Coordinator follow-up to PR #2724. Ideas: `01M7CTAXZ79SAZCR2DSDMVCF7D`, `01M7CTZ4WGSP6VS4CKGDSAVSFZ`.

## Problem and evidence

CI 43585844985 / Test job 132420078266 timed out after 30 seconds in the compact archive compatibility case with 100 rows and 200 KiB metadata per row. The fixture exercises about 20 MiB of metadata and repeated real compression, hashing, paging, recovery and seal validation. An initial isolated normal run took 2612 ms for this case. Profile phases under contention before choosing a fix; preserve the large object and default-size recovery triggers.

Main CI 43585850934 / DO shard job 132420098695 failed the warm handoff decision test at line 169: both expected decisions existed, in the opposite order. The listing already orders by created_at and id; IDs have a random ULID suffix within a millisecond, so that order need not equal causal insertion order. Verify consumer expectations and control the tied-clock condition in the test.

The Test job runs Turbo test:coverage, which launches package test processes whose Vitest workers introduce another layer of parallelism. Measure runner resources and overlap before proposing a bounded concurrency change.

## Checklist

- [x] Profile compact compatibility phases normally, with coverage, and under CPU contention.
- [x] Assess Test-job process/worker overcommit using actual CI logs/configuration and measured local evidence.
- [x] Fix production inefficiency if found, otherwise fix the demonstrated testing/runner issue with measured justification.
- [x] Preserve 100-row, 200 KiB metadata, multi-object, real seal/read/recovery assertions.
- [x] Determine decision ordering contract; exercise equal timestamps through the real warm handoff.
- [x] Remove a relevant guard once and prove the intended tests fail, then restore it.
- [x] At least 30 normal and 30 CPU-loaded full-file runs for each affected test file; report counts and timings, without hidden retries.
- [x] Run relevant lint, typecheck, build and broader tests.
- [ ] Local specialist and task-completion reviews; address findings.
- [ ] Test/config only: skip staging and state that in PR; production archive changes: request coordinator staging slot.
- [ ] Push each unit; create separate DRAFT PR with needs-human-review; CI plus trusted CodeRabbit request and wait.
- [ ] Send PR URL, full SHA and gate summary to coordinator; STOP until approval of that exact SHA.

## Release constraints

No direct implementation changes on main. Local commands foreground and under about ten minutes. Do not touch the separately fixed resumable-cursor test. Preserve the independent PR #2724 production watch: start 2026-11-14 11:59:39 UTC, end 2026-11-15 11:59:39 UTC. Its hourly chain and final guard are tracked in the idea and local .do-state.md. Alert coordinator immediately on observed new identity mismatch or rising failed/poisoned archive journals. Do not complete the original task before that watch ends.

## References

- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/25-review-merge-gate.md`
- `.github/workflows/ci.yml` Test job
- `packages/project-data/tests/unit/project-data-compact-archive.test.ts`
- `apps/api/tests/workers/node-lifecycle-decisions.test.ts`
- `packages/worker-core/src/ulid.ts`

## Initial measured diagnosis

Normal phase total 2605 ms; coverage plus two busy workers on the same two cores 5737 ms. Controlled oversubscription with eighteen busy workers on two cores reproduced the original 30-second timeout. Copy cost rose from 933 ms to 10629 ms. This models contention rather than asserting an exact historical CI process count. All fixture/timeout values remain unchanged. Proposed fix serializes Turbo package coverage tasks, leaving Vitest file parallelism intact. Initial measurements are committed in tasks/evidence/2026-11-14-archive-ci-flakes. Final stability and CI duration validation remain pending.

## Current validation

Compact file: all 30 normal + 30 loaded runs passed, 780 cases. Full ProjectData package: 528 passed. API build and dependency builds passed (12 tasks), both affected package typechecks passed after rebuild, targeted ESLint/formatting passed. Lifecycle real workerd file passed 9/9 with Date-only freezing and both persisted timestamps asserted equal. Emission mutation repeated under that final timing model failed as intended and was restored; Lifecycle 30 normal+30 loaded repetitions passed 540 cases. Local preliminary test and Cloudflare reviews found no remaining semantic finding; final completion review still pending.

Coordinator requires actual CI wall-clock measurements for serial package concurrency versus a middle budget before accepting the final setting. Historical Test jobs took 32:00, 24:00, and 20:44. Prefer the fastest stable option, and a bounded middle option if serialization adds more than about five minutes unless that option flakes. Evidence is in ci-budget-comparison.json; no new CI budget measurement is claimed yet.

## Final CI budget selection

Measured four-CPU runner: serial job32:55/coverage30:41.896; bounded middle job25:27/coverage23:37.382, all technical jobs passed. Select Turbo concurrency2 plus Vitest maxWorkers75%, saving7:28 against serial and staying within4:43 of fastest historical Test job. Main advanced between the two PR merge refs (seven extra API tests in middle); evidence discloses this and runner variability. Final current-head CI/review and coordinator exact-SHA approval remain pending.
