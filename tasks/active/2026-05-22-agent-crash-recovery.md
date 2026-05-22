# Agent Crash Recovery via LoadSession

## Problem

When an ACP-backed agent process crashes during a prompt, the VM agent currently reports the prompt as failed immediately. That sends a terminal task callback, the control plane tears down the workspace, and the user loses the active conversation even though SAM already stores ACP session IDs for `LoadSession`.

The desired behavior is to distinguish agent-process crashes from normal prompt errors, recover the same ACP session with `LoadSession`, and show the user a clear crash report that attributes the fault to the agent vendor rather than SAM.

## Research Findings

- `packages/vm-agent/internal/acp/session_host_prompt.go`
  - `finishPromptWithError()` currently broadcasts a JSON-RPC error and calls `notifyPromptComplete("error", err)` for every prompt error.
  - This is the premature failure path that races ahead of `monitorProcessExit()`.
- `packages/vm-agent/internal/acp/session_host_process.go`
  - `monitorProcessExit()` already restarts crashed processes and uses the previous ACP session ID only when `intentionalPromptCancel` is true.
  - Rapid exits under 5 seconds are handled before restart and should remain unchanged.
  - Restart failures currently broadcast generic agent errors.
- `packages/vm-agent/internal/acp/session_host_handshake.go`
  - `tryLoadPreviousACPSession()` falls back to `NewSession` when `LoadSession` is unsupported or fails.
  - Crash recovery must not use that fallback because a fresh session loses context. Normal agent selection and existing cancel/restart behavior should keep their current semantics unless explicitly changed.
- `packages/vm-agent/internal/acp/session_host.go`
  - The host already has a 4KB stderr buffer and `checkStderrForSilentErrors()` deliberately leaves it available for crash reporting.
  - New crash state should be guarded by the existing `mu`.
- `packages/vm-agent/internal/acp/transport.go` and `session_host_broadcast.go`
  - Agent status updates are control messages buffered for late-join replay.
  - A new structured crash report can follow the same buffered broadcast path.
- `packages/vm-agent/internal/server/server.go`
  - `makeTaskCompletionCallback()` sends `toStatus: "failed"` for stop reason `error` or non-nil errors.
  - It already sends `executionStep: "awaiting_followup"` for cancellation and success.
- Relevant postmortems:
  - `docs/notes/2026-03-12-message-misrouting-and-metadata-loss-postmortem.md`: avoid silent data loss and shared mutable state mistakes.
  - `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md`: use the correct session identity boundary.
  - `docs/notes/2026-05-13-conversation-idle-timeout-task-completion-postmortem.md`: lifecycle status paths need explicit tests because parallel cleanup/completion paths diverge easily.

## Implementation Checklist

- [x] Add crash recovery fields to `SessionHost` and add `StatusRecovering` / `StatusRecovered`.
- [x] Add a structured `agent_crash_report` broadcast payload containing agent type, recovery result, attribution, stderr, truncation flag, suggestion, and timestamp.
- [x] Detect crash-like prompt errors in `finishPromptWithError()` (`EOF`, broken pipe, peer disconnected, connection reset) and, when the current agent can be recovered, set crash state and defer task completion to `monitorProcessExit()`.
- [x] Preserve normal timeout/cancel/non-crash prompt error behavior.
- [x] Teach process restart to pass the prior ACP session ID when crash recovery is active, not only for intentional prompt cancel.
- [x] Ensure crash recovery uses `LoadSession` only and fails rather than falling back to `NewSession` when `LoadSession` is unsupported or fails.
- [x] After successful crash recovery, send an `awaiting_followup` task callback and broadcast the crash report/status without auto-sending a follow-up prompt.
- [x] After failed crash recovery, fall back to terminal failure while still broadcasting the crash report with stderr.
- [x] Update `makeTaskCompletionCallback()` to treat the recovery stop reason as `awaiting_followup`.
- [x] Add focused Go tests for crash error classification, recovery callback behavior, crash report broadcast shape, and no-recovery cases.
- [x] Run VM agent Go tests and relevant repo validation.

## Acceptance Criteria

- [ ] Agent crash mid-session triggers `LoadSession` recovery rather than immediate task failure.
- [ ] Recovered sessions transition to `awaiting_followup` so the user can decide what to do next.
- [ ] Crash report message is displayed to clients with agent name, fault attribution, stderr, and vendor-reporting suggestion.
- [ ] Failed recovery still surfaces crash information before the task fails.
- [ ] Existing cancel-restart behavior is not regressed.
- [ ] Rapid exits under 5 seconds still follow the existing rapid-exit error path without recovery.
- [ ] Recovery attempts still respect `maxRestartAttempts`.

## References

- Idea: `01KS7DKYD10FKRGFXZWD88Q46W`
- Task: `01KS7HGHRYEQXA0BYQ82G6ZTNP`
