# Bind the prompt-cancel grace watchdog to the cancelled attempt

## Problem

The VM agent's 5 s "cancel grace" watchdog (`cancelPrompt(true)`) is keyed by a
numeric prompt ID and is never disarmed. If the next prompt starts inside the
window, the stale timer force-stops the **new** prompt: `promptAttemptForID`
fabricates an attempt for the stale ID and overwrites `h.promptAttempt`, the stop is
classified `fatalErrorStopReason` because `activePromptID` moved on, the new
prompt's agent is killed, and the task goes `failed` with
`Prompt cancel grace elapsed after 5s`.

Production 2026-08-30 → 2026-09-29: 91 cancels, 4 had the next prompt start within
5 s, all 4 were killed, 0 true positives. Regression from PR #1785. Full evidence:
idea `01M31M9G3T4SEWT9ZW1BM4QKZ3`. This task is Fix Plan section A (VM agent). The
control-plane amplifier (section B: per-session delivery single-flight, one stop per
urgent delivery) is a separate follow-up PR.

## Research Findings

- `session_host.go` `cancelPrompt` spawns `go func(){ <-timer.C; triggerPromptForceStopIfStuck(id) }`.
- `session_host_prompt_state.go` `promptAttemptForID` fabricates an attempt whenever
  `promptInFlight` and the ID does not match (the "focused-test and upgrade seam").
  In-flight prompt state never survives a vm-agent restart, so there is no upgrade case.
- `triggerPromptForceStopIfStuck` finalizer sets `HostError`, calls
  `stopCurrentAgentLocked()` (no restart), and reports `fatalErrorStopReason`
  unless cancel was requested for that ID.
- Both cancel transports arm the watchdog: HTTP `CancelPromptFromControlPlane`
  (`server/workspaces.go` cancel handler) and WS `session/cancel` (`gateway.go`).
- `StopProcessForPromptCancel` sets `intentionalPromptCancelProcessStop`, and
  `monitorProcessExit` then restarts the agent back to Ready with LoadSession of the
  previous ACP session. That is the correct recovery for a genuinely stuck cancel.
- `watchPromptTimeout` (hard prompt timeout) also calls the force-stop; it is already
  bound to `promptDone`, but should pass the attempt too.
- acp-go-sdk `Prompt` returns on ctx cancel, but first writes `session/cancel` with
  `context.Background()`; a blocked agent stdin can therefore hold `Run` — the real
  "stuck cancel" case the watchdog still needs to cover.
- Tests at `session_host_test.go` (`TestSessionHost_CancelPrompt_ForceStopsAfterGracePeriod`,
  `TestSessionHost_ForceStoppedPromptReportsFatalCompletionExactlyOnce`,
  `TestSessionHost_CompetingPromptCompletionPathsClaimExactlyOnce`) hand-build
  `promptInFlight=true` and depend on the fabricate seam.
- `finishPromptWithError` test seam only creates an attempt when none exists; it
  cannot overwrite a live attempt, so it is not part of this bug.
- Log lines `ACP Prompt started/cancelled/completed`, `Prompt cancel requested`,
  `ACP prompt force-stopped` carry no prompt identity.
- Rule 18: `session_host.go` is 1295 lines with no exception header.

## Implementation Checklist

- [x] Commit 1 (pure move): split `session_host.go` below 800 lines — cancel block →
      `session_host_cancel.go`; promptAttempt/checkpoint episode →
      `session_host_attempt.go`; session settings → `session_host_settings.go`;
      stderr helpers → `session_host_stderr.go`; MCP server builders →
      `session_host_mcp.go`
- [x] Arm the cancel watchdog with the exact `*promptAttempt`; select on
      `attempt.done`, `h.ctx.Done()`, and an injectable grace timer
- [x] Force-stop is attempt-bound: no-op (with log) unless `h.promptAttempt == attempt`
      and the attempt is non-terminal; `watchPromptTimeout` passes the attempt
- [x] Delete `promptAttemptForID` and its fabricate branch
- [x] A stuck *requested* cancel finishes `cancelled` and restarts the agent via the
      intentional prompt-cancel process stop (never `HostError`/fatal)
- [x] Observability: `promptId` (+ `deliveryId` for control-plane prompts) on
      `ACP Prompt started/cancelled/completed`, `Prompt cancel requested`; force-stop
      logs `{promptId, currentPromptId, cancelRequested}`
- [x] Tests: real prompts via fake ACP agent + gated timer, both HTTP and WS cancel
      paths, next prompt accepted before deadline, then release timer → B untouched,
      no HostError, one completion per prompt
- [x] Convergence control: fake agent that blocks cancel → watchdog fires, outcome
      `cancelled`, agent restart requested, host not in error
- [x] Rewrite hand-built-state tests to drive real accepted attempts
- [x] Discrimination: revert to ID lookup + fabricate seam → new test goes red
- [ ] Update idea 01M31M9G3T4SEWT9ZW1BM4QKZ3 with PR evidence

## Acceptance Criteria

- [x] A stale cancel-grace timer never affects a later prompt (Go test, both transports)
- [x] A genuinely stuck cancel reports `cancelled`, not `failed`, and restarts the agent
- [x] Hard prompt timeout still reports fatal exactly once
- [x] `go test ./...` and `go vet` pass for `packages/vm-agent`
- [ ] Staging: VM provisioned, heartbeat, prompt → Stop → immediate follow-up
      completes without task failure

## Implementation Notes

- Stale-watchdog discrimination (2026-09-29): removing the `attempt.done` disarm and
  re-pointing the force-stop at the current attempt (pre-fix semantics) made
  `TestCancelGraceWatchdogNeverTouchesTheNextPrompt/{ws,http}` fail with prompt B
  completing `fatal_error`, the incident signature, and
  `TestCancelGraceWatchdogDisarmsWhenAttemptSettles` fail. Restored → green.
- Convergence discrimination: disabling the stuck-cancel settle branch made
  `TestCancelGraceWatchdogSettlesAGenuinelyStuckCancel/{ws,http}` report
  `fatal_error` instead of `cancelled`. Restored → green.
- Stuck cancel is modelled realistically: the fake agent stops draining stdin, so
  the ACP SDK's post-cancel `session/cancel` write blocks and `Run` cannot settle.
- `finishPromptWithError` seam only creates an attempt when none exists, so it
  cannot overwrite a live attempt; left as is.
- The HTTP transport test calls `CancelPromptFromControlPlane` directly; the HTTP
  handler is a thin `IsPrompting()` guard in front of it.

## References

- Idea `01M31M9G3T4SEWT9ZW1BM4QKZ3`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `packages/vm-agent/.claude/rules/54-vm-agent-rollout-compatibility.md`
- `.claude/rules/18-file-size-limits.md`
