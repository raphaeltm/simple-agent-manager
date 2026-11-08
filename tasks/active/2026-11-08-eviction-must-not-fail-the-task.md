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

- [ ] An agent killed by an eviction's `docker stop` never produces a `failed` task
      callback, an `agent_restart_failed` error, or a restart attempt (VM unit tests
      through `SessionHost` with a real process exit)
- [ ] A committed eviction completes the in-flight prompt as `evicted` and the
      control-plane task stays non-terminal until the eviction callback (unit test on the
      callback)
- [ ] An uncommitted eviction (rollback) leaves genuine crash handling intact (test)
- [ ] A crash without an eviction behaves exactly as before (existing suite plus a
      control test)
- [ ] The orphan sweep does not stop a workspace whose task became terminal less than
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
