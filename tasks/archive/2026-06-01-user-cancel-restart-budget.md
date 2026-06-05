# Do not count user prompt cancels against agent crash restart budget

## Problem

When a user cancels an in-flight agent prompt from the UI, the VM agent intentionally stops the ACP process so the session can recover for follow-up prompts. Those intentional user cancels currently increment the same `restartCount` used for unexpected agent crashes. Repeated mobile cancel attempts can therefore exhaust `MaxRestartAttempts` and leave the session in `HostError` even though the exits were user-requested recovery attempts.

## Research Findings

- `packages/vm-agent/internal/acp/session_host.go` marks `intentionalPromptCancelProcessStop` in `StopProcessForPromptCancel()`.
- `packages/vm-agent/internal/acp/session_host_process.go` reads that flag and suppresses rapid-exit crash reporting, but still increments `restartCount` and checks `maxRestartAttempts()`.
- `packages/vm-agent/internal/server/workspaces.go` routes HTTP session cancel requests to `CancelPromptFromControlPlane()`.
- Relevant postmortem pattern: `docs/notes/2026-05-09-mcp-retry-active-agent-stop-postmortem.md` emphasizes testing runtime lifecycle side effects, not only metadata.

## Checklist

- [x] Update VM agent process-exit handling so intentional prompt-cancel restarts do not consume crash restart budget.
- [x] Preserve crash restart accounting for unexpected exits and crash recovery paths.
- [x] Add regression coverage for repeated control-plane prompt cancels with a low `MaxRestartAttempts`.
- [x] Run focused Go tests for `packages/vm-agent/internal/acp`.

## Acceptance Criteria

- User-requested prompt cancellation can restart the agent without incrementing `restartCount`.
- Unexpected agent exits still increment `restartCount` and still reach `agent_max_restarts` after the configured limit.
- Focused VM agent ACP tests pass.
