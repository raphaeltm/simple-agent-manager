# Unify Chat Architecture: Single Agent Communication Path with Two UI Presentations

**Implementation approach:** Full speckit flow (`/speckit.specify` → `/speckit.plan` → `/speckit.tasks` → `/speckit.implement`)

## Summary

Project chat and workspace chat currently use **completely different communication architectures** to talk to the same agent. This means every feature (follow-up prompts, cancel, streaming, error handling) must be implemented twice — and in practice, project chat's version is broken or missing. Instead of patching the project chat path, unify both views onto a single agent communication layer, with the only difference being UI presentation.

## The Problem: Two Architectures for One Thing

### Workspace Chat (works)
```
Browser ←→ ACP WebSocket (ws-{workspaceId}/agent/ws) ←→ VM Agent Gateway ←→ SessionHost ←→ Claude Code
```
- Direct bidirectional WebSocket to agent
- Real-time streaming of `session/update` notifications
- `session/prompt` sends follow-ups
- `session/cancel` cancels current prompt (two-stage: context cancel → 5s grace → force-stop)
- Full ACP protocol: select_agent, prompt, cancel, suspend, resume
- UI components: `packages/acp-client/` (AgentPanel, useAcpSession, useAcpMessages)

### Project Chat (broken)
```
Browser → HTTP POST /sessions/:id/prompt → API → VM Agent handleSendPrompt() → SessionHost
Browser ← ProjectData DO WebSocket ← DO persistMessageBatch() ← API ← VM Agent MessageReporter batch
```
- Follow-up prompts via HTTP POST (not WebSocket) — errors swallowed silently
- Responses arrive via indirect batch: agent → MessageReporter → HTTP batch → API → DO → WebSocket broadcast
- No cancel mechanism at all (no HTTP cancel endpoint exists)
- `promptPending` indicator has no signal when agent starts responding (stuck for up to 30s)
- Idle timer not reset server-side on follow-up
- Agent restart failures invisible to user
- UI components: custom `ProjectMessageView` + `FollowUpInput` (reimplements what acp-client already does)

### Why Two Paths Exist (Historical)

Project chat was built for the "hands-off task submission" use case (spec 022) where the user submits a task and watches. The ACP WebSocket was considered a "workspace detail view" concern. But once follow-up messages were added, project chat needed the same bidirectional agent communication — and a second, weaker path was bolted on via HTTP + DO WebSocket indirection.

## Proposed Direction: One Communication Layer, Two UIs

Both views should use the **ACP WebSocket** as the single source of truth for agent communication. The ProjectData DO WebSocket continues to handle chat persistence/broadcasting (session lifecycle events, message history for new page loads), but prompts, cancel, and streaming all go through the same ACP path.

### What stays the same
- ProjectData DO WebSocket for chat event broadcasting (session.created, session.stopped, etc.)
- ProjectData DO SQLite for message persistence and history
- VM Agent MessageReporter for persisting messages to DO (for history/replay)
- Task submission flow (HTTP POST /tasks/submit → TaskRunner DO)

### What changes
- Project chat connects to the ACP WebSocket (same as workspace chat) for agent interaction
- Shared hooks/components for prompt submission, cancel, streaming, error handling
- Remove HTTP prompt forwarding path (`POST /sessions/:id/prompt` → `sendPromptToAgentOnNode()`)
- Remove `handleSendPrompt` HTTP endpoint from VM agent (or keep as fallback only)
- Project chat gets cancel for free (ACP WebSocket `session/cancel`)
- Project chat gets real-time streaming for free (ACP `session/update` notifications)
- `promptPending` problem disappears (ACP WebSocket gives immediate feedback)

### Two UI presentations
| Aspect | Project Chat | Workspace Chat |
|--------|-------------|----------------|
| **Purpose** | Hands-off task monitoring + follow-up | Code evaluation, terminals, file browsing |
| **Layout** | Message-focused, clean chat thread | Side panels: terminal, file browser, diff viewer |
| **Agent communication** | Shared ACP WebSocket layer | Shared ACP WebSocket layer |
| **Cancel** | Cancel button in chat input area | Cancel button in agent panel |
| **Message display** | Simplified message bubbles | Rich tool call rendering, code blocks |

## Current Issues (Context for Spec)

These are the specific bugs that motivate unification. All stem from the duplicated architecture:

1. **Follow-up errors swallowed silently** — `sendFollowUpPrompt()` `.catch()` logs to `console.warn` only (`ProjectMessageView.tsx:560-567`)
2. **No cancel signal in project chat** — VM agent `CancelPrompt()` (`session_host.go:642`) exists but only reachable via ACP WebSocket, not HTTP
3. **Idle timer not reset server-side** — Prompt endpoint (`chat.ts:215`) doesn't reset DO alarm
4. **Agent restart failures invisible** — SessionHost `HostError` → 409 caught silently
5. **`promptPending` stuck for 30s** — No event when agent starts responding via indirect batch path
6. **`handleSendPrompt` uses `context.Background()`** — Goroutine leak potential (`workspaces.go:771`)

## Architecture Trace (2026-03-04 Deep Research)

### ACP WebSocket Path (the one to keep)
```
Browser opens WebSocket: ws-{workspaceId}.{BASE_DOMAIN}/agent/ws
  → Cloudflare proxy (orange-clouded ws-* subdomain)
  → API Worker subdomain handler (index.ts:250-334) proxies to VM
  → VM agent handleAgentWS() (agent_ws.go:36)
  → Creates/retrieves SessionHost (getOrCreateSessionHost, agent_ws.go:193)
  → Creates Gateway (gateway.go) — thin relay between WebSocket and SessionHost
  → Gateway.Run() reads WebSocket messages, routes by type:
       select_agent → SessionHost.SelectAgent() → Initialize() → NewSession()/LoadSession()
       session/prompt → SessionHost.HandlePrompt() → ACP SDK Prompt() [blocking]
       session/cancel → SessionHost.CancelPrompt() + ForwardToAgent()
       ping → SendPongToViewer()
  → Responses stream back via:
       Claude Code stdout → orderedPipe → ACP SDK → sessionHostClient.SessionUpdate()
         ├─ broadcastMessage() → all viewers (immediate, real-time)
         └─ MessageReporter.Enqueue() → batch to DO for persistence
```

### ProjectData DO WebSocket Path (keep for persistence/events)
```
Browser opens WebSocket: api.{BASE_DOMAIN}/api/projects/{projectId}/sessions/ws
  → API Worker chat route (chat.ts:88-101)
  → projectDataService.forwardWebSocket() (project-data.ts:245-255)
  → ProjectData DO fetch(/ws) → WebSocketPair + ctx.acceptWebSocket()
  → Handles: ping/pong, message.send (persist + broadcast)
  → Broadcasts: message.new, messages.batch, session.created, session.stopped, session.agent_completed
```

### HTTP Prompt Path (to be removed/deprecated)
```
Browser: sendFollowUpPrompt() → POST /api/projects/:id/sessions/:id/prompt
  → chat.ts:215 → lookup workspace + agent session from D1
  → sendPromptToAgentOnNode() (node-agent.ts:277)
  → HTTP POST to VM agent /workspaces/:id/agent-sessions/:id/prompt
  → handleSendPrompt() (workspaces.go:707) → go host.HandlePrompt(context.Background(), ...)
  → Returns 202; responses flow back via MessageReporter batch (delayed, not real-time)
```

## Key Files

**Shared ACP layer (to reuse):**
- `packages/acp-client/src/hooks/useAcpSession.ts` — session state, prompt, cancel
- `packages/acp-client/src/hooks/useAcpMessages.ts` — message processing from ACP notifications
- `packages/acp-client/src/transport/websocket.ts` — ACP WebSocket transport
- `packages/acp-client/src/components/AgentPanel.tsx` — agent UI with cancel button

**Project chat (to refactor):**
- `apps/web/src/components/chat/ProjectMessageView.tsx` — main view, follow-up handler
- `apps/web/src/hooks/useChatWebSocket.ts` — ProjectData DO WebSocket
- `apps/web/src/lib/api.ts` — `sendFollowUpPrompt()` (to remove)
- `apps/web/src/pages/ProjectChat.tsx` — page component, task submission

**API (to simplify):**
- `apps/api/src/routes/chat.ts` — prompt endpoint (to remove or deprecate), session lifecycle (to keep)
- `apps/api/src/durable-objects/project-data.ts` — DO WebSocket, persistence (to keep)
- `apps/api/src/services/node-agent.ts` — `sendPromptToAgentOnNode()` (to remove)

**VM Agent (no changes needed if using ACP WebSocket):**
- `packages/vm-agent/internal/server/workspaces.go` — `handleSendPrompt` (to deprecate)
- `packages/vm-agent/internal/acp/gateway.go` — Gateway handles all ACP messages (already works)
- `packages/vm-agent/internal/acp/session_host.go` — SessionHost lifecycle (already works)

## Acceptance Criteria

- [ ] Project chat connects to ACP WebSocket for agent interaction (prompt, cancel, streaming)
- [ ] Shared agent communication hooks/components between project chat and workspace chat
- [ ] Cancel button in project chat cancels current prompt (not entire session)
- [ ] Follow-up errors displayed inline in chat UI with actionable guidance
- [ ] Real-time streaming in project chat (no more 30s `promptPending` delay)
- [ ] Idle timer reset on successful follow-up (server-side)
- [ ] Terminal state messages when follow-ups are impossible (workspace stopped, node destroyed)
- [ ] HTTP prompt path removed or deprecated (single path through ACP WebSocket)
- [ ] `handleSendPrompt` goroutine leak fixed (timeout context) if endpoint is retained as fallback

## Related

- `specs/022-simplified-chat-ux/spec.md` — FR-024 (follow-up routing), FR-025 (cancel/pause), FR-026 (idle follow-up)
- `specs/022-simplified-chat-ux/tasks.md` — T020 marked complete but cancel not implemented in project chat
- `tasks/backlog/2026-03-02-chat-message-flow-bugs.md` — BUG-1 (WebSocket message drop) fixed; remaining UX issues overlap
