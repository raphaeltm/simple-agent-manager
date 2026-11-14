# Archive sharding lifecycle timeout

Idea: 01M7C75DDYYXGHDW5WW7X1M8WY. CI 43557011927, job 132332133650 at cf88e034.

## Problem and research
The 1,205-row lifecycle case intermittently exceeds Vitest's five-second limit. Preserve three real pages and prepare/copy/seal/finalize/reclaim coverage. Initial local instrumented measurement: migrations 398 ms, fixture 214 ms, prepare 24 ms, copy 378 ms, seal 1,261 ms, finalize 31 ms, reclaim 268 ms (2,622 ms test). No real timer waits in this path; asynchronous digest calls can yield to runner contention. Search projection equivalence lookups appear to scan the session for every grouped row (session index lacks document_id); benchmark and query-plan evidence required. Source fixture lacks FTS entries, producing 1,205 caught delete-marker failures.

## Implementation and acceptance
- [ ] Measure SQL plan and scaling at 300/1,200/4,800 rows and outer-limit throughput; fix confirmed production complexity.
- [ ] Populate source FTS realistically; preserve 1,205-row fixtures and all lifecycle/page assertions.
- [ ] Add deterministic query-plan/scaling regression coverage if production complexity confirmed.
- [ ] Remove the bound/index once, demonstrate intended red test, restore and pass.
- [ ] Run complete sharding file at least 30 times normally and 30 under bounded CPU load; report counts and timing distributions.
- [ ] Relevant lint/typecheck/tests/build and migration safety checks; specialist and task-completion reviews.
- [ ] Production change requires coordinator-granted staging slot; test-only skips staging explicitly.
- [ ] Draft PR, needs-human-review, green CI, CodeRabbit request/wait, exact-SHA coordinator handoff. No merge before approval of that SHA.
- [ ] After approval, merge with --match-head-commit and monitor main CI / Deploy Production before completing SAM task.

## References
Rules 31 (migration safety), 62 (real trigger), 81 (work-bound throughput); /do workflow. Related worker resumable-cursor test must remain untouched. Use supplied SAM output branch/workspace; task record stays on this branch to preserve the coordinated main merge hold.
