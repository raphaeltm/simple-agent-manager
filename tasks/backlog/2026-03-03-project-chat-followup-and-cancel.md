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

### Issue 2: Cancel signal architecture gap — no HTTP cancel endpoint

**Severity:** High — spec'd feature (FR-025) marked complete but missing

Spec 022 requires: "Active sessions MUST support cancel/pause of agent execution, allowing the user to add context or instructions before the agent resumes."

**The VM agent has a robust two-stage cancel mechanism** — but it's only reachable via ACP WebSocket, not HTTP:
- `CancelPrompt()` (`session_host.go:642`): Cancels the prompt context → 5s grace period (`promptCancelGracePeriod()`) → `triggerPromptForceStopIfStuck()` kills agent process
- `ForwardToAgent()` (`gateway.go:353`): Forwards raw `session/cancel` JSON-RPC to agent stdin so Claude Code can react
- This is triggered by the ACP WebSocket gateway (`gateway.go:352`) when it receives `{ "jsonrpc": "2.0", "method": "session/cancel" }`

**The project chat uses a completely different communication path** (HTTP, not ACP WebSocket):
- Project chat sends follow-ups via HTTP POST `/sessions/:id/prompt` → API → VM agent `handleSendPrompt()`
- There is no `POST /agent-sessions/:id/cancel` HTTP endpoint on the VM agent
- There is no `POST /sessions/:id/cancel` endpoint on the API
- The existing `POST /sessions/:id/stop` (chat.ts:180) stops the **entire session**, not just the current prompt

**What exists but doesn't solve the problem**:
- VM agent: `POST /agent-sessions/:id/stop` (workspaces.go:779) — kills agent process entirely
- VM agent: `POST /agent-sessions/:id/suspend` (workspaces.go:843) — suspends agent session
- API service: `stopAgentSessionOnNode()`, `suspendAgentSessionOnNode()` (node-agent.ts)
- Client function: `stopChatSession()` (api.ts:529) — stops session, not just current prompt

**The UI has nothing wired up**:
- No cancel/stop button in `ProjectMessageView`
- `stopChatSession` is exported from `api.ts` but never called from chat components
- Workspace chat (`ChatSession.tsx`) has full ACP-based suspend/resume/stop via direct WebSocket; project chat has none

**What's needed**: A new `POST /agent-sessions/:id/cancel` HTTP endpoint on the VM agent that calls `host.CancelPrompt()` + `host.ForwardToAgent(cancelMsg)`, mirroring what the ACP WebSocket gateway does at `gateway.go:352-353`. Then a corresponding API route and UI button.

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

### Issue 5: `promptPending` indicator has no signal for agent response arrival

**Severity:** Medium — UX confusion during follow-up processing

When the user sends a follow-up, `promptPending` is set to `true` (ProjectMessageView.tsx:576) with a 30-second safety timeout. The "Agent is working..." indicator appears. However:

1. **No event when agent starts responding**: The response path is indirect — VM agent `SessionUpdate()` → `MessageReporter.Enqueue()` → HTTP batch `POST /api/workspaces/:id/messages` → ProjectData DO `persistMessageBatch()` → WebSocket broadcast `messages.batch` → browser. When new messages arrive via this path, `promptPending` is NOT cleared.

2. **Only cleared by**: (a) 30s timeout (`promptPendingTimeoutRef`, line 577-579), or (b) `onAgentCompleted` callback (session-level completion). If the agent responds in 2 seconds, the "Agent is working..." indicator stays for 28 more seconds.

3. **Fix needed**: Clear `promptPending` when new assistant messages arrive from the WebSocket after a follow-up was sent. The `onMessage` callback in `useChatWebSocket` (line 366-391) should signal back to `ProjectMessageView` that response messages are arriving.

### Issue 6: `handleSendPrompt` uses `context.Background()` — no server-side timeout

**Severity:** Low — goroutine leak potential

The VM agent's `handleSendPrompt()` dispatches `go host.HandlePrompt(context.Background(), ...)` at `workspaces.go:771`. This goroutine has no timeout — it runs until the agent finishes, crashes, or the process is killed. The HTTP handler returns 202 immediately, so the client isn't affected, but the goroutine lives indefinitely.

Unlike the WebSocket path where HandlePrompt creates its own timeout context (`session_host.go:551`), the HTTP-dispatched goroutine uses `context.Background()`. If HandlePrompt's internal timeout doesn't fire (or the watchdog fails), this goroutine leaks.

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

## Complete Architecture Trace (2026-03-04 deep research)

### Two Parallel WebSocket Paths (Critical to Understanding)

The project chat and the workspace terminal/ACP use **different WebSocket connections**:

1. **ProjectData DO WebSocket** (`GET /api/projects/:projectId/sessions/ws`):
   - Browser → API Worker → `projectDataService.forwardWebSocket()` → ProjectData DO → `ctx.acceptWebSocket()`
   - Used for: chat event broadcasts (`message.new`, `session.created`, `session.stopped`, etc.)
   - Message handler (`project-data.ts:872-908`): handles `ping`, `message.send` (persistence + broadcast)
   - This is what the project chat UI uses for real-time updates

2. **ACP WebSocket** (`GET ws-{workspaceId}.{BASE_DOMAIN}/agent/ws`):
   - Browser → Cloudflare proxy → API Worker subdomain handler (`index.ts:250-334`) → VM agent `handleAgentWS()`
   - Creates Gateway → SessionHost with viewer write pump
   - Used for: direct agent communication (select_agent, session/prompt, session/cancel, session/update streaming)
   - **The project chat view does NOT use this path** — only the workspace terminal page does

### Follow-up Message Path (HTTP, not WebSocket)

```
Browser: handleSendFollowUp() [ProjectMessageView.tsx:526-595]
  ├─ WebSocket: { type: 'message.send' } → ProjectData DO persists + broadcasts (for chat history)
  └─ HTTP: POST /api/projects/:projectId/sessions/:sessionId/prompt [chat.ts:215]
       → Lookup workspace by chatSessionId (D1 query)
       → Verify workspace status = 'running'|'recovery', node = 'active'|'warm'
       → Lookup running agentSession (D1 query)
       → sendPromptToAgentOnNode() [node-agent.ts:277]
            → Sign JWT token with userId + nodeId + workspaceId
            → HTTP POST http://vm-{nodeId}.{BASE_DOMAIN}:8080/workspaces/{workspaceId}/agent-sessions/{sessionId}/prompt
                 → handleSendPrompt() [workspaces.go:707]
                      → Lookup SessionHost by hostKey = workspaceID:sessionID
                      → Check status == HostReady (not HostPrompting/HostError)
                      → Build JSON-RPC params: { prompt: [{ type: "text", text: "..." }] }
                      → go host.HandlePrompt(context.Background(), ..., "control-plane") [ASYNC]
                      → Return 202 Accepted { status: "prompting" }
```

### Response Path (VM Agent → Browser via Indirect Batch)

```
Claude Code process stdout
  → orderedPipe.run() [ordered_reader.go:80] — serializes session/update delivery
  → ACP SDK dispatches to sessionHostClient.SessionUpdate() [session_host.go:1761]
     ├─ broadcastMessage() → all ACP viewers (NOT project chat — it has no ACP viewer)
     └─ ExtractMessages() [message_extract.go:36] → MessageReporter.Enqueue()
          → Batched HTTP POST /api/workspaces/:id/messages [workspaces.ts:1481]
               → Workspace callback auth verification
               → Resolve workspaceId → projectId (D1 query)
               → projectDataService.persistMessageBatch()
                    → ProjectData DO: SQLite insert + dedup
                    → broadcastEvent('messages.batch') → all DO WebSocket clients
                         → Browser's useChatWebSocket onMessage callback
                              → setMessages() renders new messages
```

### Cancel Signal Path (Currently Non-Existent for Project Chat)

**What works (ACP WebSocket path only)**:
```
Browser sends { jsonrpc: "2.0", method: "session/cancel" } via ACP WebSocket
  → Gateway.handleMessage() [gateway.go:311]
  → case "session/cancel" [gateway.go:352]:
       g.host.CancelPrompt() — cancels prompt context
       g.host.ForwardToAgent(data) — sends cancel to agent stdin
  → CancelPrompt() [session_host.go:642]:
       cancelFn() — cancels promptCtx
       After 5s grace period → triggerPromptForceStopIfStuck()
           → Kills agent process, sets HostError
```

**What's missing (HTTP path for project chat)**:
- No `POST /agent-sessions/:id/cancel` on VM agent
- No `POST /sessions/:id/cancel` on API
- No cancel button in ProjectMessageView UI

## Acceptance Criteria

### Follow-up Messages
- [ ] When a follow-up prompt fails (404, 409, network error), display an inline error message in the chat UI explaining why and suggesting next steps
- [ ] Server-side prompt endpoint (`chat.ts:215`) resets the idle cleanup timer when a follow-up is successfully forwarded
- [ ] Idle timer reset works correctly for consecutive follow-ups (not just the first one)
- [ ] When the session enters a terminal state where follow-ups are impossible (workspace stopped, node destroyed), display a clear message with guidance to start a new task
- [ ] `promptPending` indicator clears when the first assistant message arrives via WebSocket after a follow-up, not just on 30s timeout

### Cancel Signal
- [ ] Add `POST /workspaces/:workspaceId/agent-sessions/:sessionId/cancel` HTTP endpoint to VM agent that calls `host.CancelPrompt()` + `host.ForwardToAgent(cancelMsg)`, mirroring `gateway.go:352-353`
- [ ] Add `POST /api/projects/:projectId/sessions/:sessionId/cancel` API endpoint that finds the workspace/agent session and forwards to the VM agent cancel endpoint
- [ ] Add a cancel button to `ProjectMessageView` visible when agent is actively processing (during initial task OR during follow-up prompt)
- [ ] Cancel button should cancel the current prompt (not stop the entire session) — user should still be able to send follow-ups after cancelling
- [ ] After cancellation, display a message indicating the agent was interrupted and the user can send another message

### Reliability
- [ ] `handleSendPrompt` (`workspaces.go:771`) should use a timeout context instead of `context.Background()` to prevent goroutine leaks
- [ ] Agent restart failures surface a user-visible error in project chat (not just console.warn)

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
