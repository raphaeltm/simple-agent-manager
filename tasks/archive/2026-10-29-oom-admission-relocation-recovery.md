# OOM admission and relocation recovery

SAM task: 01M63AEHMDRQKR45YAYXTAXJ3W. Parent: 01M6364S1M4WHNR1JJZ062B82Y.

## Scope and authorization

Complete measured-memory admission and eviction startup retry recovery, preserving configured reservations, user isolation, ownership and termination proofs. User explicitly waived staging; no production lifecycle/stress fixtures. Deliver green non-draft PR, specialist and best-effort CodeRabbit review, merge and production deployment/basic smoke.

## Research

- Current reservation accounting admits observed memory pressure above safe physical headroom. Preserve declared reservations and add measured headroom admission consistently in ranking and atomic allocation.
- Eviction recovery startup failures retain a snapshot but are classified report-only. Startup clears the source chat binding, so callback replay must resolve exact fenced snapshot identity to recover the same conversation.
- Oct28 source workspaces 01M61R65WX5J59DP9AD3T8ERVC and 01M61RCAQSP61S913NNN74MDGM have moved snapshots identified by eviction_recovery_workspace_id, not current workspace_id. Both chats relocated; first task completed, second sleeping. Coordinate source retirement with cleanup owner; no blanket deletion.
- Hetzner412 is already transient capacity; verify functioning fallback and diagnostics, avoid rewrite.

## Acceptance and checklist

- [x] Measured pressure prevents unsafe packing; declaration/profile unchanged; concurrent allocation cannot reuse headroom.
- [x] Startup failure retains conversation and replay retries using exact ownership/generation; stale callbacks cannot steal successor.
- [x] Recovery retry budget remains bounded with visible terminal exhaustion.
- [x] Fallback diagnostics distinguish recovered capacity attempt from task terminal failure; reconcile production evidence.
- [x] Meaningful regression tests and appropriate quality checks pass.
- [x] Specialist reviews and task-completion validation complete before archive.
- [ ] Green PR, best-effort CodeRabbit, merge, deployment and basic smoke evidenced.

## Coordination

feature.reliability-20261029: cleanup owner owns retirement/legacy fallback and stopped-node clocks; this task owns admission and eviction/recovery. Production evidence and residual blockers must be reported to parent.

## Implementation and verification evidence

- Admission checks declared capacity plus measured host usage + outstanding memory reservations + pending request. Unique running-workspace observations are lifecycle/heartbeat/TTL fenced; missing or invalid telemetry is conservative. Atomic D1 allocation includes unobserved creating rows, preventing concurrent starts from spending the same heartbeat twice. Existing CPU/disk/profile/exclusive/owner controls remain.
- Callback startup failure now returns retryable conflict only when the task/snapshot were retained. Detached source callbacks find the exact source-owned snapshot; replay cannot borrow changed user/project/node/generation/workspace identities. Automatic callback and scheduled retries share a strict non-decaying attempt cap; ordinary user wake decay remains available.
- Accepted runner startup failures receive a bounded background sweep: exact sleeping task, failed attempt, evicted source generation, restorable unexpired snapshot and unchanged ownership. Continuation evidence persists false/true/legacy-null in migration0213. No deletion authority is introduced; normal replacement deletion proof remains.
- Unit/API coverage: 154 related admission tests; 19 real Workers D1 admission tests; 85 callback/recovery/handoff tests at initial checkpoint; 111 sweep/budget/handoff/fallback tests at initial checkpoint. Final changed-head reruns pending. The new HTTP startup/budget regressions failed against original product code (2 failures) and passed with fixes. API typecheck and targeted lint passed initial checkpoints; file-size/migration safety pass. Runtime-tunable ratchet passes after moving sweep controls into validated Admin Settings.
- Independent security review PASS. Cloudflare/constitution review identified fairness starvation and callback budget-decay gaps; both were fixed and final review passed. Task completion/doc/env review passed implementation coverage. No staging was used per explicit user waiver.

## Production reconciliation (read-only, 2026-10-29)

Both Oct28 OOM incidents automatically claimed wake at17:40:13.577/17:40:35.729, delegated replacements17:44:21 and reached in_progress17:50:10/17:46:45. Task01M61R61HVDEZMFD3S7T0C9G3C/chat19a052da-38ed-4c0d-86f1-07c52a564439 completed; task01M61EQC53BM0QZCAK8YTVPA3Z/chat67b62949-34c1-4255-a1d7-5eef6cfa1ce7 later slept18:13, woke19:22 and slept19:56. Current available snapshots moved to successors but retain original eviction_recovery_workspace_id/node identities. Source-workspace snapshot absence does not prove capture failure. Cleanup owner received exact source/snapshot/chat/task correlation and owns retirement/artifact validation; no physical deletion inferred from evicted/error status.

All24 Hetzner412 errors correlate to5 chains (4+3+8+5+4 rejected offerings), each followed by succeeded diagnostics; current tasks3completed/2sleeping without terminal error. All24 rejected node IDs absent D1;5 successful nodes retain provider identities. D1 alone does not prove provider inventory absence. No fallback rewrite. Existing-state failed-eviction retry eligibility query found0 candidates at08:10:41UTC; no backfill mutation performed.

## Release gates still pending

Final test/quality reruns, review signoff, PR/CI/CodeRabbit, merge and successful production deploy/basic read-only smoke remain workflow gates. Task artifact direct-main push was rejected by repository required CI (GH013); preserved on feature branch without bypass. Full lifecycle/stress and staging excluded by user authorization. Sampled telemetry cannot enforce runtime memory ceilings or guarantee no OOM, and conservative missing observations may provision earlier.

### Observed resource evidence

Both sources declared1536MiB/400mCPU(project configuration); observed node4CPU/8192MiB minus512MiB reserve. Persisted placement diagnostics projected68.3% then88.3% with1 then2 co-tenants. Source1 retained cgroup window17:16:13–17:31:13 peaked2965MiB working set (cache-inclusive4700MiB); near the second admission17:19:30 it was only609–624MiB working set. Source2 retained17:19:35–17:34:35 peaked1121MiB working set(total1626MiB). Both report finalFlush=false: retained oomCount0 predates the17:40 final crash window and cannot disprove OOM. These show growth beyond reservation, not proof that the new guard would prevent this exact later crash. Original host memoryPercent at admission was not retained/proved. User-configured profiles remain unchanged.

### Broad-suite scope correction

The full API run found the shared evaluator also served deployments, whose per-service admission and atomic SQL do not use workspace observation credits. Scope the new measured predicate to workspace roles; the existing trusted-capacity projection carries nodeRole, and only the exact deployment role retains its existing contract. Missing/null/unknown roles remain guarded. The original deployment boundary test is unchanged; workspace/deployment suites passed128 tests, plus29 evaluator tests including explicit role controls. Independent Cloudflare review passed this domain scoping correction. Repository lint import sorting corrected without behavior change.

## Final implementation validation

Repository lint/typecheck/build passed35 tasks; final-head API typecheck passed. Full API run completed980 files:14142 passing tests,2 skipped,5 failures isolated to the deployment boundary and four declared-budget simulations. Both issues were corrected without weakening workspace admission; exact formerly-failing files reran51/51 green, including the added pressure-rise scenario. Final evaluator role controls29/29 passed. Workers D1 admission19/19 passed. Runtime settings, migration safety/order, source-contract, AST(error-free warnings), file size, format and instruction-budget checks passed. Local security, Cloudflare, constitution, task-completion, documentation and settings reviewers all PASS/ADDRESSED; final completeness approved implementation archive after51+typecheck results.

This is the /do implementation archive; release checkbox remains pending until CI, CodeRabbit, merge and production verification are recorded in the PR body and SAM completion evidence. No task completion is claimed merely by archiving implementation notes.

### CI Workers calibration

CI shard3 found two additional declared-capacity fixture assumptions in vm-admission-control-races.test.ts: two full reservations and stopped/deleted release still reported10% live host memory use. Only those declared-budget scenarios now use idle telemetry. A discriminating control confirms stopped reservations do not erase live measured pressure. Production guards are unchanged. The complete native file passed25/25 tests; targeted ESLint passed. A fresh exact-head CI run is required before release.
