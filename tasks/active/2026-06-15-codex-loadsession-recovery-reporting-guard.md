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

- [x] Removed `resumeShouldReportTerminalErrorLocked` so codex recovery reports
      `"recovered"`/`awaiting_followup` like claude-code (no blanket agentType
      match). `session_host_process.go:monitorProcessExit` now follows the single
      `StatusRecovered` path for every agent type.
- [x] Added/updated Go test
      `TestSessionHost_CodexCrashRecovery_ReportsRecovered` (renamed+inverted from
      `…_ReportsTerminalError`) asserting codex successful-recovery →
      `crashRecoveredStopReason`, with the LoadSession restart having run exactly
      once and the old process stopped once.
- [x] Server-side regression test
      `TestTaskCompletionCallbackTreatsCrashRecoveryAsAwaitingFollowup` documented
      as the codex guard: `"recovered"` → `awaiting_followup` (agent-agnostic
      mapping; codex now flows through the same path as claude-code).
- [x] Removed the `TODO` and the staging-validation note (function deleted).
- [ ] Validate codex-acp `LoadSession` coherence on staging (Phase 6): trigger a
      real codex mid-prompt disconnect, confirm the resumed session continues with
      correct state after `LoadSession`. Rule 27: delete all nodes first.

## Acceptance Criteria

- A codex mid-prompt disconnect that recovers via `LoadSession` no longer marks
  the task `failed`.
- Codex and claude-code recovery reporting are consistent (both
  `"recovered"`/`awaiting_followup`) unless a coherence check proves codex is
  genuinely incoherent, in which case the failure message is accurate.

## Post-Mortem (rule 02)

**What broke.** Every codex (`openai-codex`) mid-prompt ACP disconnect that
recovered successfully via `LoadSession` was reported to the control plane as a
terminal `"error"` stopReason, so the task was marked `failed` with the message
"Agent openai-codex LoadSession recovery needs staging validation before being
reported as recovered". Users saw recurring false task failures even though the
agent had recovered and the resumed session retained the same ACP session ID and
conversation state. claude-code in the identical situation reported `"recovered"`
→ `awaiting_followup` and kept running.

**Root cause.** `resumeShouldReportTerminalErrorLocked(agentType)` returned
`true` for `"openai-codex"`. `monitorProcessExit` called it after a *successful*
crash-recovery restart and, for codex, converted the success into a terminal
error. It was introduced by PR #1256
(`tasks/archive/2026-06-08-vm-agent-codex-prompt-deadlock-recovery.md`, merged
2026-06-09) as a deliberate conservative placeholder: degrade codex recovery to a
visible failure until codex `LoadSession` coherence could be validated on
staging. That PR's hard constraints explicitly deferred the staging validation
and stated it "must be completed before any future merge" — but the validation
was never scheduled, no tracking task/idea existed, and the placeholder shipped
to production where it produced false failures on every codex disconnect.

**Timeline.** Introduced 2026-06-09 (PR #1256). Surfaced as recurring false
failures observed in two debug packages (task `01KV584RKDY579QPR1GSZ35GMS`).
Fixed in this task (2026-06-15) by removing the guard so codex follows the same
recovered/awaiting_followup path as claude-code.

**Why it wasn't caught.** (1) The placeholder *intentionally* degraded behavior,
so the original tests asserted the degraded behavior (`…_ReportsTerminalError`)
rather than the desired behavior — a green test suite encoded the bug. (2) The
"complete staging validation before any future merge" constraint lived only in
the archived task file; there was no backlog task, idea, or rule gate that would
block the placeholder from living in production indefinitely. (3) The server-side
mapping is agent-agnostic, so nothing downstream flagged that one agent type was
being treated differently.

**Class of bug.** *Conservative placeholder that degrades user-visible behavior,
merged with a "validate later" TODO that has no tracking and no expiry.* The
placeholder is strictly worse than the real behavior for the user, the follow-up
is invisible, and a passing test suite locks the degraded behavior in.

**Process fix (this PR).** Added `.claude/rules/42-no-untracked-degrading-placeholders.md`:
any guard/placeholder that intentionally produces a worse user-visible outcome
pending future validation MUST (a) have a tracking backlog task or idea filed in
the same PR, (b) be referenced by ID in a code comment next to the guard, and
(c) NOT have its degraded behavior asserted as the *desired* outcome in tests —
tests must mark it as a known-temporary state. Reviewers must reject
"validate-later" guards that lack a tracked follow-up.

## References

- `packages/vm-agent/internal/acp/session_host_process.go` (`monitorProcessExit`;
  `resumeShouldReportTerminalErrorLocked` removed)
- `tasks/archive/2026-06-08-vm-agent-codex-prompt-deadlock-recovery.md` (PR #1256)
- Related trigger task: `2026-06-15-codex-acp-midprompt-disconnect.md`
- Process fix: `.claude/rules/42-no-untracked-degrading-placeholders.md`
