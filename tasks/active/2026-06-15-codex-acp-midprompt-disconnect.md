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

## 2026-07-11 Reopened Investigation

### Production evidence

- PR #1563 deployed commit `805da56e` to production at `2026-07-11T13:40:05Z`.
- The latest failure before that deployment was task `01KX8A5E81Q82NW674FSFT73J6`, updated `2026-07-11T10:55:52.812Z`, with the exact terminal error:
  `Agent process disconnected during prompt and cannot be recovered automatically: {"code":-32603,"message":"Internal error","data":{"error":"peer disconnected before response"}}`.
- No matching task failure or warning was observed after deployment. That short, idle window is not evidence of resolution: #1563 did not exercise a long prompt, permission/tool activity, process loss, or `LoadSession`.

### Root cause

`HandlePrompt` retained no immutable recovery prerequisites. A process exit could let `monitorProcessExit` clear `sessionID` and `agentSupportsLoadSession` before the blocked ACP `Prompt` returned `peer disconnected before response`. `finishPromptWithError` then read cleared live fields and incorrectly classified a LoadSession-capable prompt as unrecoverable.

The ACP peer closes JSON-RPC first: SAM receives `peer disconnected before response` without a prompt deadline or user cancellation. SAM may subsequently stop the process deliberately to advance recovery, but that happens after the peer disconnect.

### Implementation checklist

- [x] Capture ACP session ID, agent type, LoadSession capability, and process identity before Prompt.
- [x] Fall back to prompt-start prerequisites if process-exit cleanup clears live state.
- [x] Carry the captured ACP session ID into the recovery episode so restart requires `LoadSession`.
- [x] Add sanitized diagnostics naming each truly missing prerequisite.
- [x] Keep unrecoverable failure explicit and terminal.
- [x] Add exact JSON-RPC recoverable race and terminal diagnostic/redaction coverage.
- [x] Phase 5 review round (go, security, constitution, test, docs-sync, task-completion): no CRITICAL/HIGH live bugs. Applied converged go+security fallback tightening (`crashRecovery.sessionID` only on `inProgress`), clarifying comments, and AC-aligned test additions (per-prerequisite terminal diagnostics for acpSessionId/agentType/all-three; captured-session LoadSession identity assertion; agentType partial-clear fallback; `crashRecoveryInProgress==false` on terminal path). Race + full vm-agent suites green.
- [ ] Validate replacement Codex adapter with long tool/permission activity and real `LoadSession` recovery on staging.
- [ ] Complete required reviews, CI, staging coordination, merge, and production monitoring.

### Updated acceptance criteria

- A peer disconnect returned after live ACP fields clear still starts recovery with the prompt-start session ID.
- Recovery requires `LoadSession`; it never silently falls back to `NewSession`.
- Truly unrecoverable cases identify missing `acpSessionId`, `loadSessionCapability`, and/or `agentType` without exposing credentials.
- Users receive recovered status or an explicit terminal error; no silent stall is introduced.
