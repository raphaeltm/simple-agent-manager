# Archive sharding lifecycle timeout

Idea: 01M7C75DDYYXGHDW5WW7X1M8WY. CI 43557011927, job 132332133650 at cf88e034.

## Problem and research
The 1,205-row lifecycle case intermittently exceeds Vitest's five-second limit. Preserve three real pages and prepare/copy/seal/finalize/reclaim coverage. Initial local instrumented measurement: migrations 398 ms, fixture 214 ms, prepare 24 ms, copy 378 ms, seal 1,261 ms, finalize 31 ms, reclaim 268 ms (2,622 ms test). No real timer waits in this path; asynchronous digest calls can yield to runner contention. Search projection equivalence lookups appear to scan the session for every grouped row (session index lacks document_id); benchmark and query-plan evidence required. Source fixture lacks FTS entries, producing 1,205 caught delete-marker failures.

## Implementation and acceptance
- [x] Measure SQL plan and scaling at 300/1,200/4,800 rows and outer-limit throughput; fix confirmed production complexity.
- [x] Populate source FTS realistically; preserve 1,205-row fixtures and all lifecycle/page assertions.
- [x] Add deterministic query-plan/scaling regression coverage if production complexity confirmed.
- [x] Remove the bound/index once, demonstrate intended red test, restore and pass.
- [x] Run complete sharding file at least 30 times normally and 30 under bounded CPU load; report counts and timing distributions.
- [ ] Relevant lint/typecheck/tests/build and migration safety checks; specialist and task-completion reviews.
- [ ] Production change requires coordinator-granted staging slot; test-only skips staging explicitly.
- [ ] Draft PR, needs-human-review, green CI, CodeRabbit request/wait, exact-SHA coordinator handoff. No merge before approval of that SHA.
- [ ] After approval, merge with --match-head-commit and monitor main CI / Deploy Production before completing SAM task.

## References
Rules 31 (migration safety), 62 (real trigger), 81 (work-bound throughput); /do workflow. Related worker resumable-cursor test must remain untouched. Use supplied SAM output branch/workspace; task record stays on this branch to preserve the coordinated main merge hold.

## Final implementation
Three equivalence paths now share a unique `projection_id` seek over the deterministic raw/grouped keys. All writers, including the introducing commit f5ff1e662 (#2133), use these keys. No schema, configuration, index storage, or startup migration changes remain. A per-row identity check in the existing paged projection verifier rejects internally consistent noncanonical legacy/corrupt identities; tests drive real seal validation then prove source flip/reclaim remain refused.

Local lookup-only benchmark (n lookups, 2n documents): old session scan 300/1200/4800/19200 checks took 40.6/662.9/11663.7/222662.1 ms; unique-key seek took 2.80/10.64/26.80/160.20 ms. At the 38,400-document outer probe this is ~120k checks/s, or 0.160 s for 19,200 checks; no retry schedule or count bound changed. These are local SQLite query costs, not production lifecycle latency. Three-size tests assert the actual plan, without timing thresholds. Existing production evidence in archive-drain task records 100k max messages/session; future scaling follows seeks rather than session-length scans.

Targeted implementation tests: 6/6 pass (three scales, two noncanonical identity safety controls, full multi-page lifecycle at 1.93 s). Earlier 10/10 normal file runs belonged to a superseded implementation and will not count toward final 30+30.

## Measured per-case timeout allowance
After the production query fix, the original 5s timeout passed 10/10 normal file runs (target1.76–2.29s) and 3 loaded runs (3.72/4.51/4.50s), then failed loaded run4 at5.388s. A full-file phase profile with a busy worker sharing the same pinned CPU completed the unchanged lifecycle in5.218s: migrations1001ms, seed+FTS406ms, prepare101ms, copy1004ms, seal1989ms, finalize180ms, reclaim537ms. No real timer sleeps; this is legitimate fixture creation, SQL/FTS work and async digest scheduling under CPU contention. Only this test now gets10s (roughly2x measured loaded work); guards and fixture unchanged. Final30+30 repetitions restart after this adjustment; prior failures remain evidence.

## Final stability and discrimination evidence

Candidate source:90994fa7a; frozen source SHA256 and all per-run data at `tasks/evidence/2026-11-14-archive-sharding-timeout/results.json`.

| Mode | Full file runs | Passed cases | Target median | Target max |
|---|---:|---:|---:|---:|
| Normal |30/30|1410/1410|1.924s|2.369s|
| CPU load |30/30|1410/1410|4.123s|5.722s|

Every run is a fresh Vitest CLI process with47cases; five-run bounded batches, up to3independent batches at once. Loaded batches pin Vitest and one busy worker to the same CPU on distinct cores. Each worker was alive and consumed positive measured CPU time for every run. No test retries. Max command42.84s normal,105.0s loaded; batch bounds below10minutes.

All three mutations repeated after the10s adjustment: removing unique seek fails the real seal query-plan assertion; relaxing the real grouped page bound fails1205<=500; removing identity guard makes both noncanonical seal controls unexpectedly resolve. Restored all before final60file runs. Project-data528/528tests and real-workerd archive16/16tests passed; affected lint/typecheck/build and DO migration safety passed. Source/query changes were locally reviewed by test-engineer and Cloudflare specialist; timeout evidence received a further test-engineer PASS. Remaining release gates stay open below the mandatory coordinator hold; task remains active until approved merge and main/deploy monitoring finish.
