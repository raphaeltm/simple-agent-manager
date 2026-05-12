# Restore Cancel Button in Agent Working Indicator

## Problem

PR #978 (`ef889afb`) removed the direct ACP WebSocket connection from `ProjectMessageView` in favor of DO-only messaging. This was a valid architectural change, but it also removed the cancel button from the "Agent is working..." indicator because the old cancel mechanism relied on sending `session/cancel` over the ACP WebSocket.

The cancel button is critical UX — users need to interrupt an off-track agent to guide it, and agents dispatching subtasks need the same ability.

PR #975 (`ce39b03e`) had just fixed the backend to keep sessions alive after cancel (instead of shutting down), but that work is now unreachable because the UI has no way to trigger it.

## Research Findings

### Backend Infrastructure (Already Exists)
- **VM Agent cancel endpoint**: `POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/cancel` (`packages/vm-agent/internal/server/workspaces.go:829,1060-1102`)
- **API service function**: `cancelAgentSessionOnNode()` in `apps/api/src/services/node-agent.ts:377-403` — handles 409 (no prompt in flight) gracefully
- **VM Agent cancel logic**: `SessionHost.CancelPrompt()` in `packages/vm-agent/internal/acp/session_host.go:395-432` — cancels context, starts grace timer

### Missing Pieces
1. **No REST API route** in `apps/api/src/routes/chat.ts` — the prompt route exists at `POST /:sessionId/prompt` (line 395) but there's no `POST /:sessionId/cancel`
2. **No client API function** in `apps/web/src/lib/api/sessions.ts` — `sendFollowUpPrompt()` exists (line 166) but no `cancelPrompt()`
3. **No cancel button in UI** — `ProjectMessageView` (line 231-236) and `WorkspaceChatView` (no cancel at all) both show a spinner with no cancel button

### Pattern to Follow
The prompt forwarding chain: UI → `sendFollowUpPrompt()` → `POST /api/projects/:id/sessions/:sid/prompt` → `sendPromptToAgentOnNode()` → VM agent. The cancel chain should be identical but use the cancel endpoint.

## Implementation Checklist

- [ ] 1. Add `POST /:sessionId/cancel` route in `apps/api/src/routes/chat.ts` — follows same pattern as the prompt route (workspace lookup, node status check, agent session lookup) then calls `cancelAgentSessionOnNode()`
- [ ] 2. Add `cancelAgentPrompt()` client function in `apps/web/src/lib/api/sessions.ts` and export from `apps/web/src/lib/api/index.ts`
- [ ] 3. Add `handleCancelPrompt` to `useSessionLifecycle` hook — calls the new API function, sets agentActivity to 'idle' on success
- [ ] 4. Add `handleCancelPrompt` to `WorkspaceChatView` — same pattern
- [ ] 5. Restore cancel button in `ProjectMessageView` "Agent is working..." indicator — wire to `lc.handleCancelPrompt`
- [ ] 6. Add cancel button in `WorkspaceChatView` "Agent is working..." indicator
- [ ] 7. Add `cancelPrompt` to `UseSessionLifecycleResult` interface
- [ ] 8. Add integration test for the new cancel API route
- [ ] 9. Verify existing cancel tests in VM agent still pass

## Acceptance Criteria

- [ ] Cancel button visible in the "Agent is working..." bar in ProjectMessageView
- [ ] Cancel button visible in the "Agent is working..." bar in WorkspaceChatView
- [ ] Clicking cancel sends REST request to API → VM agent cancel endpoint
- [ ] After cancel, agent activity returns to idle and the input field becomes active for follow-up
- [ ] Cancel handles 409 (no prompt in flight) gracefully — no error shown to user
- [ ] Integration test covers the cancel API route happy path
- [ ] Existing functionality (follow-up prompts, session lifecycle) unaffected

## References

- PR #978: `ef889afb` — DO-only chat architecture (removed ACP WebSocket + cancel button)
- PR #975: `ce39b03e` — Backend fix to keep sessions alive after cancel
- `apps/api/src/routes/chat.ts:391-472` — Prompt route pattern to follow
- `apps/api/src/services/node-agent.ts:377-403` — `cancelAgentSessionOnNode()` service function
- `packages/vm-agent/internal/server/workspaces.go:1060-1102` — VM agent cancel handler
