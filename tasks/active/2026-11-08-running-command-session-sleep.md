# Prevent sleeping sessions with commands still running

## Request and constraints

Task 01M6Y0Y2AXG9K755ZE2RG1SDCC; idea 01M6XYQFD4J74KJ69G43PTR39P.
Investigate production first. Preserve the 30-minute stale-turn default and existing two-hour work ceiling. Prove actual commands remain protected, hung turns expire, and finished work sleeps. Record decisions durably. Test one small staging VM with temporary short stale-turn setting; restore and delete resources. Open PR after targeted checks, merge only after gates, complete idea after merge.

## Evidence and unresolved questions

Affected session 948ffa93-12b3-497e-be38-43687e1450d0 used openai-codex. Production sleep traces: 2026-11-07 00:51:04.838Z,14:01:25.941Z;2026-11-08 14:21:13.708Z.
Each follows peer disconnect/LoadSession recovery (00:14:10.770Z,13:22:14.701Z;13:41:52.148Z). Pre-sleep activity callbacks show prompting, runtimeWorkState inactive/count0, progressAt1794010457253/1794057742563/1794145320756 respectively. Last reports observedAt1794012605132/1794060053791/1794147606664. Exact historical work_at, runtimeWorkUpdatedAt and classifier verdict are not recorded in snapshot traces; callback receipt/progress are evidence, not substitutes for missing stored decisions.
November8 workspace resource samples continue CPU after recovery (no per-process attribution, no cgroup OOM). Cannot infer a command's identity or result owner from CPU alone. Archived tool payload lookup returned no records for that window. Narrow node debug-package reads found no OOM/panic matches; downloaded raw package must be deleted before finish.

Trace: ACP SessionUpdate → applyACPToolCallLifecycle → harnessWorkSnapshot → reportActivity → activity HTTP callback → ProjectData session_state/work clock → checkAutomaticSessionSleepEligibility/classifySessionIdleness → snapshot teardown gates. Runtime restart resets the tool set; crash recovery currently completes the attempt with recovered and reports idle. Confirmed: recovery failed to stop the interrupted prompting rereporter, allowing stale callbacks to overwrite recovered idle. Regression fails before the fix and passes afterward.

## Preflight

Classes: cross-component-change, business-logic-change, infra-change, docs-sync-change.
No new external service or trust boundary planned. Reuse existing harness lease, canonical classifier, bounded diagnostic retention. No default increase. Root cause remains unconfirmed; implementation must follow evidence.
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
- [ ] Local specialist reviews and completion validation.
- [ ] Coordinate staging, one small VM, short stale-turn setting, actual runtime test.
- [ ] Restore settings, delete resources; record evidence.
- [ ] CI, CodeRabbit request/wait, resolve findings, merge, production deploy/basic smoke.
- [ ] Update and complete idea only after merge; report task completion.

## Concrete validation hazard found (17:31 UTC)

`TestCodexC2CandidateProcessCleanupSignalsActualArgv` globally ran `pkill -TERM/-KILL -f` against the exact installed Codex adapter/CLI release paths. A read-only `/proc` match confirms those patterns match this live task's adapter and CLI. This hazard was introduced November6 #2556, before all three episodes. The affected branch records Go validation, but the exact historical invocation is still unavailable; do not claim all three disconnects are conclusively attributed to this test.

Fix: constrain the test's pkill to direct children of its own test process. Add an identical-argv runtime under a different parent and prove it survives; keep TERM/KILL and regex-escaping positive controls. Run the unsafe mutation ONLY in a disposable Docker PID namespace. Native pinned-command probe now executes this validation test in a subprocess while its actual quiet command is held; the command must retain ownership/results and its lease through the resolved30m stale bound (accelerated policy clock), then sleep15m after completion.

Recovery ghost-reporter regression: original code FAILED `TestSessionHost_CodexCrashRecoveryStopsInterruptedPromptReports` because recovered idle was overwritten by prompting. Fixed test PASS; local Go reviewer race test PASS3repetitions. Native uninterrupted+validation-cleanup callback→DO→sweep test PASS locally using installed C2.3adapter/Codex0.160.0; default stale resolver30m exercised. Existing hung-turn+idle integration controls PASS15tests. API typecheck PASS. Reviews acknowledge original historical command-ownership gap; final completion review remains outstanding.

## Native reproduction and review (17:48 UTC)

PR: https://github.com/raphaeltm/simple-agent-manager/pull/2585 (early-open; release gates pending).

The actual pinned adapter/CLI probe holds a quiet `exec_command`, runs the validation cleanup concurrently, and requires its result to reach the model. Inside a disposable Docker PID namespace with networking disabled and runtime mounts read-only, safe version PASS1.58s. Removing only the `-P <testPID>` fence FAIL1.22s with `peer disconnected before response`, followed by recovery Stop. This reproduces the production sequence including the misleading later process-exit timestamp. The installed runtime is C2.3 adapter / CLI0.160.0. The probe explicitly selects real ACP full-access mode; the initial isolated failure was missing Docker bwrap, not the product bug. No unsafe mutation was executed in the live workspace PID namespace.

Local vertical slice command: `SAM_PINNED_CODEX_ADAPTER=/opt/sam-codex-c2/current/bin/codex-acp SAM_PINNED_CODEX_CLI=/opt/sam-codex-c2/current/bin/codex pnpm --filter @simple-agent-manager/api exec vitest run tests/integration/session-sleep-pinned-command.test.ts tests/integration/session-sleep-idle-reports.test.ts tests/unit/durable-objects/session-stale-turn-sleep.test.ts`. Real command/reporting, HTTP callback, real DO writer and real sleep sweep use an accelerated policy clock; the authenticated route is a fixture boundary. The default30m is resolved through admin settings; command holds at31m, results return, idle sleep occurs15m later. Hung no-command and2h ceiling controls remain intact. Native probe cleanup now kills/reaps only its dedicated process group and waits for actual live members to disappear; three independent native tests passed after fixing a temporary-directory shutdown race.

Local API reviewer PASS (11tests including required-sleep diagnostic and no runtime-read control). Go/lifecycle reviewer ADDRESSED (process ownership, recovery ticker and test cleanup). Completion reviewer now accepts reproduced condition/vertical slice; final release/staging gates pending. Exact historical payload attribution to all3 incidents remains unconfirmed.

Staging coordination: another agent testing branch sam/remove-legacy-hosted-saas-hest08 requested10–15minutes at17:45UTC before releasing shared staging. No staging mutations/resources created by this task yet.
