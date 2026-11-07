# Bounded automatic session sleep

Idea: 01M6NMM98RR33E416Y8R3NEKFB. Task: 01M6SKF9FW07HY9J4AV0B6W5MF.

## Problem and research
Repeated idle reports advance activity_at, postponing unattended sleep forever despite unchanged work_at. The existing harness progress ceiling is configurable but defaults to 30 minutes; requested policy is two hours. The absolute task ceiling terminalizes allocated conversations instead of first attempting sleep. Existing real-D1 sleep fixture and real ProjectData state producer can exercise the whole path.

## Checklist and acceptance
- [x] Use sessionWorkAnchor for unattended idle scheduling; decline missing anchors.
- [x] Resolve background keep-alive default as two hours with existing env override; document policy.
- [x] Drive real reports through ProjectData and real sleep sweep; prove idle deadline, recent progress, expiry, missing anchor and override/default controls.
- [x] Revert each changed guard/default once and record discriminating failures.
- [x] Prefer bounded conversation sleep at task absolute ceiling, preserving terminal fallback for failed sleep.
- [x] Run quality checks and specialist reviews.
- [ ] Estimate bounded VM staging cost; coordinate staging, verify real background process sleep, clean up.
- [ ] PR, CI, CodeRabbit wait, merge and production health/deploy evidence; update idea.

## Workflow
Use SAM-provided output branch and current workspace; preserve unrelated .codex/config.toml. Task file rides feature PR because main is protected (existing project knowledge). No additional worktree needed for already isolated SAM task checkout.

## Review evidence (2026-11-07)
Final read-only local reviewers `final_runtime_review` (Cloudflare, constitution, environment, documentation) and `final_test_review` (test engineer, task completion) found no remaining code/test blockers. Earlier findings addressed: background protection includes foreground work and handles missing progress; real recovery entry and null task chat link covered; queue failure and task-mode/immutable grace controls added. Completion validator correctly leaves runtime/release evidence pending.

## Validation and staging plan
Recovered focused suite: 3 files / 82 tests PASS. Root typecheck: 19 tasks PASS. Guard mutation runs are underway and are restored in a finally block; results will be retained here. Previous workspace stop lost uncommitted /tmp broad-check logs, so no broad PASS is inferred.
Staging owners explicitly released; provider-limit task 01M6SKEXDWXRZJ7ZXDS8SNMZFP follows this slot. Cost estimate from live staging catalog: cx23 fsn1 2 vCPU/4 GB, €0.0088/hour; 30 minutes ≈ €0.0044 VM cost. Use one VM and existing Claude conversation profile, temporary 180000ms background/60000ms idle staging overrides, then restore both absent variables and delete own resources. Default two-hour behavior is exercised through the actual resolver in deterministic tests.

## Bounds
With no further work, normal automatic sleep is eligible at work_at + 15 minutes, or (while background work remains leased) last real work + 2 hours; a five-minute sweep adds at most one normal tick for an uncontended candidate. A 60-second report changes neither deadline. At 24 hours of allocated runtime, conversation sleep gets the existing one-hour grace measured from immutable runtime generation age; repeat queue/claim timestamps cannot extend it. Candidate selection/batch volumes are unchanged; the ceiling branch adds indexed D1 sleep queue operations only, without remote runtime probes.

## Final guard discrimination
Every mutation below produced a failing behavioral test; fixed sources restored afterwards.

| Mutation | Red tests |
| --- | --- |
| report-clock | sleeps after the work idle interval despite a report every 60 seconds; keeps recent background progress awake until the resolved bound (undefined), then sleeps; keeps recent background progress awake until the resolved bound (1800000), then sleeps; bounds legacy background reports that omit a progress timestamp; renews background protection on a new real turn, independently of harness progress; preserves a conversation at the absolute ceiling (task chat link chat-1) by queueing and completing sleep; preserves a conversation at the absolute ceiling (task chat link null) by queueing and completing sleep |
| old-default | keeps recent background progress awake until the resolved bound (undefined), then sleeps; bounds legacy background reports that omit a progress timestamp; renews background protection on a new real turn, independently of harness progress |
| lease-guard-deleted | keeps recent background progress awake until the resolved bound (undefined), then sleeps; keeps recent background progress awake until the resolved bound (1800000), then sleeps; bounds legacy background reports that omit a progress timestamp; renews background protection on a new real turn, independently of harness progress |
| progress-only-heartbeat-fallback | bounds legacy background reports that omit a progress timestamp; renews background protection on a new real turn, independently of harness progress |
| missing-anchor-guard-deleted | declines unattended sleep without an anchor |
| ceiling-queue-disabled | preserves a conversation at the absolute ceiling (task chat link chat-1) by queueing and completing sleep; preserves a conversation at the absolute ceiling (task chat link null) by queueing and completing sleep; does not renew the ceiling grace when queued sleep never completes; requests sleep at the ceiling through the recovery entry point, including a null task chat link |
| ceiling-grace-deleted | does not renew the ceiling grace when queued sleep never completes |
| task-mode-guard-deleted | keeps the cost backstop for task-mode work with a sleep-capable owner |
| caller-wiring-deleted | requests sleep at the ceiling through the recovery entry point, including a null task chat link |

Final restored guard suite: 3 files / 82 tests PASS after all nine mutations. Root lint 13 tasks PASS; root typecheck19tasks PASS; root build9tasks PASS; context-budget command PASS. Final API typecheck/full root tests still in progress.

## Broad-suite reconciliation
Initial full run completed: API 15,259 passed, 2 skipped, with only two old expired-lease expectations failing; all other packages passed, including web 4,988 tests. Those controls are corrected in `57ac8c3a1`, their complete file passes 44 tests, and the test specialist re-reviewed them. Final full suite rerun is in progress. Current staging holder is MCP-grouping task 01M6SH3VNV1BMYX8BRTCX3QRVT, run 42318920176; explicit release is required before this task's VM check.

Final full local suite PASS: `pnpm run test --concurrency=2`, 21 successful tasks (19 cached), API 1,055 files/15,261 tests passed, 1 file/2 tests skipped. Web 399 files/4,988 tests passed. Root lint13/typecheck19/build9 tasks pass; final API typecheck passed. No remaining local code/test/review blockers. Staging release remains pending; no resources or overrides created by this task.
