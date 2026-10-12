# T2: sleep convergence and host liveness

Task 01M4QPDF9YRSHRQK2G7KYEXX0K; coordinator 01M4QMA42P8AKQD014N0W4KP6S; reliability-wave-1012.

## Evidence and research

Lost completion callbacks plus already-stopped runtime left snapshot stopping, chat sleeping but unwakeable, task active and D1 workspace running. Node-heartbeat fan-out refreshed ACP despite a stopped host. Long LIKE patterns broke real D1 dedupe.

- `session-sleep-candidates.ts` aged stopping rows out; lifecycle repair selected only sleeping workspaces, leaving stale running rows without an owner.
- `session-sleep-teardown.ts` requested chat sleep before stop and rejected the exact409 stopped response.
- Node/ACP heartbeat is a proxy. Existing VM hostStatus listing supplies the authoritative condition without a VM rollout.
- `stuck-task-live-runtime.ts` preservation-key LIKE exceeded D1's pattern limit; literal parameterized instr is sufficient.
- Existing rules53/62/74 require separate signal/condition and real producer/route/sweep/database verification.

## Implementation acceptance

- [x] Accept only exact already-stopped409; malformed/other409/status responses remain errors.
- [x] Stale stopping remains owned and converges through the existing verified recovery/teardown path; original episode budget ends ambiguous failure visibly blocked.
- [x] Captured-generation stop/ownership/commit fences end superseded old intent immediately without changing successor chat/task/runtime or retrying against it.
- [x] Node heartbeat does not prove stopped/released host live; bounded suspect-task/idle-cleanup host probes preserve running hosts and treat unknown results as inconclusive.
- [x] Literal instr dedupe tested against real D1 with long/special-character/suffix controls.
- [x] Real sweep/routes/recovery regressions and state agreement; exact idle-cleanup attention retired after confirmed wakeable sleep.
- [x] In-flight sleep, warm retention, original budget, missing/expired recovery and subsequent runaway ceiling controls.
- [x] Required revert-red proof; restored final source.
- [x] Final root lint/typecheck/tests/build and all local specialist reviews PASS.

## Remaining workflow gates

Phase-4 implementation archive approved by task-completion-validator. Archive records implementation readiness; later gates remain pending and are tracked in local workflow state and the eventual PR.

- [ ] Merge current main including T1 without rewriting history; coordinated STAGING_CLAIM.
- [ ] Green staging deploy, real VM sleep/wake closest failure path, old runtime absence and state agreement; clean own resources (<60min <=2VM, no pool changes).
- [ ] PR/CI/Sonar/CodeRabbit; MERGE_READY with head/evidence then explicit coordinator MERGE_GRANT.
- [ ] Merge; production deploy verification + read-only stopping check; publish DONE before complete_task.

## Implementation and boundaries

API-only; no VM changes/migrations/new vars/public routes/credential/security changes. Shared preservation predicates and runaway ceiling unchanged. Scoped CAS convergence runs before the stuck-task terminal verdict, capped5 per tick with existing5s background stop timeout. Overflow remains owned by the sleep sweep. Host probes use one listing per suspect candidate, existing caps100 stuck/5 DO idle cleanup, timeout5s; zero heartbeat-path I/O.

Exact-record DO blocked RPC, task EXISTS fence and durable retry deadlines prevent late/new-episode finalization and lost notices. An ambiguous stop retains nonterminal awaiting_followup with actionable error instead of destructively releasing uncertain compute; existing ceiling/expiry still bound it. Supersession blocks only the old intent with a notice. Confirmed cleanup clears only matching obsolete idle-cleanup state. Single host listing considers all matching ACP candidates; any running host wins, unknown is inconclusive, and active ID/work evidence follow the confirmed host.

Minimal #2305 overlap: `services/session-sleep-teardown.ts`, `scheduled/session-sleep-lifecycle-repair.ts`. Additive ProjectData RPCs stay separate from T1/C session linkage. Never manually change protected production sessions.

## Validation

- Root lint13/13 PASS; typecheck19/19 PASS, refreshed after final fixture corrections.
- Full root tests21/21 tasks PASS; API864 files/12104 tests PASS, one file/two tests skipped. Root build9/9 PASS.
- Real workerd/D1 suite17/17 PASS across three files on final generation-guard source: signed node-heartbeat route, both production liveness adapters, actual idle cleanup/repair and D1 dedupe.
- Sleep integration62 PASS: real stale stuck sweep at25h BEFORE sleep sweep; D1 running/stopped exact409; prepare/R2 uploads with omitted complete callback; actual ensureSessionRecovery to TaskRunner boundary and restore-result route; cap5/CAS race; no/expired recovery; warm retention and original budget; subsequent ceiling remains bounded.
- Fifteen generation interleaves: full/fallback/explicit entry points × before guarded chat RPC, before dispatch, VM generation rejection, after stop/before D1, post-D1/pre-snapshot. Successor states unchanged and subsequent real sweep performs no extra stop/release.
- Older external fixture corrections preserve real classifiers and existing behavior assertions. Host-list corrections253 targeted tests PASS; final error-export/guarded-stop/legacy unit DB get+batch corrections79 tests PASS. Independent test review PASS. Legacy unit DB doubles assume identity/write success; real integration/Workers tests remain the guard/race authority.

## Revert evidence

Original tracked API implementation reverted to branch HEAD while retaining new tests: core5/5 red (stale stop with D1running/stopped reaching wake, cross-sweep single teardown, cap5, original-budget unconfirmed stop blocked); Workers9/10 red (stopped/null/omitted/unknown heartbeat false liveness and long-key duplicate), released sleeping control green. Restored byte-exact and final full/Workers suites green.

Snapshot runtimeGuard-only revert: all three entry points red at post-D1/pre-snapshot supersession boundary; restored byte-exact. Independent security review PASS.

## Specialist reviews

- Cloudflare/constitution PASS: durable retries/exact-record race/original budget fixed; scoped loop budget and unchanged ceiling/predicates.
- Security supplemental PASS: captured physical-stop generation, immediately-before-dispatch guard, final writes/snapshot guard and immediate exact-claim supersession block.
- Test engineer PASS: real route/sweep/D1 controls and revert proof; multi-host ID correction; external fixture updates preserve assertions.
- Completion/doc-sync final PASS A–F: implementation complete and phase4 archive permitted after record reconciliation; architecture prose matches final behavior. Later workflow gates expressly excluded from this PASS.

## Staging evidence and blocked fault path

Final runtime head abb89b0f77e41d58603e951cfa688ef6b58bdfdf: CI38266525413 and staging deployment38266563371, including smoke tests, PASS. API version5ef1822c-fc59-453e-974c-bdc2c98d2204 served the test. PR2317 remains DRAFT; no MERGE_READY or merge grant. Coordinator is taking the live coverage gap to the owner.

**Ordinary control LIVE PASS:** one normal-pool VM; real Sol-produced full recovery point; real idle sweep completed sleep at15:41:24.959UTC with chat/task/workspace/snapshot agreement and sleepingAt. Old workspace deletion confirmed by VM agent at15:46:32.193UTC; owner container listing confirmed absence. Normal owner wake restored the committed marker at15:49 on successor workspace01M4RCRRMRXHJB39XB5CDFQVB5. Browser dashboard/settings/chat rendered with zero page errors; screenshot reviewed. Existing warm retention was unchanged.

**Core stale-stopping convergence NOT verified live.** Coordinator approved an explicitly labelled own-row stopping-intent fixture after supported owner agent-session Stop. The staging-only D1 UPDATE was rejected HTTP400/code7500, “You do not have permission to perform this operation”, using workspace CF_TOKEN. Cause is unestablished (possibly token D1 permission scope); no rows changed. A literal retry also failed. Coordinator then retracted the retry hint under owner direction: all D1 writes stopped, no alternate identity, credential or write route used. No supported owner API produces stale stopping intent: workspace Stop clears it. Exact already-stopped409 and lost snapshot-complete callback are local tests only; real-D1/DO Workers tests cover convergence. Supported stopped-host diagnostics were inconclusive, never live, despite fresh node heartbeat.

**Cleanup PASS:** owner DELETE temporary task, workspace, node and project each returned200, completed16:06UTC. Project deletion removed the temporary profile. Read-only D1 at16:07UTC returned zero non-deleted staging nodes and no own project/profile/workspace/snapshot rows. One VM peak, under50minutes, no capacity-pool/auth/security changes or production mutations. STAGING_RELEASE published on reliability-wave-1012, event5a321daf-66e0-49d9-bb9c-f020673c30e0. Production rollout and post-deploy checks remain pending; task is not complete.

## Post-mortem

Sleeping chat could not wake because sleepingAt was absent; stopped host looked live and wrote duplicate preservation records. Stopping rows aged out in b291dce39 (#2223) without a running-workspace repair owner. Node fan-out in a08e9ceea refreshed ACP independently of host status. LIKE in176385d9a (#2222) exceeded D1's pattern limit.

Class: incomplete convergence after lost acknowledgement, proxy/condition confusion, mock-hidden database limits. Earlier tests did not combine real producers with stale runtime and retained recovery state. This PR applies existing rules62/74 using real route/sweep/D1 tests and revert-red proof; no additional standing rule is needed.

## Main integration checkpoint

Merged origin/main b67fed80e without conflicts/history rewrite (ff384721a). Post-merge root lint/typecheck32/32 tasks PASS; sleep integration59/59 and realWorkers13/13 PASS. T1 main integration will be repeated before final staging/readiness if it lands afterward.

## Final chat transition guard

Optional captured owner/generation/stopping-claim guard on the existing sleepSession RPC performs a final real D1 read under DO concurrency serialization, then checks the local chat workspace and applies its synchronous transition. Legacy callers remain unchanged. Four real public-DO RPC tests failed before implementation and now pass; integration covers all three entry points at the RPC-admission boundary. Final targeted core141, Workers17 and root lint/typecheck32 PASS; final full root sequential tests21/21 PASS (/tmp/t2-final-tests-sequential.log); combined-head build9/9 PASS. Currentmain3581c1723 merged cleanly without history rewrite; accidental tracked runtime memory removed/restored locally. Final merged root lint/typecheck32/32 PASS.

This closes the demonstrated pre-RPC rebuild admission race. The final D1 read and serialized DO transition are not a cross-store transaction; external D1 admission after that read remains a distributed race limit. No admission implementation or speculative coordination mechanism is added.

## Initial CI and deployment checkpoint

SAM autosave opened PR2317 before staging proof with a placeholder body; it is now draft with the prepared evidence body. Initial pinned88e1 staging deployment38262102096 and smoke tests PASS, API version9f15e0c5 active100%, health200; no VM allocated. CI full tests/build/lint/typecheck/secret scan PASS. CI semantic gate required guarded property reads instead of two external JSON casts; same exact409 comparisons retained and independent review PASS. One legacy realWorkers fixture now expects task_agent_host_unknown while preserving all inconclusive-runtime assertions: eighteen realWorkers tests PASS; sleep/error105 PASS. Latest main758b04c38 merged cleanly without history rewrite. Final root lint/typecheck/build35/35 PASS; runtime-boundary semantic gate PASS. Repinned staging deploy precedes live proof.

Protected production read-only14:21:47Z: task failed, workspace deleted, available snapshot still stopping/null sleeping_at. Task error confirms runaway limit and updated_at14:00:20.109Z. No manual mutation; deployed sweep retires the obsolete deleted-workspace intent and retains artifacts rather than resurrecting the failed task.

## Sonar follow-up

Initial Sonar quality gate PASS with nine findings. Critical host-probe complexity addressed by extracting the unchanged bounded multi-host classifier into a pure helper; nested ternary/null-check/async findings addressed. Four minor sequential-await findings remain intentionally: bounded sleep attention/lifecycle repair, sleep sweep and stuck convergence preserve claim/teardown ordering and per-tick I/O pressure. Independent Cloudflare/security review PASS accepts this rationale; no scanner exclusions/settings changed. Final root lint/typecheck/build35 PASS, sleep/error105 and host81 PASS, realWorkers17 PASS after refactor; semantic gate PASS. Intermediate queued deploy38265360504 cancelled before deployment/compute to pin this final source; no VM allocated.
