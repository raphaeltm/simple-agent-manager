# Fix ACP Session Context Loss on Follow-Up Messages

**Created**: 2026-03-08
**Type**: Bug fix
**Severity**: High — core chat functionality broken
**Use Speckit**: Yes — for research and implementation

## Problem Statement

When sending follow-up messages in project chat, the agent responds but has no context from the previous conversation. It behaves as if a completely new ACP session was created instead of continuing the existing one. The user IS getting responses (workspace and node are running), but the ACP session context is lost.

## Root Cause Analysis

### Root Cause 1: Agent restart never attempts LoadSession (HIGH CONFIDENCE)

In `packages/vm-agent/internal/acp/session_host.go`, the `monitorProcessExit` function handles agent process crashes/exits. When the agent is restarted (line ~1177):

```go
if err := h.startAgent(ctx, agentType, cred, settings, ""); err != nil {
```

The `loadSessionID` parameter is **always empty string `""`**. This means every restart creates a brand new ACP session via `NewSession()` instead of attempting `LoadSession()` with the previous session's AcpSessionID.

**Why the agent process exits:** The `claude-agent-acp` subprocess may exit between messages due to:
- Internal idle timeout in Claude Code / the ACP bridge
- Memory pressure or OOM kill on the VM
- Unexpected process termination

When it exits, `monitorProcessExit` correctly detects the exit and restarts, but the restart always creates a fresh session with no conversation history.

**The AcpSessionID is available** — it's stored in `h.sessionID` (set during the first `NewSession`). We just need to pass it to `startAgent` during restart.

### Root Cause 2: Frontend auto-select race on WebSocket reconnect (MEDIUM CONFIDENCE)

In `apps/web/src/hooks/useProjectAgentSession.ts`, the auto-select effect (lines 189-203) can fire before the ACP session state is fully initialized on reconnect. If `agentType` is not yet set when `connected` becomes true, the effect calls `switchAgent()`, which triggers `SelectAgent()` on the VM agent — **stopping the current agent and starting a new one**.

### Root Cause 3: Auto-suspend + failed LoadSession (LOWER CONFIDENCE)

After 30 minutes with no viewers (`ACP_IDLE_SUSPEND_TIMEOUT`, default 30m), the session is auto-suspended. On reconnect, `LoadSession` is attempted with the previous AcpSessionID but may fail if the JSONL file is missing/corrupted on disk.

## Key Code Paths

| Path | File | Lines |
|------|------|-------|
| Agent restart (no LoadSession) | `packages/vm-agent/internal/acp/session_host.go` | ~1087-1188 |
| Auto-suspend handler | `packages/vm-agent/internal/server/workspaces.go` | ~848-867 |
| SessionHost creation with previous ID | `packages/vm-agent/internal/server/agent_ws.go` | ~192-269 |
| Frontend auto-select | `apps/web/src/hooks/useProjectAgentSession.ts` | ~189-203 |
| Prompt forwarding (HTTP) | `apps/api/src/routes/chat.ts` | ~215-292 |
| Prompt handling (WebSocket) | `packages/vm-agent/internal/acp/gateway.go` | ~372-374 |

## Implementation Checklist

### Phase 1: Fix agent restart to preserve ACP session (Go)

- [ ] In `monitorProcessExit`, capture the current `h.sessionID` before clearing it
- [ ] Pass the captured sessionID as `loadSessionID` to `startAgent` during restart
- [ ] Add structured logging for restart-with-LoadSession attempts
- [ ] Add test: verify restart attempts LoadSession with previous AcpSessionID

### Phase 2: Frontend auto-select guard (TypeScript)

- [ ] Add guard to prevent auto-select when the SessionHost already has a running agent
- [ ] Ensure `switchAgent` is not called when the existing agentType matches (even during state transitions)
- [ ] Add test for the auto-select guard

### Phase 3: Quality & Testing

- [ ] Run `pnpm typecheck && pnpm lint && pnpm test`
- [ ] Deploy to staging
- [ ] Test follow-up messages: send message, wait for response, send follow-up, verify context preserved
- [ ] Test delayed follow-up: send message, wait 5-10 minutes, send follow-up, verify context preserved
- [ ] Test browser disconnect/reconnect: send message, close tab, reopen, send follow-up

## Acceptance Criteria

1. Follow-up messages maintain conversation context from the initial task prompt
2. Agent restarts attempt LoadSession with the previous ACP session ID
3. Frontend auto-select does not trigger unnecessary agent restarts
4. Follow-up messages work after 5-10 minute delays
5. Follow-up messages work after browser disconnect/reconnect
6. All existing tests pass

## References

- ACP Protocol: Agent Client Protocol (JSON-RPC 2.0 over stdio) — `session/load` restores sessions from JSONL files
- Claude Code sessions stored at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
- `claude-agent-acp` bridge maps ACP `session/load` to Claude SDK's `resume` option
