# Prompt Timeout: Graceful Handling Instead of Agent Kill

**Status:** backlog
**Priority:** high
**Estimated Effort:** 3-5 days
**Created:** 2026-02-20

## Problem Statement

When an ACP prompt exceeds `ACP_PROMPT_TIMEOUT`, the watchdog in `triggerPromptForceStopIfStuck()` kills the entire agent process via `stopCurrentAgentLocked()` → `process.Stop()` → `cmd.Process.Kill()`. This leaves the SessionHost in `HostError` state with `acpConn = nil`, `sessionID = ""`, and `process = nil`. The session is unrecoverable — reconnecting viewers get "No ACP session active" and messages are silently dropped.

This is a fundamental violation of the principle that **chat sessions ALWAYS persist and stay alive unless a user explicitly closes them**.

### Current Behavior

1. Agent starts a long tool call (e.g., `sleep 300` to wait for a GH workflow)
2. `ACP_PROMPT_TIMEOUT` (now 60min, was 10min) fires
3. `watchPromptTimeout()` → `triggerPromptForceStopIfStuck()`:
   - Sets `h.status = HostError`
   - Calls `h.stopCurrentAgentLocked()` — **SIGKILL on the agent**
   - Clears `h.process`, `h.acpConn`, `h.sessionID`
4. `monitorProcessExit()` sees `HostError`, skips auto-restart
5. User refreshes → reconnects to same SessionHost → sends message → dropped

### Interim Fix (shipped)

Default timeout increased from 10min to 60min (`968abb5`). This reduces frequency but doesn't fix the underlying design issue — a 60min+ prompt will still kill the agent.

## Proposed Solution

The prompt timeout should **cancel the prompt, not kill the agent**. The agent process should remain alive and ready for new prompts.

### Option A: Cancel-Only Timeout (Recommended)

When the prompt timeout fires:
1. Cancel the prompt context (already happens)
2. Send a JSON-RPC error to the viewer ("Prompt timed out")
3. Reset SessionHost status to `HostReady` (not `HostError`)
4. **Do NOT call `stopCurrentAgentLocked()`**
5. Let the agent process handle the cancellation gracefully via its stdin
6. Keep `acpConn` and `sessionID` intact for future prompts

The force-stop escalation should only trigger if the agent fails to acknowledge cancellation within a much longer grace period (e.g., 5 minutes, not 5 seconds).

### Option B: Prompt-Level Keepalive

If the agent sends `session/update` messages during long tool calls (which it does — streaming output), use those as proof-of-life to reset the prompt timeout. Only fire the timeout if the agent goes truly silent.

This requires tracking the last `session/update` timestamp and resetting the deadline on each one.

### Option C: Combine A + B

Cancel-only timeout as the safety net, plus keepalive-based deadline extension so well-behaved agents never hit the timeout at all.

## Key Files

| File | What to Change |
|------|---------------|
| `packages/vm-agent/internal/acp/session_host.go:1293-1322` | `triggerPromptForceStopIfStuck()` — don't kill agent |
| `packages/vm-agent/internal/acp/session_host.go:1275-1291` | `watchPromptTimeout()` — cancel-only behavior |
| `packages/vm-agent/internal/acp/session_host.go:505-533` | `CancelPrompt()` — extend grace period |
| `packages/vm-agent/internal/acp/session_host.go:937-947` | `stopCurrentAgentLocked()` — only called on explicit user action |

## Investigation Context

Full root cause analysis was done in the `chat-session-timeouts` branch. Key findings:

- The ping/pong heartbeat path is goroutine-independent of the agent — it's not the cause
- Idle detection is informational only (`RequestShutdown` is disabled) — not the cause
- The **prompt timeout watchdog** is the only code path that autonomously kills an agent during normal operation
- `monitorProcessExit()` skips restart when status is `HostError` (set by the watchdog before the kill)

## Testing Strategy

- [ ] Unit test: prompt timeout cancels prompt but keeps agent alive
- [ ] Unit test: agent process survives timeout, accepts new prompt afterward
- [ ] Unit test: force-stop only triggers after extended grace period with no agent response
- [ ] Integration test: long-running prompt timeout → new prompt succeeds on same session
- [ ] Integration test: viewer reconnect after timeout → session state is `HostReady`

## Success Criteria

- [ ] Prompt timeout never kills the agent process
- [ ] SessionHost remains in `HostReady` after prompt timeout
- [ ] `acpConn` and `sessionID` remain valid after prompt timeout
- [ ] User can send a new prompt immediately after timeout
- [ ] Viewer reconnect shows functional session, not error state
- [ ] Force-stop only occurs on explicit user action or truly unresponsive agent (5+ min grace)

## Related

- Interim fix: `968abb5` (increased default from 10min to 60min)
- Existing task: `tasks/active/2026-02-20-fix-acp-websocket-connection-lost.md` (WebSocket reliability)
