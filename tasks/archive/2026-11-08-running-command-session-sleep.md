# Prevent sleeping sessions with commands still running

## Request and constraints

Task 01M6Y0Y2AXG9K755ZE2RG1SDCC; idea 01M6XYQFD4J74KJ69G43PTR39P.
Investigate production first. Preserve the 30-minute stale-turn default and existing two-hour work ceiling. Prove actual commands remain protected, hung turns expire, and finished work sleeps. Record decisions durably. Test one small staging VM with temporary short stale-turn setting; restore and delete resources. Open PR after targeted checks, merge only after gates, complete idea after merge.

## Evidence and unresolved questions

Affected session 948ffa93-12b3-497e-be38-43687e1450d0 used openai-codex. Production sleep traces: 2026-11-07 00:51:04.838Z,14:01:25.941Z;2026-11-08 14:21:13.708Z.
Each follows peer disconnect/LoadSession recovery (00:14:10.770Z,13:22:14.701Z;13:41:52.148Z). Pre-sleep activity callbacks show prompting, runtimeWorkState inactive/count0, progressAt1794010457253/1794057742563/1794145320756 respectively. Last reports observedAt1794012605132/1794060053791/1794147606664. Exact historical work_at, runtimeWorkUpdatedAt and classifier verdict are not recorded in snapshot traces; callback receipt/progress are evidence, not substitutes for missing stored decisions.
November8 workspace resource samples continue CPU after recovery (no per-process attribution, no cgroup OOM). Cannot infer a command's identity or result owner from CPU alone. Archived tool payload lookup returned no records for that window. Narrow node debug-package reads found no OOM/panic matches; downloaded raw package and private transcript extracts were deleted.

Trace: ACP SessionUpdate → applyACPToolCallLifecycle → harnessWorkSnapshot → reportActivity → activity HTTP callback → ProjectData session_state/work clock → checkAutomaticSessionSleepEligibility/classifySessionIdleness → snapshot teardown gates. Runtime restart resets the tool set; crash recovery currently completes the attempt with recovered and reports idle. Confirmed: recovery failed to stop the interrupted prompting rereporter, allowing stale callbacks to overwrite recovered idle. Regression fails before the fix and passes afterward.

## Preflight

Classes: cross-component-change, business-logic-change, infra-change, docs-sync-change.
No new external service or trust boundary planned. Reuse existing harness lease, canonical classifier, bounded diagnostic retention. No default increase. The cleanup-trigger defect is reproduced; attribution of every historical episode remains unconfirmed.
Existing managed workspace is on the assigned output branch; preserve startup .codex/config.toml change. Task artifact stays on assigned branch rather than switching this live managed workspace to main.

## Checklist

- [x] Read idea, task instructions, prior implementation context, and production story.
- [x] Correlate all three sleeps with pre-sleep activity callbacks and crashes.
- [x] Identify command payloads/lifetimes and exact reporting failure, or explicitly establish missing evidence and reproduce via real runtime.
- [x] Fix evidenced condition and preserve bounded sleep controls.
- [x] Persist sleep decision reason and relevant clocks through existing diagnostic surface.
- [x] Real reporting-path regression and hung/finished controls, defaults via resolver.
- [x] Guard-removal proof for each added guard.
- [x] Targeted checks, push, early PR; full suites in CI.
- [x] Local specialist reviews; final completion/archival validation follows staging cleanup.
- [x] Coordinate staging, one small VM, short stale-turn setting, actual runtime test.
- [x] Restore settings, delete resources; record evidence.
- [x] CI, CodeRabbit request/wait, resolve findings, and merge.
- [ ] Production deploy completion and basic smoke.
- [ ] Final merged-idea update and task completion after deployment verification.

## Concrete validation hazard found (17:31 UTC)

`TestCodexC2CandidateProcessCleanupSignalsActualArgv` globally ran `pkill -TERM/-KILL -f` against the exact installed Codex adapter/CLI release paths. A read-only `/proc` match confirms those patterns match this live task's adapter and CLI. This hazard was introduced November6 #2556, before all three episodes. The affected branch records Go validation, but the exact historical invocation is still unavailable; do not claim all three disconnects are conclusively attributed to this test.

Fix: constrain the test's pkill to direct children of its own test process. Add an identical-argv runtime under a different parent and prove it survives; keep TERM/KILL and regex-escaping positive controls. Run the unsafe mutation ONLY in a disposable Docker PID namespace. Native pinned-command probe now executes this validation test in a subprocess while its actual quiet command is held; the command must retain ownership/results and its lease through the resolved30m stale bound (accelerated policy clock), then sleep15m after completion.

Recovery ghost-reporter regression: original code FAILED `TestSessionHost_CodexCrashRecoveryStopsInterruptedPromptReports` because recovered idle was overwritten by prompting. Fixed test PASS; local Go reviewer race test PASS3repetitions. Native uninterrupted+validation-cleanup callback→DO→sweep test PASS locally using installed C2.3adapter/Codex0.160.0; default stale resolver30m exercised. Existing hung-turn+idle integration controls PASS15tests. API typecheck PASS. Reviews acknowledge original historical command-ownership gap; final completion review remains outstanding.

## Native reproduction and review (17:48 UTC)

PR: https://github.com/raphaeltm/simple-agent-manager/pull/2585 (early-open; release gates pending).

The actual pinned adapter/CLI probe holds a quiet `exec_command`, runs the validation cleanup concurrently, and requires its result to reach the model. Inside a disposable Docker PID namespace with networking disabled and runtime mounts read-only, safe version PASS1.58s. Removing only the `-P <testPID>` fence FAIL1.22s with `peer disconnected before response`, followed by recovery Stop. This reproduces the production sequence including the misleading later process-exit timestamp. The installed runtime is C2.3 adapter / CLI0.160.0. The probe explicitly selects real ACP full-access mode; the initial isolated failure was missing Docker bwrap, not the product bug. No unsafe mutation was executed in the live workspace PID namespace.

Local vertical slice command: `SAM_PINNED_CODEX_ADAPTER=/opt/sam-codex-c2/current/bin/codex-acp SAM_PINNED_CODEX_CLI=/opt/sam-codex-c2/current/bin/codex pnpm --filter @simple-agent-manager/api exec vitest run tests/integration/session-sleep-pinned-command.test.ts tests/integration/session-sleep-idle-reports.test.ts tests/unit/durable-objects/session-stale-turn-sleep.test.ts`. Real command/reporting, HTTP callback, real DO writer and real sleep sweep use an accelerated policy clock; the authenticated route is a fixture boundary. The default30m is resolved through admin settings; command holds at31m, results return, idle sleep occurs15m later. Hung no-command and2h ceiling controls remain intact. Native probe cleanup now kills/reaps only its dedicated process group and waits for actual live members to disappear; three independent native tests passed after fixing a temporary-directory shutdown race.

Local API reviewer PASS (11tests including required-sleep diagnostic and no runtime-read control). Go/lifecycle reviewer ADDRESSED (process ownership, recovery ticker and test cleanup). Completion reviewer now accepts reproduced condition/vertical slice; final release/staging gates pending. Exact historical payload attribution to all3 incidents remains unconfirmed.

Staging ownership was coordinated with the previous tester before deployment; final restoration and release are recorded below.

## Staging verification (release gate in progress)

Deploy Staging42507017851 passed for e178684e4. Cloudflare deployment is100% version1bee7b6d-5cd3-4294-8d3f-14cba293bc5a, annotation commit:e178684e4ad0791b1bed1ddf6b04689de6726a3c. VM binary reports250fe3f80841fcadf38513ca865d560429021fcd: this is the last production Go change; later commits modify tests only, verified by diff. Browser token-login and dashboard Welcome/project/settings navigation passed without page errors. Staging health healthy. Noise checkD1 passed; telemetry API403 was unavailable, explicitly skipped.

One Hetznercx23 node01M6Y58VQD7919THY3A0PT928D (2vCPU/4GB) created18:03:32, observed rate€0.0088/hour. Same VM used throughout. Settings: operations.sessionStaleTurnNoWorkMinutes changed from30 default/unconfigured to3 database override at revision21,18:14:12.987Z; restored to30/default/unconfigured after the test.

The initial manual workspace/session fixture was invalid for sleep proof: create-agent-session followed by WebSocket select_agent did not establish a ProjectData ACP binding, so its real command execution/transcript did not establish valid stored activity. Container initially had Node20.20.2; official Node22.23.4 tarball was verified against published SHA256 and installed only in the disposable environment. Failed initialization leaves a stopped VM session despite running D1 status; verified409session_not_running before creating a replacement. The manual command returned its result and its workspace01M6Y58W3G3YHM3NAAW15QQ9CB was deleted18:36. Follow-up for binding gap: idea01M6Y7SPRF03YQD1XJZC3EHY7R. No product changes added for this fixture gap.

Canonical test used tasks/submit with exact preferred nodeId (no fallback provisioning), small reservation and lightweight Node22 workspace. Task01M6Y6YV336FM47NB0FCD4PRDN, chat43219f40-0240-4bac-a358-1c0184159bf4, workspace01M6Y6Z47ZMKK3JDH18CW0S8CH, ACP01M6Y705486MVG0V5V97MZZ3NQ. Actual Codex exec `sleep540; printf SLEEP2585_CANONICAL_DONE` started18:34:22.606 and completed18:43:22.458 UTC (9minutes). Its result reached the model. Stored activity remained prompting/runtime active/count1/acp_tool_call beyond the3-minute bound and across cron epochs. Agent progress messages renew workAt and clear sleep intents; therefore the staging run is not an isolated stale-lease classifier oracle. The local native fixed-progress31-minute sweep is that discriminating oracle. A snapshot intent was discovered18:37:17 and cleared by later real chat progress; do not claim an unobserved persisted deferral.

On completion, stored activity became idle/inactive/count0. Runtime updatedAt1794163405093, progressAt1794163402458, workAt1794163405311 (18:43:25.311Z). Task conversation remains in_progress/awaiting_followup. Persisted snapshot01M6Y76NDKHFS2M04QS1R4RGDN schedules sleep18:58:32.809Z, the normal15-minute completion schedule. Automatic eligibility at19:01:54.367Z recorded source=session_sleep, decision=sleep_eligible, reason=idle, requirement=normal and all activity/work/runtime clocks above. Task and snapshot were observed sleeping by19:02:22; workspace GET returned404 after automatic teardown. The normal15-minute delay plus the next sweep elapsed. Admin setting restored to30/default/unconfigured19:02:46. Owned resource deletion verified19:03:30: node absent from API list and both workspaces404. Both test tasks deleted. Test browser session invalidated by sign-out. Staging handed directly to PH2HVP/PR2582, with coordinator copied. Single cx23 used about1hour at€0.0088/hour; incremental compute under€0.02, below€0.05.

## CI and follow-ups

1127c2222 fixes the sole failure among15697 API tests: a legacy test banned all D1 prepare calls instead of child-lineage reads; it now asserts the intended diagnostic insert and forbids lineage queries. Targeted file44/44 pass; no runtime change. FullCI on latest head is pending. An unrelated npm fixture failed before SAM installer code and passed one unchanged retry; actual baseline runs also passed. Tracked as idea01M6Y7R8P8TEVKK4QF6SJ5HRQR.

Coordinator reviewed the source and requires PR2585 remain DRAFT with needs-human-review until approval names the exact final head SHA. Coordinator alone marks ready. No merge or idea completion before that approval and remaining gates. Adjacent production container-wide pkill risk is confirmed by code (default10 sessions/workspace share a container); tracked separately as idea01M6Y51G87JNWZ6CGX4ET7EBF3, explicitly non-blocking by coordinator.

3254a8bd5 corrects the native probe's POSIX path quoting. The real pinned runtime test passed with a temporary path containing spaces, an apostrophe and a dollar sign. No production runtime change after the staging deployment. Final implementation review found no additional technical blocker; release gates remain pending. Raw diagnostic archives, private transcript extracts and unsafe mutation binaries/source were deleted. Private browser state was invalidated; the private staging auth/transcript directory was removed after evidence capture.

## Final implementation audit

Completion validator PASS for implementation/verification: research, diff, controls, real reporting vertical slice and staging cleanup. Archive records implementation evidence only; unchecked release gates above remain pending. Coordinator explicitly accepts local fault-injection proof for recovery. Staging did NOT exercise the stale-turn bound (chat renewed workAt) or crash-recovery ghost-heartbeat shutdown; those are local proofs only. The quiet540 result and subsequent normal idle sleep with durable eligibility clocks are the staging claims.

## Final scanner follow-up

Full technical CI/E2E passed on0f4f571493c1be21d3523c5286e505e2c44034b5; the only red check is the coordinator hold. CodeRabbit trusted request42515457739 succeeded19:31:28 and returned rate-limited/no review. Sonar quality gate passed, but inspection of its issue API found two cognitive-complexity findings (17/19 versus15) in the native Go probe. Small test-only helper extractions separate validation orchestration and per-PID parsing without changing behavior or ownership. Native quiet-command/cleanup/recovery tests passed2.817s and the actual native API vertical slice passed7.12s after extraction. Go reviewer approved the diff. Final-head scanner/CI reconciliation follows before approval. Production runtime remains identical to the verified staging deployment.

## Merge and release evidence

Coordinator task01M6SHDRB60F28XPA14C7J9XKZ approved exact headb41dc16f4ac82987d1f8d55fc3f1434efad854f8 in durable eventdfc492e8-426e-47ad-8f2b-ea3fb14697db and explicitly delegated ready/hold release. Closing/reopening refreshed the frozen-label evidence gate without changing the commit. Refreshed CI42519601375 and E2E42519601273 passed, including Specialist Review Evidence. Sonar reported zero open issues. CodeRabbit request/wait completed; readiness/reopen requests were also rate-limited. Immediately before merge, reviews and threads were empty and the approved head was unchanged/mergeable.

PR2585 merged2026-11-08T20:42:44Z as9caf8c0c2848fb58b019a686bcf9283dcb028469. Main CI42521511417 passed. Its deployment candidate42523060361 failed closed before mutation because main advanced to direct descendantf375bf66f32f42fa41099d603b704f7d9dd22db3 (#2590), verified to contain9caf. Descendant CI42521887015 attempt1 failed one existing direct-provisioning-do.test.ts waitFor race (792 other shard tests passed); the #2590 owner started attempt2 and filed the flaky test in draft PR2592. No duplicate retry or older-candidate override was started by this task. Deployment completion and basic smoke remain pending; this separate draft evidence PR remains for coordinator review, with no direct-to-main commit.
