# L19: guided-setup teardown robustness (self-host landing slice, Cloudflare part)

SAM task `01M7M9FHH6VPWVFTVB6P8X230P`; idea `01M72M9AEB933ZY8269D376DKC` (landing plan parts 2 and 6, change C14);
coordinator task `01M7JMXS2JRW6QQMB1356ENPM3`; channel `feature.selfhost-landing`.

## Problem

`CredentialSetupSession` teardown (`apps/api/src/durable-objects/credential-setup-session/index.ts`)
claims the terminal status in DO SQLite, then awaits the sandbox scrub, the destroy and the pool
release, and only then writes D1. An isolate that dies during that sandbox I/O leaves:

- the D1 row active, so the create route's one-active lookup keeps returning the dead session
  until the cron sweep finds it;
- the pool slot leased and the container alive, with no alarm to finish the cleanup (teardown
  deleted nothing yet, but nothing resumes it either).

A teardown that starts from `provisioning` (cancel during start, or the start itself failed) also
execs `rm -rf` into a container that never started. On Cloudflare that exec makes the SDK start
the container again and wait out its start retries before the destroy runs.

The integration branch `sam/selfhost-pass-2` fixed all three (commits 30c1b1840, f0743271f,
a5bce064e, acf865e32). This slice ports the part that matters on Cloudflare.

## Scope decision (Raphaël's 2026-11-14 rule: no dormant self-host code in the Worker)

| Branch change                                                                                              | Ported?            | Why                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Teardown reorder: D1 terminal before sandbox I/O, `cleanup_pending` marker, recovery alarm, bounded resume | Yes                | Isolate death mid-teardown happens on Cloudflare too                                                                                               |
| Skip scrub when teardown starts from `provisioning`                                                        | Yes                | On Cloudflare the exec restarts a never-started container; destroy removes the filesystem anyway                                                   |
| Skip scrub on a resumed cleanup                                                                            | No (review M2)     | celld-only reasoning; on Cloudflare the container outlives the dead isolate, so a resume must still scrub the captured credential                  |
| Bound the scrub exec with `withTimeout`                                                                    | Yes                | The exec timeout does not cover the SDK's container start before it                                                                                |
| Alarm joins an inline cleanup instead of running a second one                                              | Yes (bounded join) | The recovery alarm fires at `capture_poll_ms` (3 s), usually while the inline cleanup is running (rule 45)                                         |
| Alarm stops waiting after `2 x exec timeout + 30 s` (`settleSharedFlight`)                                 | No                 | Only celld drops a request's sandbox calls; Cloudflare uses its recovery-step budget for the inline join, with an immutable uncertainty watchdog   |
| `sandbox_runtime_unavailable` for the SDK's permanent start error                                          | Yes                | The SDK itself answers 500 with that message for Cloudflare permanent failures (`no such image`, `no application that matches`, OOM)               |
| `SandboxDO` subclass, `sandbox-startup-errors.ts`, `ctx.container.monitor` tee and its 2 s / 20 ms poll    | No                 | Every matched fragment is a Docker / celld / sam-docker-proxy string; on Cloudflare every answer passes through unchanged. Self-host build owns it |
| `platform-capabilities` gating in `sandbox.ts` / route                                                     | No                 | Belongs to other slices (platform capabilities), not C14                                                                                           |

## Research findings

- `pnpm quality:do-migration-safety` does NOT scan `credential-setup-session` (excluded in
  `scripts/quality/check-do-migration-safety.ts` because its dynamic D1 `UPDATE ... SET ${...}`
  false-positives). So the branch's constructor `PRAGMA table_info` + guarded `ALTER TABLE ADD
COLUMN` would ship unscanned. Fix: move all DO-SQLite DDL into
  `credential-setup-session/schema.ts` and add that file to `DO_MIGRATION_FILES`.
- `index.ts` is 754 lines; the port adds ~200 → over the 800 hard limit (rule 18). Split: schema
  - row types into `schema.ts`, D1 status writer into `d1-status.ts`, sandbox/pool cleanup steps
    into `cleanup.ts`.
- New Env scalars fail `pnpm quality:runtime-tunables`. The initial port reused existing
  tunables: recovery alarm delay = `SETUP_SESSION_CAPTURE_POLL_MS` (per-session
  `capture_poll_ms`), scrub bound = `SANDBOX_EXEC_TIMEOUT_MS`. The recovery-attempt cap (3) is a
  crash-loop circuit breaker, exported as `DEFAULT_SETUP_SESSION_MAX_CLEANUP_RECOVERY_ATTEMPTS`.
- Rule 81: the monitor poll is not ported, so the per-start cost on Cloudflare is zero. Recovery
  cost: default3/maximum10 work attempts per failed/interrupted teardown plus at most two successful-phase continuation passes and one final metadata assessment, each one cached/bounded settings read, scrub + destroy (default5s each, max10s each), release + D1 repair, followed on exhaustion by one quarantine/observability write. No new remote settings reads per start. SDK tracking adds two local SQL counter writes per chain; at most two polling chains/four writes per poll (~1,200 over default15min TTL/3s polls), plus finite provisioning/verification/scrub chains.

## Implementation checklist

- [x] Split commit: `schema.ts` (DDL + row types), `d1-status.ts` (D1 status writer) with no behaviour change
- [x] Add `schema.ts` to `DO_MIGRATION_FILES`; scanner test asserts it is scanned and passes
- [x] Additive cleanup columns via PRAGMA + literal guarded `ALTER TABLE ADD COLUMN` in `schema.ts`
- [x] Teardown: required alarm + synchronous claim/`cleanup_pending` + D1 terminal before any sandbox I/O
- [x] `cleanup.ts`: scrub (skipped only on initial `provisioning` cleanup; resumed cleanup scrubs unless destruction was durably confirmed; bounded), destroy, release, D1 repair (`onlyIfActive`), clear marker + alarm
- [x] Alarm: terminal row with `cleanup_pending = 1` resumes cleanup; joins inline flight; capped attempts
- [x] `withTimeout` exported from `services/sandbox.ts`
- [x] `sandbox_runtime_unavailable` for the SDK permanent start message (constant in `credential-setup-config.ts`)
- [x] Port `credential-setup-session-teardown.test.ts` (real SQLite DO + D1, real create route) minus celld-only cases; update fake SQL in existing tests
- [x] Prove guards discriminating (D1-first ordering, scrub skip, join, attempt cap)
- [x] Docs: check public docs for guided login error codes

## Acceptance criteria

- [x] A teardown interrupted after the claim leaves D1 terminal and the create route starts a fresh session (test)
- [x] A restarted instance finishes an interrupted cleanup on its alarm; the next alarm is a no-op (test)
- [x] An alarm during an inline cleanup does not run a second destroy/release (test)
- [x] Recovery gives up after the cap instead of re-arming forever (test)
- [x] Teardown from `provisioning` does no scrub exec; still destroys and releases (test)
- [x] The SDK permanent start message maps to `sandbox_runtime_unavailable`; other errors keep `sandbox_provision_failed` (test)
- [x] `quality:do-migration-safety` scans the constructor DDL
- [x] Staging: Instant session gets an agent reply; Q1 guided Codex login shows verification URL/code, cancellation immediately terminalizes D1, clears DO cleanup and releases pool slot, and a new attempt starts; Q2 cancellation during provisioning shows terminal UI immediately and logs `credential_setup.scrub_skipped` (coordinator accepted 2026-11-17 12:25 UTC; SDK permanent-start mapping covered by contract test; no throwaway image deploy)

## Review-driven changes (Phase 5)

The following sections preserve historical checkpoints. Their pending statements are resolved by the final continuation evidence at the end.

- cloudflare-specialist M1 / validator: the recovery alarm could start a second cleanup while
  teardown's claim-time D1 write was in flight (`cleanupInFlight` was set only after it).
  Fixed: `trackCleanup()` registers the whole post-claim run before the first await. Test:
  "an alarm that fires during the claim-time D1 write joins the teardown" (red on old ordering).
- cloudflare-specialist M2: resumed cleanup now scrubs (see scope table).
- test-engineer: claim guard, claim-time alarm, `device_auth_details` delete, `saving` early
  return, TTL expiry and legacy terminal rows now have discriminating tests; the join test no
  longer sleeps on the wall clock.
- test-engineer: the DO migration scanner missed a single-quoted `DROP TABLE` after an
  apostrophe in a comment (per-quote-style regexes paired delimiters globally). Replaced with a
  comment-aware tokenizer; it extracts 65 more real SQL lines in existing migration files, all
  still passing; regression test is red on the old extractor.

## Continuation review fixes (task 01M7NBJ5EH19V5SV26NFJFJ6GM)

- [x] Merge origin/main including safe-deploy #2841 (`0c672ddbf`); secret-readback guard passes.
- [x] Codex P1: resumed cleanup from provisioning must scrub because a driver-start exec can still be in flight when cancellation claims the status. Regression fails with the old predicate.
- [x] Codex P1: regex literals can contain comment-looking text; use the existing TypeScript parser for SQL extraction. Regression and real file scanner test prove a same-line DROP is detected.
- [x] Codex P2: failed destroy, pool release, or D1 repair retains cleanup owed; exhausted recovery retains that marker and persists an operator-visible error while stopping automatic retries. Pool leases independently expire at next admission (default TTL + buffer = 20 minutes); Sandbox SDK defaults stop idle containers after 10 minutes.
- [x] Verify failed inline cleanup re-arms after an alarm joined the in-flight attempt (controlled regression red before fix).
- [x] Complete fresh delta specialist reviews, final local checks and current-head CI (230d64574: full CI44189930037 and E2E44189930159 SUCCESS).
- [x] Complete agreed live checks, clean fixtures and release staging lease.
- [x] Observe coordinator's production #2841 merge-hold-lifted message before normal merge (be50db76, production44174587033 SUCCESS).

- [x] Later Codex P2: persist successful sandbox destruction before pool/D1 I/O; recovery skips scrub and destroy once proven, so it cannot recreate a destroyed container. Nullable additive `cleanup_sandbox_destroyed` column is migration-scanned; interrupted-release regression was red before fix. Legacy NULL retains conservative scrub/destroy behavior.

- [x] Historical Codex P2 (initial-arm behavior superseded by the required-wake fix below): resumed cleanup and failed-cleanup rearm are best-effort; three boundary regressions failed before fix and now pass (teardown suite27/27).

- [x] Sixth Codex P2: dedicated admin setting `credentialSetup.cleanupRecoveryStepTimeoutMs` (default5s, max10s per sandbox step) for recovery scrub/destroy, including SDK acquisition. Inline retains30s. Recovery alone adds cached settings read, max3attempts. Timer regression proves old30s behavior fails at5s; late acquisition must not start a fresh exec after timeout/destruction.

Final continuation local evidence: full API run completed1093passingfiles/16715passingtests; its12failures were3intentional pre-fix alarm regressions plus9old fake-SQL destruction-marker misclassifications, all subsequently green in teardown/nativefocusedruns. Native route suite12/12passes. Final timeout/config/teardown suites62/62pass with two discriminating red proofs. Root lint22/typecheck36/build18passed; final APItypecheck/scopedlint/runtime-tunablespass. Two unrelated webfiles39/39pass isolated after broad-loadtimeouts; infra75/75pass isolated. CI and live staging remain binding.

## Final SDK-flight and mirror follow-ups

- [x] Durable nullable `cleanup_scrub_state` records needed/uncertain/successfully-scrubbed work. A deadline cannot prove SDK cancellation; pending work prevents destruction proof, slot release and clearing the cleanup obligation. Original settlement is registered with `waitUntil`; eviction remains uncertain and reaches the existing bounded quarantine. Late settlement never resets the attempt cap.
- [x] A durable SDK-flight counter covers provisioning, device-state polling, verification-code writes, credential reads and scrub. Each original chain owns one increment/decrement; overlapping calls cannot clear each other's obligation. Every SDK await is followed by an authoritative status check before further SDK work. Fresh sessions initialize the counter to zero; legacy NULL remains conservative.
- [x] All active D1 transitions are active-only writes. A delayed admitting write cannot resurrect a row after cancellation, even before recovery repair.
- [x] Recovery D1 repair and pool release use the same short configurable deadline as scrub and destroy. Four remote waits total at most 20 seconds by default/40 seconds maximum per attempt, plus the existing bounded settings read. The quarantine alert is background work after its durable disposition.
- [x] Final focused suites: teardown40/native12/existing30/admin3 =85/85; scanner15/15; API TypeScript/scopedESLint/migration safety/runtime-tunable/secret-readback checks pass. Surgical D1 guard, overlap counter and settlement-cap mutations each reproduced the intended regression before restoration. Tests also cover all four provisioning await phases, legacy rows, late scrub settlement, eviction and actual recovery timers.
- [x] Independent Cloudflare/security/constitution and test/completion/public-doc reviews PASS for this implementation delta. Final current-head CI remains required.
- [x] Agreed live staging checks, fixture cleanup, lease release and coordinator merge-hold release completed in final continuation verification below; all owned resources cleaned.

## Sonar follow-up

Sonar's green aggregate still exposed four open findings through its PR issue API. Cleanup and scanner orchestration now use small named step/check helpers; the reason ternary uses explicit returns and active-status membership uses typed `includes`. No matching rule, await order, timeout or lifecycle behavior changed. API82/82 and scanner15/15 pass; exact scanner output matches the prior version on48fixtures plus all5repository migration files. TypeScript/scopedlint/format/diff checks and independent CF/security/test-completion extraction review PASS. Refreshed current-head Sonar analysis remains required.

## Pending-work watchdog and scrub-success review fixes

- [x] Pending-only alarms do not consume the snapshotted recovery work attempts (default three, configurable1–10). A single immutable watchdog uses the later of session expiry and teardown time plus configured interactive timeout and one poll. Original settlement schedules prompt recovery; expiry or invalid clocks quarantine once with the obligation retained.
- [x] D1 terminal repair runs before pending deferral; a fresh post-await local row read prevents a stale watchdog from replacing the settlement wake. Actual attempt claiming follows deferral.
- [x] Only SDK success=true plus exitCode0 records successful scrubbing. Rejection, unsuccessful result and nonzero exit reset to retryable NULL; if destruction also fails, recovery retries the scrub.
- [x] Two pre-fix red proofs reproduced budget spending and false scrub success. Final teardown47/47 and existing30/native12 pass; admin3 unchanged from prior validation. Secret-readback guard reports zero findings. Independent Cloudflare/security/constitution delta review PASS.
- [x] Four new minor scanner RegExp.exec suggestions addressed without changing regex behavior; scanner15, five real files and48-fixture output parity pass.
- [x] New candidate CI/Sonar and live staging gates completed; see final continuation evidence.

## Alarm wake, original destruction and configurable retry policy

- [x] Alarm completion verifies a durable future wake while nonquarantined cleanup remains owed; missing or unknown alarm state throws for Cloudflare native bounded retries (up to six). Inline terminal/resource cleanup remains best-effort. Abrupt alarm termination is retried by the platform; no sweep selection is widened.
- [x] Original destruction is tracked across acquisition and raw SDK completion, including beyond the helper's former hidden30s timeout. Only original success plus durable proof permits settlement. Failed proof writes preserve uncertainty; late success cannot restart a destroyed sandbox.
- [x] Operations cleanupRecoveryMaxAttempts default3/range1–10; first recovery snapshots its cap. Existing legacy attempts retain3; alreadyquarantined legacy rows cannot revive. Both settings share one cached override read; inline starts add no remote settings reads. Maximum remote wait budget500s/default110s including two one-use success continuations across the episode, plus bounded settings reads and final local alarm lookup.
- [x] Independent CF/security/constitution/doc review PASS; config10/10 and existing/native42/42 pass. Destroy race RED reproduced premature pool release after5s. Latest abeebb142 actual Sonar issues0/hotspots0 and E2EsmokeSUCCESS.
- [x] Final regressions/quality checks, CI, live staging and production hold release completed; see final continuation evidence.

Final latest delta evidence: teardown56/56 +existing30/native12 +recoveryconfig10 =108/108 pass. Real helper observes original SDK destruction beyond35s. Root surgical removal of the alarm-finally wake assertion reproduces the failed rejection expectation (.tmp/l19-alarm-wake-red.log); assertion restored and targeted green required. Independent source/security/CF/doc reviews PASS.

## Finalization proof and initial wake follow-ups

- [x] Resumed provisioning always scrubs unless successful scrub or destruction is proven. A settled SDK call can have launched a background driver; zero pending calls is not evidence of an empty credential directory.
- [x] Late positive original scrub/destruction grants a one-use continuation credit, atomically with its proof; consumption precedes any new attempt. At most two successes/credits exist per episode; failures grant none and quarantine remains final. Five pre-fix regressions failed while late-failure controls passed.
- [x] Required initial alarm precedes terminal claim, after in-flight registration. A failed arm leaves DO/D1 active and eligible for the existing sweep; no UI retry assumption or sweep widening. Fresh state after arming preserves cancellation's saving commit boundary; joined finalizers re-evaluate their own terminal intent.
- [x] Independent source/CF/security review PASS. Existing/native42/42 pass; final teardown race suites remain pending.

Latest final delta local verification: teardown66/66 +existing30/native12 +config10=118/118 PASS. Requiredinitialarm surgical mutation was RED (cancel improperly resolved), restored targeted test GREEN. Realcapture saving-race and concurrentarming joins covered. All latest source/CF/security/doc reviewers PASS; TypeScript/lint/format/migration/secret guards PASS. NewheadCI/live gates remain mandatory.

## Final D1 reconciliation follow-up

A new P2 reproduced false quarantine when D1 repair succeeded after the last sandbox attempt. Successful original destruction now grants its one metadata completion credit even when timely. Proven-destroyed sessions reconcile bounded D1/pool work before the failure-budget gate, clearing pending on success; failed metadata passes consume the same bounded budget, with no new SDK work or quarantine revival. This also covers D1 failing once more on the credited pass. Two initial tests were RED before the fix; final tests pending. Conservative recovery remote-wait ceiling110s default/500s maximum includes the final two-step metadata assessment.

Final D1 delta validation: teardown69/69 +existing/native42/42 +unchangedconfig10=121/121 PASS. New real-D1 cases cover immediate recovery, delayed recovery after a failed credited pass, and permanent failure ending in one quarantine. TypeScript/scopedlint/format/secretguard/diff checks PASS; independent CF/security/constitution/doc reviews PASS.

## Final continuation evidence (2026-11-18 UTC)

This checkpoint supersedes the historical progress notes above. The existing branch and PR were preserved, and main `4fc4cb99a` was merged without conflicts. The feature patch stayed identical except for Git blob hashes. Implementation `230d64574` passed 121 focused tests, API build/typecheck, lint, format, migration and secret guards, and independent specialist reviews. Full CI `44189930037` and E2E `44189930159` succeeded: 24 passing checks and 10 inapplicable skips, with no failures or pending checks. Sonar reported zero issues and hotspots.

Normal gated staging2 deployment `44202361573` succeeded, including rollout and smoke tests. Both queues were checked, the reservation preceded deployment, and the actual turn was honored. The installation test user signed in through workload identity.

- **Instant:** Artifacts project `01M7NZBZNQJXSPW89MZT548XT3`, session `9b0bb068-9b77-4996-844c-ee0484f5d9f5`, returned the actual Claude Code reply `L19 INSTANT VERIFIED` in the live UI.
- **Q1:** Setup `01M7NZJJZ86KEMHXHF762A5MTB` produced the real auth.openai.com verification link and code on desktop/mobile; native copy readback matched. Cancel returned 200 and closed the dialog in 1,536 ms; immediate state GET was cancelled. D1 was cancelled with completion at 00:05:58.585Z. DO cleanup_pending=0, destroyed=1, io_pending=0; pool held=0. The direct D1 observation followed cancellation; real-SQL barriers independently cover concurrent writer ordering.
- **Q2 / fresh attempt:** The next attempt `01M7NZM94ZYBS48702DFVGC1PX` returned 201/provisioning and showed Preparing secure sign-in. Cancel returned 200 and closed the dialog in 626 ms, with no hang/reload; immediate state GET was cancelled. D1 completion was 00:06:44.280Z, DO cleanup_pending=0/destroyed=1/io_pending=0, and pool held=0. The raw Cloudflare log at 00:06:44.521Z records `credential_setup.scrub_skipped` for that exact session, reason `provisioning_still_in_flight`, request `0b1b323bc5999c1862733748b3c3c33a`.
- **Agreed scope:** SDK permanent-start mapping remains contract-covered. No throwaway image, provider login completion, account creation or personal/production credentials were used. Screenshots were opened and inspected at 1280×800 and 375×667; no UI code changed.
- **Cleanup:** Own workspace/profile/project deletion returned 200; workspace/node/project GET returned 404. Direct D1 counts for workspace/project/profile were zero. The node is only a deleted audit row with provider_instance_id=NULL. Both guided sessions are cancelled with cleanup=0 and pool held=0. Sign-out returned 200 and the saved browser session was removed. No shared settings or credentials changed; terminal audit rows remain through normal lifecycle, without direct D1 writes.
- **Release:** Normal release `44205797976` succeeded. Authoritative status at 00:17:41Z showed holder=null and L13's turn; the next task was notified.

Final independent completion review passed A/B/C/E/F; D is N/A because no UI inputs changed. The reviewer verified the tests, actual UI/Cloudflare proof, cleanup and deleted-node audit record before archival. All implementation and live acceptance items are complete. The archive-only checkpoint's CI and serialized normal merge/post-merge reporting remain workflow gates. Production #2841's merge hold is lifted.

## Late review follow-up: bounded inline join (2026-11-18)

Codex discussion r4608153962 found an unbounded alarm join of inline cleanup stalled in claim-time D1 or pool release. Two real-SQLite blocked-inline regression cases failed on the old implementation. The alarm now joins only for the configured recovery-step timeout, preserves single cleanup ownership, and schedules the immutable uncertainty watchdog; settlement advances recovery when still owed. Watchdog/two-tick/late-settlement coverage confirms finite quarantine without duplicate SDK work. Final isolated focused suite 125/125 and API build/lint/secret guard passed. Fresh Cloudflare/security delta review PASS; test/completion requested timeout-spy restoration and this record update, both ADDRESSED with final test/completion PASS. Added a barrier-controlled settlement-during-setAlarm regression preserving the earlier wake.

Coordinator message 45b7779f-2a05-4ca6-8d3d-eb09186c0ecd requires fresh final-head full CI and a normal gated staging turn, repeating Instant/Q1/Q2, cleanup timing and no residual watchdog/quarantine. Prior staging evidence remains historical; it does not satisfy this code delta. Fault injection into live managed D1/pool is not required: discriminating local fault tests are accepted. Final validation and final-head staging remain pending.
