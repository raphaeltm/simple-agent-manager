# Project Chat Auto-Resume Suspended ACP Sessions

## Problem

When an ACP session goes idle and gets auto-suspended by the VM agent (after `IdleSuspendTimeout` with no viewers), the project chat only resumes the agent when the user **sends a follow-up message**. If the user just navigates back to the chat without sending a message, they see the idle state but the agent may not reconnect — the ACP WebSocket's automatic reconnection (via visibility change handler + VM agent auto-resume on WS attach) can fail due to reconnection timeout, stale state, or the `wasConnectedRef` guard.

The workspace chat (`Workspace.tsx`) handles this correctly by calling `resumeAgentSession()` when the user clicks a suspended session tab.

## Research Findings

### Existing Resume Logic (ProjectMessageView.tsx)
- **Lines 351-353**: `isResuming`, `resumeError` state, `pendingFollowUpRef` for queuing messages
- **Lines 689-715**: `handleSendFollowUp` calls `resumeAgentSession()` when idle and agent not active → queues message → flushes when `isAgentActive` becomes true
- **Lines 628-636**: Effect flushes pending follow-up when `isAgentActive` becomes true
- **Lines 782-794**: "Resuming agent..." banner and error banner UI
- **Line 605**: Idle countdown already pauses when `isResuming` is true
- **Line 409**: `useProjectAgentSession` enabled for both `'active'` and `'idle'` sessions

### Key Gap
- **No auto-resume on session visit** — The resume logic only triggers when `handleSendFollowUp` is called. Navigating to/returning to an idle session does not proactively call `resumeAgentSession()`.

### VM Agent Auto-Resume on WebSocket Attach
- `agent_ws.go:96-117`: Auto-resumes suspended sessions when WebSocket connects
- `Suspend()` disconnects viewers with close code 1001 (CloseGoingAway) → triggers 'immediate' reconnection strategy in `useAcpSession`
- But reconnection can fail if: timeout expires while user is away, `wasConnectedRef` is false, or token fetch fails

### useProjectAgentSession
- Wraps `useAcpSession` + `useAcpMessages`
- `isAgentActive`: `state === 'ready' || state === 'prompting'`
- `reconnect()` is available via `agentSession.session.reconnect()` — resets backoff, forces reconnection
- Does not currently expose `reconnect` directly

### Resume API
- `POST /api/workspaces/:id/agent-sessions/:sessionId/resume` — idempotent, returns current status if already running
- Client: `resumeAgentSession(workspaceId, sessionId)` in `api.ts`

## Implementation Checklist

- [x] 1. **Add `reconnect` to `useProjectAgentSession` return type** — expose it directly for cleaner API
- [x] 2. **Add auto-resume effect in `ProjectMessageView.tsx`**:
  - Trigger when: `sessionState === 'idle'` AND `!agentSession.isAgentActive` AND `!agentSession.isConnecting` AND `!isResuming` AND `!isProvisioning` AND `session?.workspaceId` AND `agentSessionId`
  - Use a ref guard (`hasAttemptedAutoResumeRef`) to prevent repeated attempts for the same session
  - Wait ~2 seconds to let the ACP WebSocket's own reconnection succeed first
  - If agent is still not active after delay, call `resumeAgentSession()` API
  - Then call `agentSession.reconnect()` to force ACP WebSocket reconnection
  - Show "Resuming agent..." banner during the process
  - Handle errors (workspace deleted, node down)
  - Reset guard when `sessionId` changes
- [x] 3. **Coordinate with existing follow-up resume** — ensure `handleSendFollowUp` doesn't double-resume if auto-resume is already in progress
- [x] 4. **Add behavioral tests** for auto-resume (9 new tests, all passing)
- [x] 5. **Verify idle countdown pauses during auto-resume** — verified: line 605 already checks `isResuming`

## Acceptance Criteria

- [ ] User returns to idle/suspended session in project chat → agent automatically resumes without manual intervention
- [ ] "Resuming agent..." loading state shown during resume process (not an error)
- [ ] Follow-up messages sent during resume are queued and delivered once agent is ready
- [ ] If resume fails (workspace deleted, node down), show clear error with explanation
- [ ] Existing workspace chat resume behavior unchanged
- [ ] Idle countdown timer pauses during active resume attempt

## References

- Idea: 01KMFS9V27Y1XD8HYNFP4W42MM
- `apps/web/src/components/chat/ProjectMessageView.tsx` — main implementation target
- `apps/web/src/hooks/useProjectAgentSession.ts` — expose `reconnect`
- `apps/web/src/pages/Workspace.tsx:1013-1027` — reference resume implementation
- `packages/acp-client/src/hooks/useAcpSession.ts:733-765` — manual reconnect logic
- `packages/vm-agent/internal/server/agent_ws.go:96-117` — VM agent auto-resume on WS attach
