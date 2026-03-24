# Auto-Resume Suspended ACP Sessions in Project Chat

## Problem

When an ACP session goes idle and the VM agent auto-suspends it (no WebSocket viewers for `IdleSuspendTimeout`), the project chat UI shows "Agent is not connected" and cannot deliver follow-up messages. The workspace chat works because `Workspace.tsx:handleResumeSession()` (line 1013) explicitly calls `resumeAgentSession()` when clicking a suspended tab — the project chat lacks this.

## Research Findings

### Key Code Paths

1. **Working implementation (workspace chat)**: `Workspace.tsx:1013-1027` — calls `resumeAgentSession(id, sessionId)`, refreshes session list, navigates to session
2. **Project chat hook**: `useProjectAgentSession.ts` — wraps `useAcpSession` + `useAcpMessages`. Enabled for active/idle sessions (line 404). Returns `isAgentActive`, `isConnecting`, `sendPrompt`, `cancelPrompt`
3. **Follow-up handler**: `ProjectMessageView.tsx:610-668` — `handleSendFollowUp()` checks `agentSession.isAgentActive` before sending ACP prompt. Falls back to error message if agent not active
4. **Resume API**: `api.ts:1027-1035` — `resumeAgentSession(workspaceId, sessionId)` POSTs to `/api/workspaces/:id/agent-sessions/:sid/resume`
5. **Server-side resume**: `agent-sessions.ts:333-364` — Updates D1 status to 'running', calls `resumeAgentSessionOnNode()` for suspended sessions (best-effort)
6. **VM agent auto-resume fallback**: `agent_ws.go:96-117` — When WebSocket attaches to suspended session, auto-resumes on the node

### Architecture Understanding

- The project chat `handleSendFollowUp()` (line 657) only sends via ACP if `agentSession.isAgentActive` — which requires `state === 'ready' || state === 'prompting'`
- When the session is idle/suspended, the ACP WebSocket is still enabled (line 404) and will attempt to connect. The VM agent's auto-resume fallback (agent_ws.go:96-117) will auto-resume on WebSocket attach
- However, if the control plane hasn't resumed the session in D1 yet, the ACP connection may fail. The resume API call ensures both D1 status and node status are updated
- The idle countdown timer (lines 585-607) runs when `sessionState === 'idle'` — it should pause during resume

### Gap Analysis

- `handleSendFollowUp()` shows error "Agent is not connected" when `isAgentActive` is false — no attempt to resume
- No "resuming" UI state exists in project chat — only error/connecting states
- No message queueing mechanism exists for messages sent during resume
- The `AgentErrorBanner` (line 1332) shows either error details or generic "Agent offline" warning — no resume state

## Implementation Checklist

- [ ] 1. Add `resumeAgentSession` import to `ProjectMessageView.tsx`
- [ ] 2. Add `isResuming` state and `pendingFollowUp` ref to `ProjectMessageView`
- [ ] 3. Add `resumeSession()` helper function that calls `resumeAgentSession(workspaceId, sessionId)` with error handling
- [ ] 4. Modify `handleSendFollowUp()` to call `resumeSession()` when agent is not active and session is idle
- [ ] 5. Queue the follow-up message in `pendingFollowUp` ref during resume
- [ ] 6. Add effect to flush `pendingFollowUp` when `agentSession.isAgentActive` becomes true
- [ ] 7. Add "Resuming agent..." UI banner (distinct from error/connecting states)
- [ ] 8. Pause idle countdown timer during active resume attempt
- [ ] 9. Handle resume failure: show "Could not resume agent — workspace may have been cleaned up" error
- [ ] 10. Add unit tests for the resume flow logic
- [ ] 11. Add behavioral tests for the "Resuming agent..." UI state

## Acceptance Criteria

- [ ] User returns to idle/suspended session in project chat -> agent automatically resumes without manual intervention
- [ ] "Resuming agent..." loading state shown during resume (not an error)
- [ ] Follow-up messages sent during resume are queued and delivered once agent is ready
- [ ] If resume fails (workspace deleted, node down), show clear error with explanation
- [ ] Existing workspace chat resume behavior unchanged
- [ ] Idle countdown timer pauses during active resume attempt

## References

- apps/web/src/hooks/useProjectAgentSession.ts
- apps/web/src/components/chat/ProjectMessageView.tsx
- apps/web/src/pages/Workspace.tsx (handleResumeSession, line 1013)
- apps/web/src/lib/api.ts (resumeAgentSession, line 1027)
- apps/api/src/routes/workspaces/agent-sessions.ts (resume route, line 325)
- packages/vm-agent/internal/server/agent_ws.go (auto-resume fallback, line 96)
