# Lift the codex LoadSession recovery terminal-error guard

## Problem Statement

Every time codex-acp drops its ACP stdio connection mid-prompt, SAM's crash
recovery **succeeds** — it restarts codex and `LoadSession` resumes the exact
same ACP session ID. But the recovery is then deliberately discarded and the
task is marked `failed` with:

> Task failed: Agent openai-codex LoadSession recovery needs staging validation before being reported as recovered

This is a false failure. The recovery worked; the reporting is wrong.

## Root Cause

`packages/vm-agent/internal/acp/session_host_process.go:179-184`:

```go
func (h *SessionHost) resumeShouldReportTerminalErrorLocked(agentType string) bool {
    // TODO: empirically validate codex-acp LoadSession coherence on staging. Until
    // that round-trip proves coherent, report Codex disconnect recovery as a
    // terminal task error instead of a possibly misleading "recovered".
    return agentType == "openai-codex"
}
```

`monitorProcessExit()` calls this after a successful crash-recovery restart. For
`openai-codex` it returns `true`, converting the successful recovery into a
terminal `"error"` stopReason → task callback marks the task `failed`.
claude-code in the same situation reports `"recovered"` → `awaiting_followup`.

The guard was an intentional conservative placeholder from PR #1256 (task
`tasks/archive/2026-06-08-vm-agent-codex-prompt-deadlock-recovery.md`, merged
2026-06-09). That task's hard constraints explicitly skipped staging validation
of codex `LoadSession` coherence and stated it "must be completed before any
future merge." The validation was never done and no tracking idea existed.

## Evidence

Confirmed in two debug packages:
- dbg1 (`/workspaces/.private/dbg1/vm-agent.log`): lines 2359–2386. Disconnect
  (`-32603 peer disconnected before response`) → defer to crash recovery →
  `ACP: LoadSession succeeded` (same session `019eca85-...`) → task callback
  `toStatus "failed"` with the guard message. Task `01KV584RKDY579QPR1GSZ35GMS`.
- dbg2: lines 515–540, identical pattern.

## Implementation Checklist

- [ ] Validate codex-acp `LoadSession` coherence on staging: trigger a real
      codex mid-prompt disconnect, confirm the resumed session has correct state
      (history, working dir, model, pending tool state) after `LoadSession`.
- [ ] Based on the result, either remove `resumeShouldReportTerminalErrorLocked`
      (so codex recovery reports `"recovered"`/`awaiting_followup` like
      claude-code) or replace it with a precise coherence check rather than a
      blanket agentType match.
- [ ] Add Go tests covering codex successful-recovery → `"recovered"` mapping.
- [ ] Add a server-side regression test asserting a recovered codex session
      maps to `awaiting_followup`, not terminal failure.
- [ ] Remove the `TODO` and the staging-validation note once validated.

## Acceptance Criteria

- A codex mid-prompt disconnect that recovers via `LoadSession` no longer marks
  the task `failed`.
- Codex and claude-code recovery reporting are consistent (both
  `"recovered"`/`awaiting_followup`) unless a coherence check proves codex is
  genuinely incoherent, in which case the failure message is accurate.

## References

- `packages/vm-agent/internal/acp/session_host_process.go:179-184`
- `tasks/archive/2026-06-08-vm-agent-codex-prompt-deadlock-recovery.md` (PR #1256)
- Related trigger task: `2026-06-15-codex-acp-midprompt-disconnect.md`
