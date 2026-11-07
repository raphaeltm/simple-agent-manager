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
- [x] Estimate bounded VM staging cost; coordinate staging, verify real background process sleep, clean up.
- [ ] PR, CI, CodeRabbit wait, merge and production health/deploy evidence; update idea.

## Workflow
Use SAM-provided output branch and current workspace; preserve unrelated .codex/config.toml. Task file rides feature PR because main is protected (existing project knowledge). No additional worktree needed for already isolated SAM task checkout.

## Review evidence (2026-11-07)
Final read-only local reviewers `final_runtime_review` (Cloudflare, constitution, environment, documentation) and `final_test_review` (test engineer, task completion) found no remaining code/test blockers. Earlier findings addressed: background protection includes foreground work and handles missing progress; real recovery entry and null task chat link covered; queue failure and task-mode/immutable grace controls added. Completion validator correctly leaves runtime/release evidence pending.

## Validation and staging plan
Recovered focused suite: 3 files / 82 tests PASS. Root typecheck: 19 tasks PASS. Guard mutation runs are underway and are restored in a finally block; results will be retained here. Previous workspace stop lost uncommitted /tmp broad-check logs, so no broad PASS is inferred.
Staging owners explicitly released; provider-limit task 01M6SKEXDWXRZJ7ZXDS8SNMZFP follows this slot. Cost estimate from live staging catalog: cx23 fsn1 2 vCPU/4 GB, €0.0088/hour; 30 minutes ≈ €0.0044 VM cost. Use one VM and existing Claude conversation profile, temporary 180000ms background/60000ms idle staging overrides, then restore both absent variables and delete own resources. Default two-hour behavior is exercised through the actual resolver in deterministic tests.

## Bounds
With no further work, normal automatic sleep is eligible at work_at + 15 minutes, or (while background work remains leased) last real work + 2 hours; the sweep runs every five minutes, with preceding maintenance, contention and capture adding latency beyond eligibility. A 60-second report changes neither deadline. At 24 hours of allocated runtime, conversation sleep gets the existing one-hour grace measured from immutable runtime generation age; repeat queue/claim timestamps cannot extend it. Candidate selection/batch volumes are unchanged; the ceiling branch adds indexed D1 sleep queue operations only, without remote runtime probes.

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

## Durable staging wait checkpoint — 2026-11-07 00:47 UTC
All local implementation, mutation, full-suite and review work is finished; do not rerun it just because the workspace restarts. No PR has been created. No staging deploy, GitHub variable override, VM, or test session has been created by this task. Latest source/test commit is `9e7c866c9efeb3bfa1ff6b2dfb4e8a7ba5425786`; subsequent commits only record task evidence.

Current holder: task `01M6SH3VNV1BMYX8BRTCX3QRVT`, branch `sam/last-24-hours-completed-x3qrvt`, staging run `42318920176` was still deploying at 00:47. Holder promises one short Instant check, no VMs/variables/redeploy, then explicit release. Provider-limit task `01M6SKEXDWXRZJ7ZXDS8SNMZFP` follows us.

- Wake subscription `808b455a-72b2-4334-b886-07f0c72d3185`, expires 2026-11-07 01:46:46 UTC. Source `sam.agent_channel`, type `agent.channel.published`, subject channel `agent-dm.dab7e952c0f47407eede4cb393bfe39a95da7760`.
- Accepted one-off fallback schedule `869b3ea4-3737-49c6-9d1f-51383b6a556a`, due 2026-11-07 01:01:46 UTC, targets this same chat `d0aa2b51-02ab-44e5-9b55-e279deb3eb5e`. Expiry is not a wake. After resume reconcile subscription state `any`, actual GitHub run and explicit release; do not blindly renew if no progress.
- Cancel only this task's obsolete subscription/fallback once release arrives.

Resume staging plan: confirm release; set staging-only GitHub Environment `HARNESS_BACKGROUND_WORK_MAX_DURATION_MS=180000`, `SESSION_SLEEP_AFTER_MS=60000` (both originally absent in staging AND production; do not change production); deploy output branch via `deploy-staging.yml`, verify actual Worker bindings with managed `CF_TOKEN`. Create one own explicit Hetzner `cx23` in `fsn1` via `POST /api/nodes` (`providerInstanceType: cx23`, x86_64), ensuring physical 2-vCPU/4-GB cost cap. Confirm fresh heartbeat and pin its `nodeId` on task submit in Potato project `01KWHD8XS7MQ7R6KWXJYRHDVH4`, existing Claude conversation profile `01KWHD97GDDT2SGYM4ET1JPXYF`, `taskMode: conversation`, `workspaceProfile: lightweight`, reservation 2 vCPU/2 GB/exclusive. Prompt: use Bash `run_in_background=true` with quiet finite `sleep 1200`, immediately end turn with `BACKGROUND-KEEPALIVE-STARTED`; do not poll, schedule or complete_task. The finite process also limits test runtime. Poll the session state/real clocks and sleep result: recent background work protects it before bound, then work_at remains stable while activity reports advance and the ordinary sweep sleeps the session. No ports signal.

Authenticate via `exec_with_secrets` selecting `SAM_PLAYWRIGHT_PRIMARY_USER`; token-login POST to api.sammy.party requires Origin app.sammy.party. Playwright Chromium/deps were installed and baseline authenticated dashboard passed, but /tmp scripts/cookie/browser install may disappear on stop; reconstruct only necessary ephemeral harness. Respect one-VM/30-minute bound and cleanup own fresh node/workspace/session; never delete preexisting/shared resources.

Coordinated restoration accepted by provider peer: after our VM validation/cleanup delete the two originally absent GitHub Environment overrides, then explicitly hand off. Their already-required deploy restores live Worker normal defaults and they verify actual bindings. We retain restoration responsibility if their deploy fails/is delayed; do NOT claim restored based on GitHub deletion alone. Their branch may have the older normal code default; restoration means no temporary short override. Verify restoration before merge/completion. This avoids a redundant restore-only deployment.

Then finish /do: actual VM evidence and task completion reconciliation, archive task file, PR with all local reviewers PASS/ADDRESSED, CI, trusted CodeRabbit label/request and ~15-minute wait, resolve any review, merge, monitor production and basic health, update idea `01M6NMM98RR33E416Y8R3NEKFB` with PR/outcome, complete_task only once pushed and shipped. No merge waiver or staging waiver.

## Own staging deployment in progress — 2026-11-07 00:55 UTC (supersedes previous wait)
Holder release event `0b99e7a9-8adb-4a33-9fc9-c368b7c19b61` verified; holder run 42318920176 SUCCESS. Both duplicate event batches acknowledged. Old release subscription and old 01:01 fallback cancelled. This task now owns staging; provider-limit peer was notified.

**External effects already performed — do not repeat:** staging-only GitHub Environment overrides `HARNESS_BACKGROUND_WORK_MAX_DURATION_MS=180000` and `SESSION_SLEEP_AFTER_MS=60000` were set (both originally absent). `deploy-staging.yml` was dispatched once: **run [42321012146](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42321012146)**, pinned full SHA `435be73bad3a1158d759064f78a974fd13c006cd`. It was still IN_PROGRESS at 00:55:40. No VM/node/task/test session exists yet from this task, and no PR exists. Deployment may apply the short overrides; restoration responsibility is ours until the accepted provider-peer handoff is actually deployed and verified.

Wake subscription `a4b307aa-7f94-46d8-8f64-91e223064e2f` filters GitHub commit `435be73bad3a1158d759064f78a974fd13c006cd`, exact `check_run.completed`, `check_suite.completed`, `workflow_run.completed`; expires 01:55:37 UTC. Accepted one-off same-chat fallback `54de5b28-130b-4db5-a1fb-4760c3a1532b` is due **01:10:37 UTC**, expires 02:55:37. Immediate replay had no events. On wake reconcile actual run before waiting or mutating; cancel only these obsolete wait resources once deployment succeeds. If fallback was needed, say so. Do not blindly renew if no progress.

Next action after deploy SUCCESS: verify actual Worker short bindings via managed CF_TOKEN and candidate identity, then execute the already-prepared single-cx23 VM procedure above. Local `/tmp/sleep-stage.py`, `/tmp/sleep-stage-node.json`, `/tmp/sleep-stage-submit.json`, `/tmp/sleep-browser.cjs`, `/tmp/sleep-pr-body.md` existed at checkpoint. Full local checks and reviews are already finished; no reason to redo them without a code change.

## Live VM checkpoint — 2026-11-07 01:18 UTC
Staging run42321012146 and smoke SUCCESS. Cloudflare version631adffa-edff-4c11-8de5-55e395ce0c40 serves100%, annotation commit435be73bad3a1158d759064f78a974fd13c006cd; actual temporary Worker bindings180000/60000 confirmed. Deployment subscription cancelled, one bounded fallback used; late event batch739c1abd cannot read/ack after cancellation (reported via task status), GitHub/CF independently reconciled.
Manual node POST rejected400beforecreation because historical-node ledger limit; no account limit changed or existing resource deleted. Filed incidental idea01M6SSB580VE5QXTMNBX5A251K. Canonical task provisioning uses active-node guard and accepted exactly one task:01M6SS962SB7SVTD1PA4Q63ZHZ/sessionceb86654-3555-4313-ab0f-ddeaab7bee20. Own node01M6SS9JHDGC7KCAXVMPAEN27H created01:17:15UTC, observed actual Hetzner cx23fsn1/2CPU4096MB, €0.0088/hour. Awaiting heartbeat at01:18. No PR yet. Both short GH staging overrides remain SET; cleanup/restoration responsibility unchanged until explicit provider-peer handoff and actual redeploy verification.

## Real producer evidence — 2026-11-07 01:29 UTC
Node delivered first heartbeat01:19:29 and ready01:20:46.995; D1 reports unchanged released agent1d9c9a13b7e80959c513ec99903a55e24ca37929. First task's2CPUreservation hit existing CPU saturation policy at100%; cancelled it beforeworkspace, reused same node explicitly with1CPU/2GBexclusive. No secondVM. Actual test task01M6SSHJS30JFA074TJXRC5R3X, chat428450c6-367a-4f5a-99f1-d74a8434424e, workspace01M6SSHS0CAXCTAPYMMXWMV0JX, agent session01M6SSJKXKCJHCCYBE4QQ2Y6CR. Real Claude Bashbackgroundsleep1200 started and turn ended01:23:04.639UTC, replyingBACKGROUND-KEEPALIVE-STARTED. WorkAt1794014584639,progress1794014583797; idle reports01:24:05.394,01:25:04.671,01:26:04.620,01:27:05.256,01:28:03.854 advance activityAt only. Stateidle/backgroundactivecount1, taskawaiting_followup. D1at01:25:27before3minbound shows agent/workspacerunning, snapshotpending,noqueued sleep. Bound01:26:04.639 passed; ordinary sweep awaited, no manual sleep requested. Playwright authenticated actual conversation page displays completed marker+idle state; screenshot locally retained. Cleanup/release not yet performed.

## Staging PASS and cleanup — 2026-11-07 01:35 UTC
Ordinary automatic sweep completed sleep at **01:33:30.558UTC** (no manualsleep). D1 confirmed snapshot **available**, sleep_status **sleeping**, sleep_errorNULL, agent-sessioncompleted, workspacedeleted; conversation task **sleeping**, noerror. Backgroundreportedactiveevery60sec through01:32with fixedworkclock; shutdownclearedtrackedbackgroundwork. Playwright actualchat displays **Session sleeping** and completedmarker. Sweep scheduling/maintenance and artifact capture add latency beyond eligibility; observed endturn→sleep10m26s with3minbound. Do not claim exact3minwallclock shutdown.
OwnnodeDELETEreturned success; subsequentGET404. Onlyonephysicalcx23evercreated, runtime~18min, estimatedVMcost~€0.0026beforeproviderrounding (within30min/€0.0044plan). Firsttaskcancelledbeforeworkspace; secondworkspace automaticallydeletedbysleep. BothoriginallyabsentGitHubstagingoverridesDELETED; ghvariablelistconfirmedneither. Explicitrelease sent toproviderpeer01M6SKEXDWXRZJ7ZXDS8SNMZFP, awaitingtheiractualnextdeployandWorkerbindingrestoration; responsibilityretaineduntilverified. NoPRyet.

Final completion-validator reconciliation: PASS for implementation and staging (A research/checklist, B diff/evidence, C tests/verification, vertical slice); UI/backend and resource-selection implementation N/A. Overall release remains open until actual Worker restoration, PR/CI/CodeRabbit, merge/production and idea update. Archive records implementation/staging completion, not a claim of release completion.

## Release checkpoint — PR2559
PR https://github.com/raphaeltm/simple-agent-manager/pull/2559 opened, linked to idea with staging outcome. Head b5292d44a4f0bd89d0101ca54a30f9d3700d729e initial CI: build/typechecks/quality/specialist/UI/secret scan passed, full tests still running; Lint failed because format baseline review expired at midnight, Preflight failed because impact paragraph lacked concrete paths. PR body corrected and actual preflight validator passes. Format review running against same base/formatter/debt ceiling2225; metadata-only thirty-day renewal proposed only after ratchet passes, local runtime reviewer approves conditionally on count.
Overlapping staging run42323281763 deployed API commit159034ecc6905fcc3a43e07d122ca426e60a4ed2 at01:33:46.679570UTC, sixteen seconds AFTER successful sleep01:33:30.558. Intermediate01:32:03deployment was secret-only against our existing code. Test remains valid; actual short overrides persisted in overlap candidate. Provider next run42325669128, branchsam/fix-provider-limit-waits-snmzfp, fullSHA0b7b87d232e13effdbfe241806e2fba8ec01d6f2 started01:44; do not claim actual restoration before Worker binding verification.
Attempted PR CI subscription sleep-pr2559-ci-b5292d44 stalled; orchestration stopped after>3min. Reconciled stateany shows it was not created, and dependent schedule never ran. No unsupported wake assumed. New wait must have independent accepted fallback. CodeRabbit has NOT yet been requested (CI not green).

Format baseline review PASS: `pnpm format:check` reports1994/2225 unformatted files. Same formatter/base commit/extensions/debt ceiling retained; reviewedAt renewed2026-11-07 and next review bounded to2026-12-07. Local final_runtime_review approval condition satisfied; no runtime tests needed for metadata. Real preflight checker against corrected PR body PASS. This adjacent CI blocker required only the two-date metadata renewal, no lint bypass.
