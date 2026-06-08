# Fix vm-agent Codex prompt deadlock recovery

## Problem Statement

Codex ACP prompts can hang forever after a hard stdio disconnect when the ACP subprocess stays alive. `finishPromptWithError()` arms crash recovery and returns, but `monitorProcessExit()` is the only relaunch path and it blocks on `process.Wait()`. If the process never exits, the task never receives a terminal or recovered prompt completion signal.

This task implements SAM idea `01KTK35RWTMAF6ZM169K6TPFPQ`, specifically Revision 3 CONSENSUS items 1-6 and blockers P3-1, P3-2, and P3-3. Earlier revisions are historical context only.

## Hard Constraints

- Go only: `packages/vm-agent/internal/acp` and `packages/vm-agent/internal/server`.
- Do not touch Worker/UI code.
- Do not touch Channel-B oversized-message-output issue `01KSTVJ0KCS4HGK939S57F5G6J`.
- Do not deploy to staging; staging verification is deliberately skipped per dispatch instructions and must be completed before any future merge.
- Do not merge. Open a draft PR only and add the `needs-human-review` label.

## Research Findings

- `packages/vm-agent/internal/acp/session_host_prompt.go`
  - `finishPromptWithError()` Branch A calls `beginCrashRecovery()` and returns without stopping the hung process.
  - Normal completion paths call `notifyPromptComplete()` directly and must remain unwrapped.
- `packages/vm-agent/internal/acp/session_host_crash.go`
  - `beginCrashRecovery()` is the correct place to allocate an episode-local `*sync.Once` and arm a recovery watchdog.
  - The Once must be captured by closure, not stored on `SessionHost`.
- `packages/vm-agent/internal/acp/session_host_process.go`
  - `monitorProcessExit()` owns restart and `LoadSession`; it must receive/use the episode completion helper.
  - Rapid-exit, max-restarts, restart failure, watchdog failure, and monitor success are the recovery-terminal sites that must dedupe through the episode Once.
  - `restartCount` currently behaves like a host-lifetime counter, with a per-selection reset in `beginAgentSelection()`.
- `packages/vm-agent/internal/acp/session_host.go`
  - `autoSuspend()` currently defers only for `HostPrompting`, so `HostStarting` recovery can be suspended and strand a task.
  - The recovery check inside `autoSuspend()` must use `h.mu.RLock()` while `viewerMu` is held, never `h.mu.Lock()`.
- `packages/vm-agent/internal/server/server.go`
  - `stopReason == "recovered"` maps to `awaiting_followup`; `stopReason == "error"` or non-nil error maps to terminal failure.
- Relevant retained lessons:
  - `tasks/archive/2026-05-22-agent-crash-recovery.md`: crash recovery depends on explicit lifecycle tests because cleanup/completion paths diverge easily.
  - `docs/notes/2026-05-13-conversation-idle-timeout-task-completion-postmortem.md`: lifecycle status paths need explicit tests for parallel cleanup/completion behavior.
  - `.claude/rules/02-quality-gates.md`: bug-fix PRs need a task-record post-mortem and process fix.
  - `.claude/rules/18-file-size-limits.md`: touched non-test source files should stay below 500 lines or be split/justified.

## Implementation Checklist

- [ ] Add recovery watchdog and restart decay configuration using `DEFAULT_*` constants plus env overrides.
- [ ] Add `lastCrashTime` to `SessionHost` and replace per-success/per-selection restart reset with time-window decay.
- [ ] Change `beginCrashRecovery()` to allocate an episode-local `*sync.Once`, capture a once-bound notify helper, arm the watchdog, and return recovery episode data.
- [ ] Thread the once-bound notify helper through `monitorProcessExit()`, `finishCrashRecoveryFailure()`, max-restart handling, restart failure, rapid-exit failure, and monitor success.
- [ ] Keep the six normal prompt completion callers unwrapped.
- [ ] In Branch A of `finishPromptWithError()`, spawn a goroutine that re-acquires `h.mu`, verifies `h.process == proc && crashRecoveryInProgress`, releases `h.mu`, then calls `proc.Stop()` directly.
- [ ] Implement watchdog timeout cleanup with P3-1 guard as the first action under `h.mu`: return if `!h.crashRecoveryInProgress`; otherwise clear current session, clear crash recovery, set `HostError`, then fire the episode Once with `"error"`.
- [ ] Make `autoSuspend()` recovery-aware by checking `status == HostStarting || crashRecoveryInProgress` under `h.mu.RLock()` while holding `viewerMu`, then re-arm the idle timer instead of suspending.
- [ ] Preserve recovered-vs-error mapping by `LoadSession` outcome, and conservatively route Codex recovery to terminal `"error"` until codex `LoadSession` coherence is staging-validated; leave a TODO and PR note.
- [ ] Add Go tests for Level 1a Stop, independent watchdog, double-fire dedupe, P3-1 timer-after-success race, P3-2 autoSuspend deferral/no deadlock, P3-3 all terminal paths once-only plus later normal prompt, restart decay, unrecoverable disconnect, concurrent Stop/Suspend arm-to-stop, and server stopReason mapping.
- [ ] Run `go test ./...` and `go vet` from `packages/vm-agent`; fix failures in touched files.
- [ ] Add bug-fix post-mortem/process-fix content to this task record before archiving.

## Acceptance Criteria

- A hard ACP stdio disconnect from a hung-but-alive Codex process cannot leave the task stranded with no prompt completion signal.
- Every recovery episode emits exactly one recovery-terminal prompt completion signal.
- A leaked monitor whose `Wait()` never returns is covered by an independent watchdog and terminal `"error"` signal.
- Watchdog cleanup cannot nil a freshly restarted process after monitor success.
- Auto-suspend does not kill active recovery and does not introduce `viewerMu` / `h.mu` deadlocks.
- Restart count decays by time window, not trivial success.
- Server callback mapping remains: `"error"` is terminal failure; `"recovered"` is awaiting follow-up.
- PR is draft, labeled `needs-human-review`, notes staging was skipped and required before merge, and does not merge.

## Post-Mortem

To be completed before archive.

## References

- SAM idea: `01KTK35RWTMAF6ZM169K6TPFPQ`
- Related out-of-scope idea: `01KSTVJ0KCS4HGK939S57F5G6J`
- Prior crash recovery task: `tasks/archive/2026-05-22-agent-crash-recovery.md`
