# Drain incompatible agent nodes when capacity admission is blocked

SAM task: 01M473KXWJYT6S1JR03E8GVY2B. Idea: 01M4677451EBA2GZW0TENE0WEM.

## Current outcome

Implementation, independent specialist reviews, final full quality, exact-source CI and renewed cancellation staging PASS. Final independent completion/doc-sync review PASS; CodeRabbit request/wait, normal merge and successful production deployment remain required. PR2239 stays draft until readiness gates pass.

## Cancellation regression discovered during final cleanup (fixed and reverified)

Acceptance was reopened; the correction and final live evidence are below. The eligible-full control `01M47BDN9PRK1G8CTVBWNXD66M`, cancelled at 00:57:30, later provisioned an empty VM after the original slot freed: node `01M47CMP3PE4VRKMKAY6HQVXET`, provider `168943348`, created 01:18:24. Normal owned-node DELETE succeeded. Its later error-only node `01M47CVQQPTVJYCKW6ACMN1N1K` (provider ID NULL) was also deleted through the normal API at 01:31:26; immediate owned nondeleted nodes and active reservations are zero. The earlier instantaneous zero and independent completion PASS did not establish durable cleanup or cancellation safety; final primary retirement and post-cleanup observation now verify the correction.

Unconditional task execution/identity and atomic allocation fences were implemented, independently tested/reviewed and verified in the subsequently authorized separate window. Late orphan recovery exceeded the original 01:20 cleanup deadline. Five charged cx23 hours total EUR 0.044 compute, still within the original EUR 0.10 approval; the extra backend allocation was not an authorized test.


## Problem

Six production tasks exhausted the two-hour admission deadline while an occupied incompatible-agent host held spare hardware capacity and a pool slot. Preserve active work and configured pool/account limits. No legacy workspace-count caps or quota/spend changes.

## Research

- Current main 0366b17d9 retains the defect; no open duplicate PR or active matching task found.
- `capacity-pool-node-limit.ts` and migration 0167 count managed running/creating/recovery nodes; placement exact agent-version gating rejects old builds.
- `node-provisioning-step.ts` checks the limit before and after the provisioning lease and handles the real trigger abort.
- Old-agent cleanup in `scheduled/node-cleanup/node-phases.ts` only retires empty hosts after configured idle retention; it never initiates drain.
- Merged #2218/#2223/#2224 fix snapshot size, bounded sleep (3 failures/15 minutes with verified recovery or blocked state), and callback renewal. Reuse these; do not modify sibling sleep-status/telemetry files.
- `queueWorkspaceSessionSleep` supports expected-node fencing and preserves attempts. Canonical sleep teardown independently checks authoritative idleness and durable recovery.
- Candidate resolution subtracts host memory reserve; early hardware diagnostic does not, masking resource shortage as allocation authority mismatch.
- Production read 2026-10-05: one running managed pool host, four occupied workspaces; historical incompatible nodes already deleted. Reproduce deterministically and on bounded staging fixtures.

## Checklist

- [x] Implement admission-triggered bounded safe drain through existing sleep machinery; scope to managed same-user pool VM hosts with incompatible builds.
- [x] Preserve busy work, blocked episodes, warm retention and DB cap; record version-specific drain evidence.
- [x] Correct hardware/reserve rejection reasons while retaining true authority mismatch diagnostics.
- [x] Real admission-path regression with occupied incompatible host; simulate bounded safe sleep/cleanup and verify subsequent provisioning.
- [x] Eligible-full convergence and busy/blocked/foreign/deployment/Instant controls.
- [x] Prove regression fails against original code and run required quality checks.
- [x] Independent Cloudflare, constitution, test, documentation and completion review; resolve findings.
- [x] Coordinate one pinned bounded staging sweep with visibility and telemetry siblings; clean resources.
- [ ] Archive task, draft PR, CI, CodeRabbit request/wait, merge and monitor production deploy.

## Acceptance

Admission actively progresses a safe incompatible host drain without increasing pool max or destroying active/unrecoverable work. Existing sleep episode and cleanup budgets bound reclaimable-host recovery. Full eligible hosts continue to wait/expire. Placement evidence identifies incompatible-agent drain and actual resource shortages. Real admission tests and staging evidence demonstrate behavior. Seven-day production recurrence observation is a follow-up SAM Idea, since this implementation run cannot observe a future week.

## Rules

Rules 47, 54, 62, 69, 74; `/do`, configured warm retention, canonical idleness and bounded sleep recovery policies.

## Verification progress

- Reviewed implementation and tests: `65dfc2ca7f148cc08dd8de5bc0804828f22ee3a4`.
- Independent Cloudflare/constitution review PASS; queueable candidate status improvement addressed in `2290e2fbd`.
- Independent test-engineer review PASS; actual admission tests include schema-derived SQLite and migration 0167 trigger. Final focused run: 23/23 PASS. External snapshot and provider deletion receipts remain simulated locally and require staging evidence.
- Independent completion implementation review PASS; acceptance completion WARN pending staging/quality. LOW real retry status corrected to `failed` and `preparing` added in `65dfc2ca7`.
- Documentation review PASS; provenance restriction corrected in `65dfc2ca7`.
- Regression proof: deleting admission drain invocation fails missing snapshot assertion; removing memory/reserve diagnostic checks fails expected memory reason against authority mismatch. Both restored; final 23/23 PASS.
- Root lint 13/13 PASS and root typecheck 19/19 PASS. Full tests/build run serially to avoid memory contention.

## Shared staging fixture ledger

Coordinator: resource-history task `01M473KNZ9WXZ0X4G3Z743X2C1`; initial integration `2e4e88645abef7b3eab347795e5d356918494147` superseded by reviewed/deployed `2613b82d02afe0c10a229b236055adcb979085c7`, no independent deploy.
Approved estimate: two small hosts within shared window < EUR 0.10; actual cx23 EUR 0.0088/hour, no quota/spending increase.
Live staging rechecked zero managed runtimes before provisioning. Existing required agent build `c66d1dd51ef46a92b9e12c169cb3138d1d266550` confirmed in Worker settings and fixture heartbeat.
Owned project `01M4757VDW3YBG091THZCKNHGV`, first fixture task `01M4758TYJ6V233G85VSEHNT2K`, session `a15ffebd-4414-4ff2-8691-d5efe0817abd`, node `01M47592V5DFAXA2ARYJ2Y7PVF`.
Chat: https://app.sammy.party/projects/01M4757VDW3YBG091THZCKNHGV/chat/a15ffebd-4414-4ff2-8691-d5efe0817abd
Pool `cap-pool-default:user:toWzGjNW3IyUkCVItRQv3qSn0wI8c22y`; original maxNodes3. Reservation 625cpuMillis/1152memoryMb/13312diskMb.
Historical setup correction (resolved by sequential recovery below): lowering maxNodes1 before workspace admission completed advanced revision25->26; restoring ORIGINAL3 advanced27 and could not repair strict cached authority. First host remains healthy empty, no workspace created. Coordinator notified and asked to authorize sequential API cleanup/provider absence then ONE corrected fixture with maxNodes1 configured before submission. No further VM provisioned.

Seven-day recurrence follow-up SAM Idea: `01M474AV9DBFPBKPKAZ6PZXDTV` (future observation cannot be completed in implementation run).

### Corrected fixture

Coordinator authorized sequential API cleanup with provider-absence proof, zero live usage, then one corrected fixture; revised 75–90 minute elapsed window <= EUR0.03, within prior EUR0.10 bound.
First task cancelled; initial node deleted confirmed through API. Related error node `01M475RRZ2V88JWCMN6SFD8W9C` had no provider instance/IP and already stored termination proof; normal API deletion confirmed. No concurrent extra runtime.
Corrected pool maxNodes1/revision28 set before submission and unchanged thereafter. Task `01M475TJHSSZNA3H07BPSKHKK6`, session `8a531f4e-9295-4879-96ec-f6be51120c4d`, node `01M475TRJKCN3PT23CCP73NXF7`, workspace `01M47651P42CPKKHEHGQ505XJE`.
Node https://app.sammy.party/nodes/01M475TRJKCN3PT23CCP73NXF7
Workspace https://app.sammy.party/workspaces/01M47651P42CPKKHEHGQ505XJE
Chat https://app.sammy.party/projects/01M4757VDW3YBG091THZCKNHGV/chat/8a531f4e-9295-4879-96ec-f6be51120c4d
Old agent c66d1dd51ef46a92b9e12c169cb3138d1d266550 heartbeat23:24:56Z/ready23:24:16Z. Read-only authority comparison matched revision/source generation/credential version/candidate. Initial CPU saturation after boot cleared; workspace creating at23:25:15Z. At that historical observation, running/fixture sentinel assertions were pending; subsequent runtime receipts below confirmed both.
Integrated candidate repinned `2613b82d02afe0c10a229b236055adcb979085c7` (sleeping test fixture correction only).

At23:26:19.819Z canonical agent idle/inactive; assistant confirmed FIXTURE READY, uncommitted `capacity-fixture.txt` exact `capacity-drain-preserve-01M4677451EBA2GZW0TENE0WEM`, git HEAD `a18ce29a47a952ecc284ccbbc89fdb2d845823bc`. Workspace running; read-only D1 confirmed exactly one live managed node, one occupied workspace, maxNodes1/revision28, heartbeat23:26:58Z c66d1dd. Coordinator sent full reviewed SHA, IDs/links/fixture assertion, hold replaced with readiness report; only coordinator deploys.

Real session-proxy file read confirmed exact sentinel content; real git/status confirmed staged[],unstaged[],untracked capacity-fixture.txt ?? before integration. This supplements assistant assertion with runtime evidence. Root web336 suites/4023tests PASS; full API ongoing.

Coordinator full quality PASS (lint13/typecheck19/build9/root21/API816files11383tests/web4023/fullGo+race) and began integrated deploy2613b82d at23:36Z. Browser baseline workspace/chat hydrated, no page errors, screenshots inspected. ONE authorized read-only human followup completed at23:36:31.119Z with unchanged exact sentinel/HEAD and canonical idle/inactive. Expected normal15mineligibility23:51:31Z; no further reset. Strict baseline file/untracked assertion PASS, sentinel SHA256 db98501d4c3ed89595e9fbaeb466e0d369c70c72da4ca48d725daf9da0aa3ea3.

Shared staging workflow https://github.com/raphaeltm/simple-agent-manager/actions/runs/37389450160 pinned2613b82d. Existing predeploy ProjectData alarm regression2.04x is unrelated to newfixture/TaskRunner and was recorded by coordinator in existing SAMIdea01M27M86R544BQX86VZANZGSQ2, no duplicate issue/Idea or overlapping code.

## Final local quality

`pnpm lint`13/13 PASS; `pnpm exec turbo run typecheck --concurrency=1`19/19 PASS; `pnpm exec turbo run test --concurrency=1 -- --maxWorkers=1`21/21 targets PASS (API818 files/11402 tests; web336 files/4023 tests); `pnpm exec turbo run build --concurrency=1`9/9 PASS. Focused admission/placement23/23 PASS, observed removal proofs fail and fixes restored. Node-pool boundary, source-contract1565tests and formatratchet PASS. API build's existing missing-output warning is nonfatal.
Phase4/5 implementation validation complete; downstream shared staging, CI and merge remain explicit unfinished gates.
At23:43:40 read-only lifecycle observation: ordinary idle already has available snapshot generation01M476T50N6DJSVWJNEN0WMC08 and scheduled unclaimed sleep_after23:51:46.511Z, zero failures/attempts. New helper must preserve that episode. Coordinator asked to explicitly authorize one bounded additional human prompt to create legitimate missing intent through normal cancel-scheduled-sleep API and exercise admission CAS; no further activity reset performed yet. This would require <=105min elapsed but <EUR0.02 actual estimate, below prior cost cap; no second concurrent VM or direct D1 writes. Existing-episode preservation plus local CAS proof is an alternative if coordinator declines.

### Live admission and busy preservation receipts (23:54–23:56 UTC)

Shared deploy37389450160 SUCCESS including smoke; directly verified Cloudflare deploymentc8a7f53f-35ec-41ba-aae5-072ed6df47a8/versionf1d53c9e-3252-48c0-9592-fbb4affe5a7b at100%. API source2613b82d, required agent CONTENT4f83d6a7287c4c34fff480dc78cf9cac269840aa (not integration Git HEAD).
Coordinator released actual probe and ONE35s foreground normal human control, hard cleanup01:04UTC/105min, unchanged EUR0.10 bound/conservative <=EUR0.03. No direct D1 mutation, deployment, policy changes or concurrent extra VM.
Probe task01M477VY1W106QZW9E8H5KW2EH/session2f801eaa-2fa6-429d-a4ea-106d71e61a47 hit REAL admission waiting capacity_pool_node_limit; sole oldc66 occupied host rejected as incompatible with hardware2000cpu/3584MB/40960disk and projected65% utilization. Existing scheduled23:51:46.511 deadline/zero attempts/zero failures preserved.
Normal prompt01M477WJH066VVBFK6401KDAGE cancelled unclaimed intent through regular API. At23:55:30 and45 intent NULL, canonical prompting/runtimeWork active count1. Actual admission retry emitted safe-drain note and scheduled missing intent for23:55:54.608; observed at23:56:01 with running occupied workspace, zero attempts/failures/claim. Canonical idle/inactive at23:56:03.300 after foreground control. This proves missing-intent admission CAS and busy work protection; no further prompts until restore verification.
Real file/git read after control confirmed exact sentinel/hashdb98501d4c3ed89595e9fbaeb466e0d369c70c72da4ca48d725daf9da0aa3ea3 and only untracked capacity-fixture.txt. Automatic15min idle sleep,30min retention,replacement,restore and sibling checks remain pending; do not count these as passed yet.

### Automatic sleep first attempt (00:11–00:14 UTC)

The normal executor claimed preparing at00:11:27.081 with attempts1/failures0. First attempt ended safely at00:13:40.279: snapshot no progress120000ms, previous generation kept. State available generation01M477XXNHFD439M355CD1T6W7, captureNULL, workspace running, failures1; existing retrydeadline00:18:40.279 unchanged across admission retries.
Read-only CF observability and normal node/logs confirmed prepare00:11:30, WIP authorization00:11:35, HOME authorization00:11:38, then late HOME progress00:14:07 and completion00:14:08 rejected409 after claim abandonment. Underlying upload delay is unproven. Authorized prior HOME44083200bytes/WIP688bytes and hashes retained. Existing bounded fallback verifies that completed generation and transcript/idleness before release; no policy override or state mutation. Final protected sleep/retirement/replacement/restore still pending; timingrisk reported to coordinator against01:04 bound.

### Protected sleep, physical workspace cleanup and current bound

Second normal attempt succeeded (no fallback or policy override): sleepingAt00:21:44.095, generation01M479CDJ05DZH7E2JX1M6FG37 available/nondegraded; HOME44124160bytes/SHA63ef2ccbd47e63e76135ba5eccf9e9c01a145d498c620d13aaef2bd28227da5b, WIP688bytes/SHA8d740f16c4e5de10bb7b188de2106ad111eaed8dcc25f01ca73d315da3faff2b. Sleep attempts2, finished episode counters0. Original task sleeping.
Normal five-minute deletion delay completed: workspace deleted/runtime_deletion_confirmed_at00:26:49.018/proofvm_agent_confirmed. Normal container inventory confirms old devcontainer absent; only host-level model-runner remains. Node running/occupied0/warm_since00:21:52.108. It must remain until configured30min retention elapsed (earliest00:51:52); probe still queues under unchangedpool1.
Coordinator verified final history flush680samples/5tools across4 real chunks and eachdetail200. Postdeploy Playwright node/sleeping-chat header/status/input rendered without JSerrors/screenshots reviewed; transcript pane screenshot blank, so restoration/transcript workflow remains pending rather than claimedpassed.
Coordinator authorized firm cleanup01:20UTC/121min window. Cost estimate corrected from fractional-runtime estimate after primary Hetzner FAQ verification: per-server whole-hour billing means4 charged cx23hours at EUR0.0088=EUR0.0352; conservative<=EUR0.05 including incidental storage, within original approved EUR0.10. Coordinator acknowledged correction/one sequential replacement; no account quota or spending limit increase. Source https://docs.hetzner.com/cloud/billing/faq/ . Direct provider inventory unavailable; distinguish normal strict provider deletion receipts from independently queried physical inventory.
Sonar finding109duplicate lines applies onlydeclarative testhelper; allproduction modifiedfiles0duplication. Exact helperpath added to existing .sonarcloud.properties test-only CPD policy, independenttest-engineerPASS; runtime/tests identical65df. NewHEADfc5e464a3 SonarGREEN, CI onlyDurableObjectWorkers pending as00:30. Final live acceptance remains held for retained retirement/replacement/exactrestoration/eligiblefullcontrol/siblingchecks/cleanup.

### Warm expiry and replacement admission qualification (00:51–00:55 UTC)

At the configured 30-minute expiry, normal NodeLifecycle handoff marked the empty old node STOPPED at00:51:52.714 (warm_since cleared), without a provider termination marker. Migration0167 excludes stopped nodes from the configured running/creating/recovery pool count; the original queued probe automatically provisioned replacement01M47B46AN4V9H6DC9PY79NY21/provider168939857 at00:51:59.573. Logical maxNodes1 remained respected. A possible transient overlap of two provider instances cannot be excluded, so this is NOT sequential physical absence proof or autonomous provider deletion proof.
To bound billing and reconcile the coordinator's intended sequential replacement, normal authorized DELETE of ONLY the owned empty old node returned success at00:55; the old node record is absent. The endpoint requires runtimeTerminationConfirmed before record removal. This is qualified normal provider-boundary evidence; no direct provider inventory was available. Original snapshot-linked deleted workspace/history remained retained. No third VM, resubmission, independent deploy, direct D1 writes or policy edits occurred.
Replacement https://app.sammy.party/nodes/01M47B46AN4V9H6DC9PY79NY21 reports required agent4f83d6a7287c4c34fff480dc78cf9cac269840aa and heartbeat00:55:17.682; agent-ready is pending while normal bootstrap pulls runtime images. Actual original admission progressed from pool-cap wait to provisioning/node_agent_ready. Restoration/control/cleanup remain unfinished. All PR2239 CI gates onfc5e464a3 are now green; draft retained.

### Current-agent admission, restoration and eligible-full control (00:56–00:58 UTC)

Replacement agent-ready at00:55:55.670 and required version4f83d6a7287c4c34fff480dc78cf9cac269840aa. Observed heartbeat00:54:17.685 is the earliest retained poll, not asserted first heartbeat. Real queued probe progressed to placed, workspace01M47BC96W5665AXVFGRWYNTWC running, task01M477VY1W106QZW9E8H5KW2EH in_progress and assistant ADMISSION PROBE READY.
Normal original-session prompt restored the SAME original task01M475TJHSSZNA3H07BPSKHKK6 to workspace01M47BD4HYTKPY9EBVT7BQN3N8 on the same current-agent node; snapshot restore_status restored/restored_at00:58:01.175/base_commit a18ce29a47a952ecc284ccbbc89fdb2d845823bc. Actual runtime file read exact sentinel and SHA256db98501d4c3ed89595e9fbaeb466e0d369c70c72da4ca48d725daf9da0aa3ea3; git/status staged[],unstaged[],onlyuntracked capacity-fixture.txt??. Assistant normal read-only command confirmed RESTORE VERIFIED with exact HEAD and sentinel; canonical idle/inactive/count0 afterwards. No new task ID, commit or file mutation was needed for restoration.
Real eligible-full control01M47BDN9PRK1G8CTVBWNXD66M requested625cpu/1792MB/13312MB against two existing625cpu/1152MB reservations. Placement rejected current-agent host with exact reason “memory budget would be exceeded after host reserve”: total4096MB>usable3584MB. It queued capacity_pool_node_limit with workspaceNULL, attempts[], notes[]; no incompatible-host drain or extra VM. Immediately cancelled ONLY owned queued control through normal task-status API. Existing snapshot/intent budgets unchanged.
After restoration/control, authorized normal explicit Sleep of original idle fixture began to free its reservation for sibling cycles; active parentprobe remains running and uncancelled. Coordinator/visibility received exact IDs and scope; no third VM or deployment.

### Normal cleanup handoff (01:02 UTC)

The restored original fixture's explicit Sleep request exceeded the client's45-second read timeout. A full nondegraded final snapshot completed00:59:11.618 (generation01M47BFN2KEC3WTF3JHETWSVJH/captureNULL), but its preparing claim remained. Request-lifetime interruption is an inference, not proven. No repeat Sleep, claim mutation or policy override was attempted. Explicit workspace DELETE would purge snapshot/interaction evidence and was rejected as the cleanup approach.
Authorized normal VM Stop of ONLY the now-idle, fully captured restored original workspace returned stopping, then stopped/occupiedreservationreleased at01:01:58. Source finalizeWorkspaceStopInNode preserves recovery artifacts, clears obsolete sleep claims under the exact stop identity fence and schedules normal workspace TTL. Snapshot stayed available/restored. The original automatic protected sleep proof is separate and already passed; this manual handoff is not falsely counted as successful sleep.
At01:02 coordinator and visibility received release for active parentprobe task01M477VY1W106QZW9E8H5KW2EH/session2f801eaa-2fa6-429d-a4ea-106d71e61a47/workspace01M47BC96W5665AXVFGRWYNTWC, sole current-agent node01M47B46AN4V9H6DC9PY79NY21/poolmax1rev28/occupied1. Visibility owns one child on this existing host, then coordinator owns telemetry stop/restart and cleanup by01:20. Parent normal idle intent01:12:44.986 must be cancelled through their ordinary dispatch prompt; no independent keepalive or allocation. Capacity agent now only observes and records evidence.
Independent final completion reviewer found no substantive runtime expansion required: unchanged pool semantics are logical, and local tests cover the deleted cleanup path rather than a mandatory physical-deletion gate. Physical overlap qualification was added to existing follow-up SAM Idea01M474AV9DBFPBKPKAZ6PZXDTV. Final acceptance remains held for sibling checks and cleanup.
Normal Stop cleanup qualification: original restored task closed FAILED at01:05:46.534 with exact reason “Task runtime is conclusively gone after reconciliation grace (workspace_stopped).” This is owned cleanup behavior after its successful stable-ID restore, not a failed admission or lost-work assertion. Restored workspace physical deletion confirmed01:06:56.336 after normal five-minute TTL; its snapshot remains available/restored. Sibling first protected sleep completed01:05:25.334 on same current host, no additional VM.

### Final coordinated cleanup and runtime verification

Coordinator verified direct parent WSS/TLS and executed marker at01:13:22.948, normal Stop01:14:26, same-host Restart RUNNING01:14:47, postrestart WSS/TLS executed marker01:15:32, final Stop confirmed01:16:06.848. Raw parent history181+35+7 samples equals summary223 with two tool spans and three distinct object keys, all payload integrity PASS. The restarted collector emitted seven fresh samples; running-window duration does not prove continuous sampling. Shared postdeploy Playwright header/status/input/node rendering and screenshots were inspected with no JS errors; blank transcript pane is still explicitly not counted as a functional transcript assertion. Separate actual file/Git restoration and terminal execution checks passed.
Visibility exercised one child sleep and one actual same-host wake: HANDOFF_WAKE_OK, canonical idle/inactive/count0. Its remaining cycles/mailbox wake/sleeping cancellation cases did not fit the bounded window and remain pending on its own draft PR2240. Coordinator expressly confirmed these do not block the separately verified capacity prevention fix. No additional fixture writes after handoff.
Urgent cleanup release was verified through SAM task identity and authenticated coordinator session messages confirming final Stop and cleanup handback; normal cleanup finished01:18:32.184 before firm01:20. Only owned parent01M477VY1W106QZW9E8H5KW2EH and child01M47BRJVHCQHKTFHSNYA8TEDY were cancelled. Owned replacement node01M47B46AN4V9H6DC9PY79NY21/provider168939857 normal DELETE returned success; strict endpoint termination gate and node row absence qualify the provider-boundary receipt. Owned managed node count0, active reservation count0, replacement row count0. No direct provider inventory was available. All remaining owned snapshot-linked workspaces have deleted/no-node state and runtime_deletion_proof node_runtime_terminated at01:18:20.480.
Original pool maximum3 restored through normal PATCH, revision29 verified AFTER zero compute. No account quota/spending limit increase, third VM, direct D1 writes, workspace/project evidence purge, or independent deploy. Three available snapshots retained with node_idNULL and ordinary expires_at: original8a531f4e... 2026-10-13T00:59:11.618Z, parent2f801eaa... 2026-10-13T01:02:58.557Z, child3e86ad77... 2026-10-13T01:12:41.071Z. Four snapshot-linked deleted workspace records remain; normal history retention remains unchanged. Coordinator, visibility and parent received exact release receipts.

The initial final independent task-completion review PASS was superseded by the later cancelled-control allocation finding above. Its initial instantaneous zero-compute evidence remains historical and is not durable cancellation acceptance. Existing no-node scheduled child snapshot is a normal reconciliation artifact, not active compute; do not claim every sleep intent cleared. CodeRabbit, final CI, merge and production deployment remain required workflow gates.

### Cancellation correctness patch and renewed verification

The ordinary TaskRunner had no unconditional task-status fence: reserved start guards return immediately for unguarded submissions, and cancelling admission does not terminalize cached runner state. New authority checks require matching task/project/user and canonical executable statuses at alarm entry and real provisioning entry. The task allocation UPDATE atomically repeats these conditions and rejects zero rows before paid provisioning. Checks at the existing provider boundaries catch cancellation during paid creation.

Revoked ordinary runners keep the winning verdict, release only their own lease, and atomically claim only their newly allocated empty managed workspace host for strict deletion. Canonical active reservations, other task ownership and configured bounded warm-placement claims prevent destructive cleanup. Completion follows successful lease/claim writes; transient D1 faults retry cleanup without fresh allocation. Once claimed destroying, existing cleanup handoff owns external deletion retries. Existing reserved/recovery guards retain precedence and their original workspace cleanup; no new broad workspace-recovery teardown was introduced.

Independent Cloudflare/security/constitution source review PASS after warm-claim and completion-order findings were resolved. Focused admission+placement tests44/44 PASS; paid-provider cancellation, deletion failure/real handoff convergence, protected/reused/foreign hosts, newer wake fencing and transient lease/node-claim failures exercised through real TaskRunner alarm and schema-derived SQLite. Existing runner unit/integration group111files/1673tests PASS before final two D1 retry cases. Actual Workers52/52 passed after guard precedence correction; final source rerun pending. Full root quality rerun is serial/in progress; renewed coordinated changed-path staging and exact-head CI remain required.

Coordinator100%-sampling CF evidence shows cancelled control task_failed01:22:17.404 and cleanup.node_marked_warm_direct01:22:19.925; source terminal-CANCELLED path setscompletedtrueaftercleanup. No later events through01:33, error-only node absent after normal DELETE01:31:26; this is qualified source/log evidence, not direct DO alarm storage or provider inventory. Visibility owns separate01:34–02:04 window; capacity makes no staging mutations/deployments in that window.

Final cancellation audit additionally reproduced grant racing cancellation and reviving an active admission, which mission concurrency counts even for a cancelled task. Retirement now terminalizes only its exact task/project/user/admission token for a non-executable task and repairs the task's admission mirror from that persisted terminal generation. It never uses an unfenced delete of all task leases. Real grant-race test observed RED1/43 at stale mirror before correction. Final focused suite51/51 PASS: partial admission-write success followed by mirror D1 failure replays without allocating; newer-token and executable same-token replacements preserve both task/admission rows byte-for-byte. Prior unchanged-source root lint13/typecheck19 and actual Workers52 PASS; full root tests/build are in progress, renewed final-source lint/typecheck/Worker/CI/staging required.

First renewed full root test run stopped20/21targets/API11415PASS+15FAIL:14 legacy node-provisioning/trigger/timeout fixtures used missing/draft task rows, now correctly seed queued tasks or exact authority-query mock; one architectural writer inventory did not yet account for cancellation strict teardown. Independent test-engineer review PASS for the narrow inventory entry permitting ONLY strict external-delete helper, with synthetic negative controls rejecting terminal node/workspace writes and broader teardown helpers. Four affected suites54/54 PASS. Runtime remains99857d4c8, no authority weakening or production changes. Fullquality restarts serial on final test fixtures; prior failed run is not counted as PASS.

Late ownership review confirmed same task can reactivate/adopt an already-paid host during awaited retirement. Node cleanup now atomically excludes every executable task owning the host, including the same stable task ID. Existing state writes were already attempt-fenced; completion and alarm deletion now occur in that same existing storage transaction, closing the separate deleteAlarm gap. Independent Cloudflare/security/constitution review PASS; admission52/52 independently rerun, combined admission+placement54/54 PASS. Discriminating controls preserve paid same-task host and entire replacement rows, and protect newer DO state/alarm whether reactivation occurs before or after the completion transaction. Final source and tests stable; full quality still running, actual Worker regression rerun and coordinated changed-path staging remain gates.


### Final reviewed source, quality and cancellation staging (02:55 UTC)

Final reviewed runtime/test candidate `bcd49ef50b578255af45991a3336360eb193d3d8`: source supersession fixes at `a659dfe8d`, then independently reviewed import-order-only correction. Full serial root lint13/13, typecheck19/19, test21/21 (API818 files/11,434 tests) and build9/9 PASS; post-import lint/typecheck32/32 targets PASS. Focused admission+placement54/54, final actual Workers52/52 PASS. Exact-source GitHub CI all PASS. Previous failed quality runs are historical, not counted as PASS.

Sole coordinator deployed isolated combined `4f4ffb2eb8d73e9a5c1d15155d77ec032c3f9da1`, preserving telemetry Go4f83 and visibility scope; all capacity runtime files, including TaskRunner index, match the reviewed source. Combined96/96 focused tests/API typecheck PASS. Deploy37403210993 attempt1 failed only API-token settings networkidle smoke timeout (11passed/1failed); authenticated pageHTTP200/no pageerrors and healthy API supported one failed-job-only retry. Attempt2 overallSUCCESS; no redeployment/code change or gate waiver. [Successful staging run](https://github.com/raphaeltm/simple-agent-manager/actions/runs/37403210993).

Verified coordinator release02:39:45 and firm cleanup03:09:45 INCLUDING late-allocation observation, ONEcx23 within originalEUR0.10 cap. Immediate globalnodes[]/pool3rev29; normal owned pool1/rev30 configured BEFORE launch. Native balanced ranking selected cx23priority0/2CPU4096MB40GB/EUR0.0088hour without candidate/strategy policy edits. Node01M47HEV6BAJFNK21SCTPT2ZKD/provider168953031 created02:42:35.851, exact Go4f83d6a7287c4c34fff480dc78cf9cac269840aa, observed heartbeat02:44:59.506 (not asserted first), ready02:46:41.880. No first-process-start timing claim is made.

Fixture01M47HEM416YNK40CTQT2G9DZ7/session3ec622b7-85de-46d1-8cb1-e0d4380fa745/workspace01M47HQDEYBRKANE3FH1YQ8DYD reserved625CPU/1152MB/13312disk. Actual assistant CAPACITY_CANCEL_FIXTURE_READY; canonical vm_report idle/completed, runtimeinactive/count0/promptNULL. Control01M47HWGMMMXP9510R6G9E73AM/session42a77eaf-a59d-4130-847d-5404ca81cd37 requested625CPU/3072MB/13312disk. Actual admission waiting_for_node_capacity/capacity_pool_node_limit rejected that same eligible/current host with exact “memory budget would be exceeded after host reserve”; usable3584MB/projected117.9%, workspaceNULL/attempts[]/notes[], no additional VM.

Normal control cancellation02:51:03.766 preceded fixture cancellation02:51:04.782 and canonical workspaceSTOPPED/reservations0 at02:51:12.253. Coordinator100%-sampled persisted Cloudflare logs prove task_runner_do.execution_authority_revoked02:51:44.950/stepnode_provisioning AFTER canonical reservation release. Control stays CANCELLED, terminal admission/mirror/retryNULL, no workspace/node/lease. Canonical release is distinguished from physical teardown: a stopped fixture container remained until strict owned-node DELETE; no earlier physical-absence claim.

Normal strict owned-node DELETE success gave retained workspaceDELETED/nodeNULL/runtime_deletion_proof=node_runtime_terminated at02:53:35.722. Zero nodes/reservations verified before normal originalpool3 restoration/rev31 at02:53:47.594. Final read02:55:47.300,119.706seconds after deletion/restoration, still globalnodes[]/leases[]/liveworkspaces[], controlCANCELLED/workspaceNULL/autonodeNULL. Coordinator independently corroborated zero, restored pool and CF no further provisioning through02:55:56. Shared staging RELEASED, all cleanup/observation completed before firm deadline. Provider absence is qualified through strict endpoint termination gate plus record absence, not independent provider inventory. No D1 writes, extra VM, quota/spending increase, evidence purge or independent deployment.

Additional VM billed conservatively as one full cx23 hourEUR0.0088; six rounded capacity-test hours total estimatedEUR0.0528 compute, within originalEUR0.10. Retained history/snapshot expiry is unchanged. Prior occupied incompatible-agent drain, busy preservation and exact uncommitted restoration remain valid; sibling PRs retain separate scopes. Final independent completion/doc-sync review PASS at bcd49ef50 and the final live receipts. CodeRabbit request/wait, normal merge and production deployment are next.


## CodeRabbit advisory-failure correction — 2026-10-06 03:42 UTC

Exact merged-head fc7cb5aeb CI37407198704 and E2E37407198699 PASS. PR left draft only after required gates passed; one trusted CodeRabbit label request03:28:06/workflow37409111252 SUCCESS. Review5423526441 at03:37:50 found one valid minor resilience issue4191294767: advisory drain candidate SELECT or final diagnostics could throw before the authoritative capacity wait, consuming transient step retries.

The catch now covers only requestIncompatiblePoolNodeDrain and logs its failure; required admission wait, scheduling and expiry remain outside the catch. Two new real TaskRunner alarm/schema-derived SQLite regressions failed before correction (no admission wait, retry budget consumed), then passed alongside prior tests56/56. Persistent candidate-query failures over four alarms preserve the original wait deadline/retryCount0 and allocate no node/provider; advisory diagnostics failure preserves its scheduled intent and subsequent required wait. Independent CF/safety and test-engineer reviews PASS.

Prior real occupied-old-agent drain, exact uncommitted restoration and final cancellation/cleanup receipts carry forward: this correction changes only advisory failure handling. Coordinator is arranging a pinned zero-extraVM deployment/health check; no independent deploy, provisioning or direct D1 writes. PR returned to draft pending updated full quality, exact-head CI, incremental CodeRabbit wait and final completion review.


## Preserve recovery authority through advisory failure handling — 2026-10-06 04:10 UTC

The9745 candidate passed final root quality (lint13,typecheck19,test21/build9; API819files/11,452tests), exact CI37410161617 and coordinator API-only staging37410500073/combined4ce47aa528076d871278610033d56aaa9d208369 SUCCESS. Coordinator primary CF deploymentaa0e5f3e/version4e88ddbc100%, healthy API/authenticatedSettings200/no pageerrors; root health200healthy04:01:33, paid/active nodes0 and leases0. Pool3/rev31 retained. One unrelated Sep13 node-less STOPPING workspace is historical with no live runtime; it was not mutated or presented as a new fixture.

Final adversarial review found the advisory catch could swallow the existing SessionRecoveryAuthorityRevokedError from the drain diagnostic's guarded storage write. Continuing into admission wait would mutate the newer same-task admission/mirror before the later storage guard rejected the old run. Importing that existing class and rethrowing it before the ordinary best-effort warning preserves the control-flow boundary. No changes to admission SQL, sleep budgets, quotas or sibling runtime.

A new real alarm/storage-transaction/SQLite regression commits a newer wake, token42 admission, entire task row and alarm after advisory D1 diagnostics but before the actual attempt-fence transaction read. The initial fixture referenced a nonexistent column; that initial failure is not a red proof. After correcting the fixture, removing only the authority rethrow produces valid RED (newer provisioning_granted admission overwritten to waiting). Restoring it gives57/57 focused tests PASS; entire newer admission/task rows, DO state and alarm remain unchanged, no node/provider allocation, preserved drain intent. Independent CF/safety, test-engineer and completion/doc-sync/constitution delta reviews PASS; initial catch-only approval is superseded for this edge.

PR2239 remains draft for final-source full quality/exact CI, sole-coordinator pinned zero-extraVM deployment/health and incremental CodeRabbit wait. Prior paid-VM success-path drain/restore/cancellation/cleanup evidence carries forward; no extraVM, live fault injection, D1 mutation or independent deployment.
