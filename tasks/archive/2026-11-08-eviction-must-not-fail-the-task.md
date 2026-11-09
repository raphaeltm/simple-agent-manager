# An Eviction Must Never Be Reported as an Agent Crash

## Problem

On 2026-11-08, 14 production agent sessions were killed mid-prompt by VM memory-pressure
eviction. Every one of them reported `failed` to the control plane about one to two seconds
after `docker stop`. The session host's crash recovery could not restart the agent ("failed
to discover devcontainer: no running devcontainer found", step `agent_restart_failed`) and
posted a terminal `fatal_error` task callback.

- 11 tasks were resurrected about 50 seconds later. The eviction finalized and the API's
  wake re-queued the failed task (`failed -> queued: Sleeping conversation wake claimed`).
- 3 stayed failed (workspaces `01M6X93VFSXVTZZ6BTD6Q11GRX`, `01M6XZZVZ8XRP4Q1HM6JNY3BKX`,
  `01M6Y41TMCE255YM5PAGDV67C0`). The API orphan-workspace sweep saw "running workspace,
  terminal task" and stopped the workspace before the eviction's final capture and
  `markWorkspaceEvicted` ran. The VM agent then treated its write-ahead eviction intent
  as superseded (`reconcilePendingEvictionStop` returns obsolete), so the eviction was
  never delivered. The task stayed failed, the workspace stayed stopped without deletion
  proof, and the node lingered until the 30-minute stranded-retirement backstop (node
  `01M6Y3PFYHAE5QAQWYR22D1EEE`).

"Failed by workspace_callback, then re-queued by a wake within 30 minutes" happened to 3
tasks on Nov 5-7 and 8 on Nov 8. This is a standing bug, not a spike artifact.

## Research Findings

### VM agent paths

- `packages/vm-agent/internal/resourcemon/eviction.go` `performEviction`: snapshot ->
  pressure recheck -> `StopContainer` -> `finishEviction` (final quiesced capture ->
  `MarkWorkspaceEvicted` -> `NotifyEviction`).
- `internal/server/eviction.go` `stopEvictedWorkspaceContainer`: `markEvictionFinalizing`,
  then `prepareWorkspaceEvictionStop` (durable intent and `host.PrepareEviction()`), then
  `docker stop`.
- `internal/acp/session_host_eviction.go` `PrepareEviction` sets `h.evictionPending`
  before the stop. The flag is only read by prompt admission
  (`session_host_prompt_state.go`) and steering (`session_host_steering.go`). **The crash
  path never reads it.**
- Crash path: `session_host_prompt.go` `finishPromptAttemptWithError` (`isCrashPromptError`)
  -> `beginCrashRecoveryWithPrerequisites`; `session_host_process.go` `monitorProcessExit`
  sleeps 1s -> `restartAgentLocked` -> restart fails ->
  `completeActivePromptFailure(fatal_error)`, `reportAgentError(agent_restart_failed)`,
  `reportActivity("error")`. If the process exit wins the race instead, it reports "Agent
  process exited during an active prompt" -> HostError -> fatal completion.
- `internal/server/server.go` `makeTaskCompletionCallback`: `fatal_error` -> POST task
  status `failed`, even in conversation mode.
- `internal/server/eviction.go` `finishLocalWorkspaceEviction` ->
  `stopSessionHostsForWorkspace` -> `SessionHost.Stop()` completes an in-flight prompt
  as `cancelled`, which posts `awaiting_followup`.

### API paths

- `apps/api/src/routes/projects/workspace-eviction-callback.ts` records the eviction and
  marks the snapshot sleeping with `interruptedWork`. Eviction recovery wakes the
  conversation. `services/session-recovery.ts` re-queues the source task from any
  non-terminal status (an `in_progress` task is fine).
- `apps/api/src/scheduled/node-cleanup/workspace-phases.ts` orphan sweep. The 10-minute
  `ORPHANED_WORKSPACE_GRACE_PERIOD_MS` ("grace period before stopping orphaned task
  workspaces") is compared against `w.created_at`, never against when the task ended. A
  workspace older than 10 minutes is stopped on the next 5-minute cron after its task
  turns terminal.

### Docker experiments (local, alpine, Docker 29.x)

| Scenario | `docker exec` "agent" exit | `docker stop` returns | Container running 1s later |
| --- | --- | --- | --- |
| PID1 traps SIGTERM, `stop -t 10` | 137 at +43ms | +146ms (`kill` +38, `stop` +136, `die` +140) | no |
| PID1 ignores SIGTERM, `stop -t 2` | 137 at +2054ms (SIGKILL) | +2160ms | no |
| cgroup OOM (`--memory 48m`), hog exec | hog 137 at +476ms; agent exec survives | n/a | yes (`OOMKilled=true`) |

The exec'd agent always dies before `docker stop` returns, and the 1-second restart always
finds no container. The false failure is deterministic, not a timing accident.

### Prior art (cited in the PR)

- Kubernetes kubelet: the eviction status function (`Failed/Evicted`, `DisruptionTarget`)
  is applied before `killPod`. KEP-3329 requires the condition before deletion so that
  failure classification cannot race it.
- Nomad: `restartTracker.SetKilled()` runs before the kill signal, so the exit is
  `TaskKilled`, not restarted and not failed. `ShouldReschedule` ignores client failures
  when the desired status is `evict`.
- Erlang/OTP: the killer sets the exit reason (`shutdown`). The supervisor does not infer
  it.

## Design

The killer records the reason before it acts, and the observer reads that record before
issuing a verdict.

1. **SessionHost honours the eviction fence on every crash path.** While
   `evictionPending` is set, an agent disconnect or process exit is *owned by the
   eviction*. The host parks it: no restart, no `agent_restart_failed`, no fatal prompt
   completion, no `error` activity. It reports `recovering` and tells viewers the
   workspace is being moved.
2. **The eviction delivers the verdict.** The committed eviction stops the host through a
   dedicated `StopForEviction()`, which completes any in-flight prompt with a distinct
   `evicted` stop reason. `makeTaskCompletionCallback` posts nothing for `evicted`: the
   durable eviction delivery (`interruptedWork`) owns the outcome and the API wakes the
   conversation.
3. **Rollback replays.** If `PrepareEviction` is rolled back (the intent was not
   committed, so no `docker stop` ran), every parked exit is replayed through the normal
   crash handling, so a genuine crash is never hidden.
4. **API safety net.** The orphan sweep's grace is also measured from the terminal task's
   end time, so a just-terminal task cannot have its workspace stopped underneath an
   in-flight eviction or recovery.

## Implementation Checklist

- [x] VM: `SessionHost` parks crash/exit handling while `evictionPending`
      (`finishPromptAttemptWithError` crash branch, `monitorProcessExit`)
- [x] VM: parked exits replay on `PrepareEviction` rollback
- [x] VM: `StopForEviction()` completes the in-flight prompt with an `evicted` stop
      reason; `finishLocalWorkspaceEviction` uses it
- [x] VM: `makeTaskCompletionCallback` posts no task status for `evicted`
- [x] VM tests: race through the real trigger (process dies after `PrepareEviction`;
      both orders: prompt RPC error first, process exit first). Assert no
      `failed`/restart/agent error, then that `StopForEviction` posts nothing. Rollback
      replay test. Control: a crash without a fence still fails/restarts as before.
      Discrimination check: delete the guard, the tests go red.
- [x] VM: test that the completion callback sends no request for `evicted`
- [x] API: orphan sweep grace also measured from the task's terminal time; test with a
      real SQL engine (old workspace + just-failed task is not stopped; old task is
      stopped)
- [x] Docs: update eviction / workspace lifecycle docs that describe crash recovery or
      the orphan grace
- [x] Track the residual case (the kernel OOM-kills a whole container before any
      eviction claims it) as an idea, with evidence (idea `01M6YR5TX0C7X1S5FS7HSG22DX`)

## Acceptance Criteria

- [x] An agent killed by an eviction's `docker stop` never produces a `failed` task
      callback, an `agent_restart_failed` error, or a restart attempt (VM unit tests
      through `SessionHost` with a real process exit)
- [x] A committed eviction completes the in-flight prompt as `evicted` and the
      control-plane task stays non-terminal until the eviction callback (unit test on the
      callback)
- [x] An uncommitted eviction (rollback) leaves genuine crash handling intact (test)
- [x] A crash without an eviction behaves exactly as before (existing suite plus a
      control test)
- [x] The orphan sweep does not stop a workspace whose task became terminal less than
      the grace period ago (SQLite integration test)
- [ ] Staging: a real VM eviction under memory pressure leaves the task non-terminal and
      the conversation resumes on a new workspace (or the reason it cannot be exercised
      is documented, with fallback evidence)
- [ ] Prod: after deploy, monitor `agent_restart_failed` / "no running devcontainer
      found" and failed-then-requeued tasks

## References

- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md` (apps/api scoped)
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/74-proxy-signals-must-match-the-condition.md`
- `packages/vm-agent/.claude/rules/54-vm-agent-rollout-compatibility.md`

## Implementation Notes

- The VM fix is in `acp/session_host_eviction.go` (`parkPromptCrashForEviction`,
  `parkProcessExitForEviction`, `StopForEviction`, rollback replay), with call sites in
  `session_host_prompt.go` and `session_host_process.go` (`handleProcessExit` split
  out), plus `server/eviction.go`, `server/workspaces.go` and `server/server.go`.
- `acp/session_host_eviction_crash_test.go` covers both arrival orders, the idle exit,
  rollback replay, nested rollback and a no-fence control. Disabling the guard turns
  4 tests red; the control stays green.
- `server/eviction_agent_exit_test.go` runs a real ACP subprocess under the
  production SessionHost; a fake `docker stop` inside `stopEvictedWorkspaceContainer`
  SIGKILLs it. Without the guard it reproduces production's exact callback
  (`toStatus: failed`, `Agent prompt failed`, `agent_prompt_failed`). The control
  (container lost with no eviction) still posts `failed`.
- `tests/workers/scheduled-node-cleanup.test.ts`: a just-failed task keeps its
  hour-old workspace running, while the long-failed control is stopped. Reverting the
  sweep makes the test red. Four existing fixtures now set `completedAt: oldDate`
  (their scenario is a task that ended long ago).
- `main` is protected (a direct task-file push was rejected), so the task file lives
  on the branch.
- Review round 1 (go-specialist, test-engineer) added:
  - `EVICTION_PARK_TIMEOUT` (default 15m): a parked exit replays as an ordinary crash
    if the eviction never stops the host (a stuck `docker stop`, or an intent superseded
    without stopping the host). Tests: `TestUnresolvedEvictionParkFallsBackToCrashHandling`
    (acp) and `TestStuckEvictionStopFallsBackToCrashVerdictAtTheDeadline` (server, real
    stop path with a failing fake `docker stop`).
  - The prompt-timeout force-stop (`triggerPromptForceStopIfStuck`, unmanaged
    `ACP_PROMPT_TIMEOUT`) parks too: `TestPromptDeadlineDuringEvictionIsNotAVerdict`
    drives the real `watchPromptTimeout`.
  - Prompt-crash guard proven alone, with the process still alive:
    `TestEvictionOwnedPromptDisconnectAloneStartsNoRecovery`.
  - Server-level idle eviction: `TestEvictionStopKillingAnIdleAgentDoesNotRestartIt`.
  - Any `Stop()` disarms the parked work and the deadline; replay skips a stopped host;
    `StopForEviction` logs when a checkpoint rollover owns the attempt.
  - Not changed: prompt receipt `errorCode` is an unexported, never-serialized field
    (`persistence.PromptDeliveryReceipt`), so no consumer can misread it.
  - Discrimination was verified per guard: process-exit park, prompt-crash park,
    timeout park, deadline, orphan grace.

## Shipping continuation (2026-11-09)

- Rebased the existing branch onto current main. Fresh go-specialist review found
  the moved process-exit helper lost the exit-time intentional-stop observation;
  carry it in `processExitObservation` so deferred replay preserves causality.
- Fresh review also found the actual ACP deadline-return path bypassed eviction
  parking. It now parks; `TestPromptDeadlineReturnDuringEvictionIsNotAVerdict`
  exercises that path. Removing only this guard via a Go overlay makes the test
  fail with the false `fatal_error` verdict.
- Focused ACP eviction/deadline/intentional-stop race suite passed (20.776s).
- Cloudflare, constitution, documentation-sync and environment reviews passed.
- Residual idea `01M6YR5TX0C7X1S5FS7HSG22DX` remains open: raising the fence at
  target selection and recording eviction reason are outside this PR.
- Broad Go race validation found two baseline issues and reproduced both on
  unmodified main (`6c788eeff`): snapshot upload checksum/count race (existing idea
  `01M6M30FKZJ5CBYNW1EA6GZ9Y6`), and quiescence test scanning inherited agent state.
  The adjacent quiescence fixture now isolates CODEX_HOME, CLAUDE_CONFIG_DIR and
  XDG_DATA_HOME under its temporary home; its focused race test passes (2.138s).
  The upload race remains separately tracked; production upload code is unchanged.
- Full non-race Go validation also exposed a cancellation fixture rejecting the
  independent deferred `/lifecycle-timings` telemetry callback. The fixture now
  accepts exactly that route and still rejects any actual provisioning callback
  after credential cancellation; focused repeat tests pass.
- Repository validation passed: lint (14 tasks), typecheck (20 tasks), test (23
  tasks; API 15,628 passed / 4 skipped, web 5,064 passed), build (10 tasks).
- Staging deployment `42578506080` succeeded. Zero existing VM nodes before
  deployment; first queued test cancelled after Hetzner `fsn1` capacity exhaustion,
  second test in allowed `nbg1` provisioned node `01M6ZKHJVXR21S1VFX65F9G4S7`.

## Staging / Premerge Evidence (2026-11-09)

- Deployment succeeded: https://github.com/raphaeltm/simple-agent-manager/actions/runs/42578506080
  on production-code candidate `9c0605544469bff7bdc5377198d00f7cb959b5ef`.
  Later commits only repair test fixtures and record evidence; the release resolver
  still returns that exact immutable VM-agent release.
- Fresh VM node `01M6ZKHJVXR21S1VFX65F9G4S7` in nbg1: heartbeat at
  `07:34:21.920Z`, healthy system-info with exact candidate agent version. Browser
  dashboard/project/settings and workspace terminal WebSocket worked without page
  errors. No sizing or resource requirement overrides were supplied.
- **Pressure-eviction limitation:** a real foreground ACP tool was in flight when
  bounded cgroup PSI injection was attempted. The namespace denied writing
  `memory.high` with `EPERM`, even with sudo; it remained `max`, PSI remained zero,
  and the capped allocator never ran. There is no supported forced-eviction route.
  No host memory exhaustion was attempted. Therefore a live pressure eviction is
  **not claimed**; this uses the acceptance criterion's explicit documented-fallback
  alternative.
- Fallback: real ACP subprocess tests kill the process inside the production
  eviction stop callback, demonstrate no verdict/restart/error behind the fence,
  and retain genuine-crash and rollback controls. On the real staging VM, explicit
  sleep produced snapshot `01M6ZKRYCG768V8ZGNKMWEF5AV`, `available` / `none`, with
  both home and WIP artifacts. Wake restored onto replacement workspace
  `01M6ZMACBA9A41Y1QH99EZSCNQ` at `07:46:48.121Z`; recovery status `restored`.
  The agent read back exact sentinel `EVICTION-PRESERVED-20261109`. Sampled task
  states remained non-failed throughout; filtered agent-restart failure logs empty.
- After verification, the fixture session was stopped and the node and temporary
  profile were deleted. Confirm cleanup in the PR evidence before merge.
- Final fixture review preserves token assertions and consumes successful fake
  upload bodies before acknowledging them; it no longer races request-body readers
  merely because the fake server returns early. Production upload synchronization
  remains separately tracked in existing idea `01M6M30FKZJ5CBYNW1EA6GZ9Y6`.
- Preflight Evidence and Specialist Review Evidence validators pass locally.
- Production monitoring is a postmerge release gate. Its final result will be
  recorded in the shipping PR rather than falsely asserted before deployment.
- Final full server race suite passed (120.802s), plus ten repetitions of the
  hibernate authentication success/failure controls with race detection (4.180s).
  Final node listing confirmed zero remaining VM nodes after cleanup; temporary
  profile deletion returned success.
- CI caught the prompt file at 802 lines after the deadline guard. Moved unchanged
  `finishPromptCancelled` beside cancellation completion in `session_host_cancel.go`
  (prompt file now 789 lines); focused cancellation/eviction/deadline race tests
  pass (24.363s), and the file-size gate passes. Refresh staging for this final
  release identity before merge; no behavior changed in this extraction.

## Coordinator review continuation (2026-11-09)

This section supersedes the earlier candidate identity and accepted-fallback claim.
Real pressure eviction is required before release approval; the task is active again.
Staging refresh 42582734240 failed fetching the upstream OpenCode installer asset
(HTTP 504), before any new VM was provisioned. Deploy the final revised source next.

- [x] Fence every SessionHost in the workspace, aggregate interrupted work, and
  roll back every fence if durable intent preparation aborts. Two real ACP processes
  killed by the production stop callback produce no failed verdict; reverting the
  helper makes agent-2 report a false failure.
- [x] Expiry reopens admission. Per-episode epochs prevent stale timers and rollback
  closures from clearing later fences. A new prompt can start and a subsequent
  eviction parks again; removing admission clearing discriminates the regression.
- [x] A delayed reconciler stop reacquires all fences and persists new interrupted
  work before Docker stop. Persistence monotonically merges that evidence, advancing
  the payload revision so a stale idle acknowledgement cannot erase it. Both guards
  have discriminating tests.
- [x] Orphan cleanup vetoes any recent terminal task, including on a reused workspace.
  Real Workers SQL red/green coverage includes old failed + fresh failed tasks with a
  chat, old completed + fresh failed tasks without a chat, NULL completion fallback,
  and old-task controls. Completed tasks with a chat independently retain sleep
  ownership. Full cleanup suite: 31 passing tests; API typecheck and lint pass.
- [x] go-specialist source review ADDRESSED; focused race ACP/server/persistence pass
  (15.474s / 20.827s / 2.660s). Cloudflare/constitution/doc-sync re-review PASS.
  Test-engineer/task-completion source review PASS; real staging and production pending.
- [x] Deploy final source and demonstrate a real pressure eviction on a fresh VM
  (release 361a5d8a734bc42d19a2ed3ce5f06341e071747d; evidence below).
- [ ] Obtain coordinator approval naming PR 2604 and the final full head SHA.

Review dispositions: the small interval between PrepareEviction and intent commit
is deliberately owned by eviction; failed preparation replays ordinary crash recovery,
while a successful intent owns the container stop. The prompt receipt observer's
prompt_terminal_error is stored only as private diagnostic state: errorCode and
stopReason are unexported fields of PromptDeliveryReceipt, omitted from its JSON;
no production reader examines errorCode (GetPromptDelivery reads it without branching).
Thus it cannot post a failed verdict. Test hygiene changes isolate inherited agent
state, accept the precise independent telemetry callback, and drain fake upload bodies;
they preserve auth/cancellation assertions and were required for reliable full checks.

- Coordinator's final map-lock review: collect matching host pointers under the
  global sessionHostMu, release it, then call PrepareEviction on each host. This
  preserves aggregation/rollback while following existing host-map discipline.
  Source approval of49187283a was conditional; real staging must use this revision.

## CodeRabbit revision review (2026-11-09)

The prior f98 source approval and staging proof do not cover these production
changes. Obtain a new final-head approval and refresh staging before merge;
archival records implementation/premerge evidence and does not waive release gates. Production deployment and monitoring remain postmerge gates.

- [x] Stable terminal grace (4511554945): use the latest genuine status-transition
  event when completed_at is absent; same-status metadata events cannot reset grace.
  Real Workers regression covers an old terminal transition with a recent edit and
  a recent terminal transition with old updated_at, with an old-status control.
- [x] Renewed replay ownership (4511554958): detached process callbacks re-enter the
  eviction-aware dispatcher. A decision lock orders renewed PrepareEviction against
  the existing bounded process restart, including its previously unlocked one-second
  delay. Controlled replay and restart-delay tests discriminate independently.
- [x] Late parking after teardown (4511554974): current-attempt and teardown checks
  consume stale prompt callbacks; report publication is ordered before teardown.
  Stop latches teardown under the reporting lock and releases it before completion
  callbacks. Regression checks no new parked callback/timer after committed stop.
- [x] Checkpoint terminal arbitration (4511554983): committed eviction supersedes
  checkpoint ownership and resolves its caller; rollback preserves ordinary failure.
  Real checkpoint deadline tests cover commit before/after deadline, rollback,
  no eviction, natural completion, ordinary stop, teardown before HostStopped,
  and detached failure replay behind a renewed fence. Independent removal of
  eviction completion reproduces a missing terminal callback.
- [x] Viewer timeout ownership (4511554997): defer the notification together with its
  force-stop. Real watchdog regression covers commit, rollback, expiry and no-fence
  controls; guard-removal overlay reproduces the premature terminal viewer error.
- [x] Parking-budget validation (4511555011): exercise real Config.Load and Validate,
  rejecting short, exact-boundary and negative budgets, accepting sufficient/default
  budgets, and checking overflow-safe arithmetic against configured stop/capture/
  recording windows.
- [x] Late host admission (4511555021): initial and retried stops reject ordinary and
  restore-owner host creation while the real Docker stop is held at a controlled
  midpoint; failed stops reopen admission. Independent host-guard and retry-fence
  removal overlays fail the intended regression cases.

Test-engineer/task-completion review evidence: focused six-test ACP race subset
passed (9.200s); final replay/teardown/restart-delay subset passed (3.909s).
Independent Go overlays demonstrated all three added ACP protections discriminate:
restoring direct process-exit replay bypasses the renewed fence; removing teardown
validation creates one stale parked callback and timer; removing decision ordering
allows PrepareEviction to return during the restart delay. Server admission and
checkpoint/viewer discrimination logs are recorded under /tmp/eviction-ship during
this session; durable PR evidence must summarize results rather than rely on those
local files. Broader final-source verification and staging remain coordinator gates.

Final CodeRabbit source/test completion review: PASS for all seven implementation
items. Checkpoint/viewer focused race verification passed (14.588s). A separate
focused race run covering legacy unfenced crash recovery, captured prerequisites,
watchdogs, unrecoverable disconnect/deadline controls, new replay/teardown ordering,
and checkpoint/viewer controls passed (14.223s). The late-park guard validates
supplied attempt identity/terminal state rather than promptInFlight: this preserves
existing ordinary crash handling and consumes stale real attempts. Its regenerated
current-source removal overlay still reproduces stale parking after teardown.

The process decision lock introduces no unbounded restart: ordinary restarts use
existing ACP_RESTART_ATTEMPT_TIMEOUT (default five minutes, already protected by
h.mu); production checkpoint calls derive an operation deadline from
ACP_CHECKPOINT_ROLLOVER_TIMEOUT (default two minutes). The lock additionally orders
the existing one-second unlocked restart delay before a new eviction fence.
No reporting lock is held across terminal callbacks. Remaining completion gates:
final broad validation, fresh immutable-release staging, renewed exact-head
coordinator approval, CI/CodeRabbit reconciliation, merge and production monitoring.
Track unresolved release gates explicitly in the PR and .do-state.md through
archival; archive status is not a claim that deployment or production monitoring passed.

Final checkpoint teardown ordering: retain report serialization through the eviction terminal arbiter, before ordinary Stop. A controlled real-checkpoint interval test verifies exact evicted completion and caller supersession; independently restoring the early unlock fails the regression. Full revised Go suite and ACP/server/persistence race suites passed; final full ACP race passed after this last ordering change.

### Independent coordinator review: cancellation grace

- [x] Route the actual cancel-grace watchdog through the eviction decision lock and park before cancellation settlement; the viewer timeout uses an already-locked helper.
- [x] Actual CancelPrompt-to-grace-expiry regressions cover committed eviction (evicted), rollback/expiry/unfenced cancellation, with an independent ordering removal that reproduces premature cancelled completion.
- [x] Independent final go-specialist/completion review PASS. Full Go suite passed again (server73.038s); full ACP race passed68.711s.
- [x] Confirm checkpoint HTTP lifetime: POST immediately returns202 and launches a background operation. Eviction arbitration may outlive the2m restart context until commit/rollback/configured park expiry (default15m); no HTTP request waits for it. PR documents the bound.


## Final immutable-release staging and archive-readiness review (2026-11-09)

- [x] Exact release `361a5d8a734bc42d19a2ed3ce5f06341e071747d` deployed in
  staging run `42605923340`, including smoke. Cloudflare binding, fresh VM D1
  version and live system-info agree. Browser dashboard/project/settings had no
  page errors. No resourceRequirements or sizing override was used.
- [x] Fresh VM `01M7014N91Q4P9YBEMJ3KSEPH5` had two real foreground ACP tool
  waits active before a bounded allocator triggered actual container-OOM eviction.
  All four prompt/process disconnects were explicitly parked as eviction-owned.
  Both hosts stopped for eviction; the task callback explicitly deferred to the
  durable eviction delivery. Snapshot `01M701G2JS4WQQA42W6CVVEK1V` is
  available/none with home and WIP artifacts and interruptedWork=1.
- [x] Complete task-status audit for `01M700Y48CB5MC5RAB7CE13H20` shows
  in_progress -> queued at 11:40:11.442Z, with no failed transition. This proves
  final-release verdict suppression and durable handoff, not a replacement restore.
  Snapshot trace times are control-plane ingestion timestamps; no synchronized
  pre-stop ordering is inferred from them.
- [x] Bounded verification cleanup: fixture task cancelled, original node and late
  replacement allocation deleted through strict owner deletion (HTTP 200), and
  temporary profile deleted. D1 confirmed zero remaining VM nodes at 11:44:05Z.
  Earlier capacity-refused attempt was cancelled and its late allocation strictly
  deleted before the final attempt. No independent provider GET-404 is claimed.
- [ ] Coordinator accepts the disclosed replacement-restore disposition, or obtains
  fresh restore evidence. Recovery first hit external Hetzner 412 capacity; a node
  allocated just before bounded fixture cancellation did not boot/restore. Final
  release restore is NOT claimed. Supporting control: earlier real 9c sleep/wake
  restored the exact EVICTION-PRESERVED-20261109 sentinel on a replacement workspace;
  restore implementation is unchanged by this PR.
- [ ] Renewed exact-final-head coordinator approval and final CI/CodeRabbit gate.
- [ ] Merge, production deployment and production monitoring.

Final task-completion verdict: implementation/source coverage PASS; release
completion WARN. All seven CodeRabbit fixes and the independent cancel-grace
finding have substantive implementation, real-trigger regressions and discriminating
negative evidence. Full final Go suite and ACP race passed (server 73.038s;
ACP 68.711s), and functional CI passed. No uncovered source finding blocks archival.
The /do Phase 4 archive step may record this premerge state, provided the pending
restore disposition, approval/review and production gates remain explicit in the PR
and .do-state.md. Archival must not mark those gates complete or authorize merge.
A documentation-only archive commit must precede renewed exact-head approval;
the VM release remains the verified immutable 361 release.


## Incremental review 2026-11-09 12:39 UTC — reopened implementation

CodeRabbit review5825952787 on head2c0379db returned11findings and one concurrent-retry test nit after the trusted request/wait. The task is active again; previous head approval cannot authorize a changed head.

- [x] Verify/address recovery watchdog, expired/rolled-back process replay admission, checkpoint episode cleanup, cooperative cancellation, and RPC decision atomicity (ACP).
- [x] Verify/address final snapshot failure-report timeout budget, idempotent start retry ownership, nil restore-host denial, and concurrent stop/retry admission control (server/config).
- [x] Normalize mixed event timestamps and disposition legacy missing terminal-history grace anchor; document all orphan cleanup states (API/docs).
- [x] Record per-finding meaningful regressions and negative/removal controls; complete local specialist reviews and affected suites.
- [ ] Push revised head, fresh VM staging verification under new coordinator grant, then renew exact-head approval.
- [ ] Complete revised CI, trusted incremental CodeRabbit request/wait and all returned feedback, merge, production monitoring.

API9449 fixed with normalized Julian-day comparisons before eventMAX and cutoff;33/33 realWorkers testsPASS and independent normalizationremovalRED. Docs9476 nowlistcreating/running/recovery. Minor9440deferred toOPENidea01M705B45FNNTZAFM9QHW87J3Y: completed_at/realtransitionnormalrowsstable; retainingconservativeunknownlegacyfallbackavoidsprematurekill, stablefirstobservationrequiresseparatehoneststate. SourceAPItypecheckPASS. Updated timeout reference formula to include SESSION_SNAPSHOT_PROGRESS_REPORT_TIMEOUT (defaultcombined360s, parkingstrictlygreater).

### Review2 source validation

ACP4512799485/9496/9510/9523/9532 fixed: active watchdog park with original recoveryepoch+attempt identity, admission retained through detachedexit replay, completedcheckpoint released only after absentprocess, cooperativecancel park, atomic RPC terminal/recovery decision. `session_host_eviction_followup_test.go` exercises commit/rollback/expiry/unfenced and staleepisode controls; checkpoint execution test covers reusablehost afterfailedresume. All five guardremovals plus watchdogidentity removal reproduced behavioral failures. Independent cross-componentreview caught and verified watchdogidentity correction.

Server/config4512799549/9565/9572 and concurrentretrynit fixed: include configurable/default failure-report timeout; exactlegacy/versioned retry recognizes only actual AcceptPrompt winner with existing invokedreceipt, no mutation/relaunch; deniedrestore gracefullydegradeswithoutclearingevictionidentity/fence; stale retry rechecks finalizationafterlifecyclelock. New `eviction_retry_contract_test.go` verifies changedprompt/task/model/delivery/session rejection, realACP invocationcount1, actualrestore route, originalstop/finalcaptureadmission, concurrentstarteridentity. Six guardremoval overlays failed behaviorally.

Validation: full `go test ./...` PASS (server73.498s); full ACP `go test -race ./internal/acp` PASS71.640s. Focused finalACP race10.338s + expandedcontrols31.866s + checkpointcontrols7.688s; finalconfig/serverrace1.021s/3.298s. API33/33cleanupWorkersPASS, independentmixedtimestampnormalizationremovalRED; APItypecheck/lintPASS. File-size/context-budget/runtime-state and diff checksPASS. Evidence `/tmp/eviction-ship/review2-*`, `go-followup-*`, `mixed-terminal-timestamps-*`. Freshstage/newheadapproval/CI/reviewwait/productionmonitoring stillrequired; no releaseclaim.

CI350 exposed a portablefixture issue in the new deniedrestore regression: standalone restore prioritizes ContainerWorkDir, and only WorkspaceDir was set to the test tempdir. CI could not create the derived /workspaces/workspace and returned an earlier generic degradation. Fixed TESTONLY: set both paths to the tempdir and require the exact admission-fenced degradation report before checking identity. Focusedrace count10PASS3.571s; explicitreadonlydefault simulationPASS1.272s; oldfixture/readonlypath negative reproduces earlyprovisioningfailure, and independent nilguard/fallbackguard removals remainRED409panic/identityloss. Production source unchanged from350. SonarQualityGatePASS18maintainabilitysmells/0hotspots, independentlyGo-triagednonblocking; no sourcecorrectness/securityfinding.
