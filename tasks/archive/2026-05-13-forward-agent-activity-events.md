# Forward Agent Activity Events to Fix Chat UI Display

## Problem

The project chat UI guesses agent activity from message arrival timing (3-second idle timer on assistant messages only). This fails during tool calls (no assistant text for 30+ seconds) and causes the "Agent is working" banner to flicker due to 2-second batch delivery jitter. The typewriter text animation is also broken because it's gated on the unreliable activity state.

## Solution

Forward `session_prompting` / `session_prompt_done` from the VM agent through the ProjectData DO WebSocket as a new `session.activity` event. No persistence — fire-and-forget, ephemeral real-time signals. Keep the message-based heuristic as a longer-timeout fallback.

## Research Findings

### VM Agent
- `markPromptStarted()` at `session_host_prompt.go:193` and `markPromptDone()` at line 205 are the correct hook points
- `GatewayConfig` in `gateway.go` has `ControlPlaneURL`, `WorkspaceID`, `SessionID`, `CallbackToken` but NOT `ProjectID` or `NodeID` — these must be added
- `cfg.ProjectID` and `cfg.NodeID` are available in the server constructor and can be threaded through to `GatewayConfig`
- Auth pattern: `Authorization: Bearer <CallbackToken>` (same as `fetchAgentKey` in `session_host_reporting.go`)
- HTTP client available via `h.httpClient()` (uses `config.HTTPClient`)

### API Worker
- Existing `/status` endpoint pattern at `acp-sessions.ts:140-189` validates nodeId matches session's assigned node
- Schemas in `schemas/acp-sessions.ts` use Valibot
- `projectDataService.getAcpSession()` used for node validation lookup
- Route file exports `acpSessionRoutes` Hono router

### ProjectData DO
- `broadcastEvent()` at `index.ts:715` sends to session-scoped WebSocket clients
- Called pattern: `this.broadcastEvent('session.activity', { sessionId, activity }, sessionId)`
- No need for persistence — just broadcast

### UI
- `useChatWebSocket.ts` handles `message.new`, `messages.batch`, `session.stopped`, `session.failed`, `session.agent_completed`
- `useSessionLifecycle.ts:149` derives activity from assistant messages only (bug: should include tool/thinking/plan)
- `IDLE_TIMEOUT_MS = 3000` at `types.ts:25` — too aggressive, needs 30000
- `onMessage` callback is where idle timer resets — only triggers on `msg.role === 'assistant'`

## Implementation Checklist

### VM Agent (Go)
- [ ] Add `ProjectID` and `NodeID` fields to `GatewayConfig` in `gateway.go`
- [ ] Thread `cfg.ProjectID` and `cfg.NodeID` through in `server.go` constructor
- [ ] Add `reportActivity(activity string)` method to `SessionHost` in `session_host_reporting.go`
- [ ] Call `reportActivity("prompting")` from `markPromptStarted()` (fire-and-forget goroutine)
- [ ] Call `reportActivity("idle")` from `markPromptDone()` (fire-and-forget goroutine)

### API Worker (TypeScript)
- [ ] Add `AcpSessionActivityReportSchema` to `schemas/acp-sessions.ts`
- [ ] Export from `schemas/index.ts`
- [ ] Add `POST /:id/acp-sessions/:sessionId/activity` route in `acp-sessions.ts`
- [ ] Validate nodeId matches session's assigned node (same pattern as /status)
- [ ] Call DO to broadcast, return 204

### ProjectData DO
- [ ] Add `reportActivity(sessionId, activity)` RPC method in `index.ts`

### ProjectData Service
- [ ] Add `reportAcpSessionActivity()` in `project-data.ts`

### UI (React)
- [ ] Handle `session.activity` event in `useChatWebSocket.ts` via new `onAgentActivity` callback
- [ ] Add `onAgentActivity` handler in `useSessionLifecycle.ts`
- [ ] Change `IDLE_TIMEOUT_MS` from 3000 to 30000 in `types.ts`
- [ ] Fix heuristic to reset idle timer on all message roles (tool, thinking, plan), not just assistant

### Tests
- [ ] Unit test for VM agent `reportActivity` (verify HTTP POST is made with correct URL/body)
- [ ] Integration test for API route (validate nodeId check, 204 response)
- [ ] Unit test for UI lifecycle hook (verify `session.activity` event updates `agentActivity` state)

## Acceptance Criteria

- [ ] "Agent is working" indicator stays solid during long tool calls (no flickering)
- [ ] Activity transitions promptly on `session.activity` events
- [ ] Fallback heuristic still works for old VM agents (backward compatible)
- [ ] No new DB writes or DO persistence
- [ ] NodeId verification on the API endpoint
- [ ] Fire-and-forget from VM agent (no retry, no blocking)

## References

- Idea: 01KRH8357FMZBAKDKYHX9V5XK4
- VM agent prompt lifecycle: `packages/vm-agent/internal/acp/session_host_prompt.go`
- VM agent gateway config: `packages/vm-agent/internal/acp/gateway.go`
- VM agent reporting pattern: `packages/vm-agent/internal/acp/session_host_reporting.go`
- ACP heartbeat pattern: `packages/vm-agent/internal/server/acp_heartbeat.go`
- API route: `apps/api/src/routes/projects/acp-sessions.ts`
- DO broadcast: `apps/api/src/durable-objects/project-data/index.ts:715`
- Schemas: `apps/api/src/schemas/acp-sessions.ts`
- UI lifecycle: `apps/web/src/components/project-message-view/useSessionLifecycle.ts`
- UI WebSocket: `apps/web/src/hooks/useChatWebSocket.ts`
- IDLE_TIMEOUT_MS: `apps/web/src/components/project-message-view/types.ts:25`
