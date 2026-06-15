# Investigate codex-acp mid-prompt connection drops

## Problem Statement

codex-acp drops its ACP stdio connection partway through an active prompt,
typically minutes in, while tool/permission calls are in flight. SAM's crash
recovery currently masks this (LoadSession resumes the session), but the
underlying instability is real and is the trigger behind the recurring
"LoadSession recovery needs staging validation" task failures.

## Observed Signature

- JSON-RPC `-32603 "Internal error"` / `"peer disconnected before response"`
- `Agent stderr: "context canceled"`
- Process `exit status 1`, uptime ~180s (mid-prompt, not startup)
- WARN `"ACP Prompt failed because agent disconnected; deferring to crash recovery"`,
  `"agentType":"openai-codex"`

## Evidence

- dbg1 (`/workspaces/.private/dbg1/vm-agent.log`): lines 2352–2366. Prompt sent
  (session `019eca85-b5e0-7e50-896d-17bb0cc858bf`), permission requests served,
  then `"connection closed","cause":"peer connection closed"` at 09:06:40,
  ~180s uptime.
- dbg2: lines 515–540, same shape.

## Investigation Checklist

- [ ] Reproduce on staging: run a long codex prompt with multiple tool/permission
      calls and capture vm-agent + container (`docker logs`) + codex stderr.
- [ ] Determine which side closes the connection (codex process exiting vs. SAM
      cancelling the context). `context canceled` in stderr suggests an upstream
      cancel — trace where the ctx cancel originates.
- [ ] Check codex-acp version and whether there are known disconnect/timeout
      issues at that version; check for any prompt/turn timeout in codex-acp.
- [ ] Check resource pressure in the container (OOM, CPU starvation) around the
      drop time using the debug-package metrics DB.
- [ ] Determine whether a specific tool-call pattern (large output, long-running
      permission wait) precedes every drop.

## Acceptance Criteria

- Root cause of the mid-prompt disconnect identified with evidence (which side
  closes, why).
- Either a fix that prevents the disconnect, or a documented upstream codex-acp
  bug with a tracking reference, or a confirmed config/timeout adjustment.

## References

- `packages/vm-agent/internal/acp/session_host_prompt.go` (`finishPromptWithError`, `isCrashPromptError`)
- `packages/vm-agent/internal/acp/session_host_crash.go`
- Related reporting task: `2026-06-15-codex-loadsession-recovery-reporting-guard.md`
