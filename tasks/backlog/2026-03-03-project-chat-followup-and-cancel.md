# Project Chat: Follow-up Messages Fail Silently & Cancel Signal Missing

## Summary

After an agent completes its initial task in project chat, the user cannot effectively interact further. Follow-up messages appear to send (optimistic UI) but produce no agent response and no error feedback. The cancel/stop signal available in workspace chat is entirely absent from project chat. These are spec'd features (022 FR-024, FR-025, FR-026) that are partially implemented but broken at integration boundaries.

## Context

Discovered during live testing on 2026-03-03. The user can submit an initial task, see the agent's streamed tool calls and responses, but after the agent finishes:
- Sending a follow-up message results in "nothing" — no agent response, no error
- There is no cancel/stop button (unlike workspace chat which has suspend/resume/stop via ACP)

## Root Cause Analysis

### Issue 1: Follow-up prompt errors are swallowed silently

**Severity:** Critical — user has no feedback that their message failed

When the user sends a follow-up, `handleSendFollowUp()` in `ProjectMessageView.tsx:560-567` calls `sendFollowUpPrompt()` with a `.catch()` that only logs to `console.warn`. The user sees their optimistic message but never gets an error banner, toast, or any indication of failure.

The API endpoint `POST /sessions/:id/prompt` (`chat.ts:215-292`) can fail for several reasons after agent completion:
- **404**: "No active workspace found" — workspace status changed to `stopped` (idle cleanup ran)
- **404**: "No running agent session found" — agent session status stale in D1
- **409**: "Workspace node is no longer running" — node destroyed after warm timeout
- **VM agent 409**: "Agent is not ready for prompts" — Claude Code process failed to auto-restart

All of these are caught silently. The 30-second `promptPending` timeout eventually clears the "Agent is working..." indicator, leaving the user with no explanation.

**Code paths:**
- UI error swallowing: `apps/web/src/components/chat/ProjectMessageView.tsx:560-567`
- API checks: `apps/api/src/routes/chat.ts:235-278`
- VM agent prompt handler: `packages/vm-agent/internal/server/workspaces.go:707-775`

### Issue 2: Cancel/stop button not implemented in project chat

**Severity:** High — spec'd feature (FR-025) marked complete but missing

Spec 022 requires: "Active sessions MUST support cancel/pause of agent execution, allowing the user to add context or instructions before the agent resumes."

The **backend is fully ready**:
- VM agent: `POST /agent-sessions/:id/stop`, `/suspend`, `/resume` (workspaces.go:779, 843, 881)
- API service: `stopAgentSessionOnNode()`, `suspendAgentSessionOnNode()`, `resumeAgentSessionOnNode()` (node-agent.ts)
- API route: `POST /sessions/:id/stop` (chat.ts:180)
- Client function: `stopChatSession()` (api.ts:529)

The **UI has nothing wired up**:
- No cancel/stop button in `ProjectMessageView`
- `stopChatSession` is exported from `api.ts` but never called from chat components
- Workspace chat (`ChatSession.tsx`) has full ACP-based suspend/resume/stop; project chat has none

Task T020 in specs/022 was marked complete but referenced "preserve existing cancel/pause button from ACP chat protocol" — the ACP buttons exist in workspace chat, not project chat.

### Issue 3: Idle timer not reset on follow-up prompt (server-side)

**Severity:** Medium — follow-up within idle window still counts down to cleanup

The client calls `resetIdleTimer()` only when `sessionState === 'idle'` (ProjectMessageView.tsx:511). But the server-side prompt endpoint (`chat.ts:215`) does NOT reset the idle cleanup alarm. If the user sends follow-ups while the agent is still processing (state = `active`, not yet `idle`), the 15-minute timer keeps ticking from the original `agent_completed_at`.

Also, subsequent follow-ups after the first idle→active transition don't reset the timer again because the client only calls `resetIdleTimer` when `sessionState === 'idle'`, and the first follow-up sets it back to `active`.

**Code paths:**
- Client-side reset: `apps/web/src/components/chat/ProjectMessageView.tsx:511-525`
- Server-side prompt handler (no reset): `apps/api/src/routes/chat.ts:215-292`
- Idle cleanup scheduler: `apps/api/src/durable-objects/project-data.ts:560-590`

### Issue 4: Agent process restart after completion is unreliable

**Severity:** Medium — follow-ups fail if Claude Code doesn't restart

After the initial task completes, the Claude Code process exits. The VM agent auto-restarts it (up to 3 attempts, `session_host.go:1043-1095`). If restart fails (rapid crash <5s, max retries exceeded), SessionHost enters `HostError` and rejects all prompts with 409.

No feedback reaches the user — same silent `.catch()` path as Issue 1.

## Architectural Constraints (When Follow-ups CAN'T Work)

These are by-design limitations, not bugs:

| Scenario | Cause | User action |
|----------|-------|-------------|
| Idle timeout expired (15 min default) | Session stopped, workspace stopped, task completed by DO alarm | Start new task |
| Node destroyed (warm timeout + cron sweep) | DNS gone, VM gone | Start new task |
| Task transitioned to `completed` via callback | `cleanupTaskRun()` stops workspace immediately | Start new task |
| Agent crash (3 restart failures) | SessionHost in `HostError` | Needs suspend/resume (Issue 2) or new task |

In all these cases, the user should see a clear message explaining why follow-up is no longer possible and guiding them to start a new task.

## Data Flow Trace

```
FOLLOW-UP MESSAGE (happy path, within idle window):

1. User types message in FollowUpInput
   → ProjectMessageView.tsx:handleSendFollowUp()

2. Optimistic message added to UI state
   → setMessages([...prev, { id: 'optimistic-...', ... }])

3. Message sent via WebSocket for persistence
   → ws.send({ type: 'message.send', sessionId, content })
   → ProjectData DO:webSocketMessage() persists + broadcasts

4. Prompt forwarded to agent via API
   → sendFollowUpPrompt() → POST /sessions/:id/prompt
   → chat.ts:215 → checks workspace(running), node(active/warm), agentSession(running)
   → sendPromptToAgentOnNode() → POST to VM agent /prompt
   → VM agent handleSendPrompt() → dispatches to Claude Code process

5. Agent response flows back
   → Claude Code → ACP messages → VM agent message reporter
   → POST /api/workspaces/:id/messages → ProjectData DO:persistMessageBatch()
   → WebSocket broadcast 'messages.batch' → browser renders

FAILURE POINT (step 4): Any check failure returns HTTP error.
The error is caught by .catch() at ProjectMessageView.tsx:560 and logged
to console.warn — user sees nothing.
```

## Acceptance Criteria

- [ ] When a follow-up prompt fails (404, 409, network error), display an inline error message in the chat UI explaining why and suggesting next steps
- [ ] Add a cancel/stop button to the project chat that calls `stopAgentSessionOnNode()` or `suspendAgentSessionOnNode()` when the agent is actively processing
- [ ] The cancel button should be visible when `sessionState === 'active'` and `promptPending === true` (or whenever the agent is processing)
- [ ] Server-side prompt endpoint resets the idle cleanup timer when a follow-up is successfully forwarded
- [ ] When the session enters a terminal state where follow-ups are impossible (workspace stopped, node destroyed), display a clear message with guidance to start a new task
- [ ] Idle timer reset works correctly for consecutive follow-ups (not just the first one)

## Related

- `tasks/backlog/2026-03-02-chat-message-flow-bugs.md` — BUG-1 (WebSocket message drop) was fixed in commit 1be46b4; remaining UX issues overlap
- `specs/022-simplified-chat-ux/spec.md` — FR-024 (follow-up routing), FR-025 (cancel/pause), FR-026 (idle follow-up)
- `specs/022-simplified-chat-ux/tasks.md` — T020 marked complete but cancel not implemented

## Files Involved

**Frontend:**
- `apps/web/src/components/chat/ProjectMessageView.tsx` — follow-up handler, error display, cancel button (to add)
- `apps/web/src/hooks/useChatWebSocket.ts` — WebSocket message handling
- `apps/web/src/lib/api.ts` — `sendFollowUpPrompt()`, `stopChatSession()`, agent session control functions

**Backend:**
- `apps/api/src/routes/chat.ts` — prompt endpoint, session stop endpoint
- `apps/api/src/durable-objects/project-data.ts` — idle cleanup, session lifecycle
- `apps/api/src/services/node-agent.ts` — VM agent communication (stop, suspend, resume, prompt)

**VM Agent:**
- `packages/vm-agent/internal/server/workspaces.go` — prompt, stop, suspend, resume handlers
- `packages/vm-agent/internal/acp/session_host.go` — SessionHost lifecycle, auto-restart logic
