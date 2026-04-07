# HTTP Cancel Endpoint + Urgent Interrupt Delivery

Phase 4 of 6 for the agent-to-agent communication feature.

## Problem Statement

Cancel for running agent prompts is currently WebSocket-only (`CancelPrompt()` in `session_host.go:728-754`). The control plane needs an HTTP endpoint to cancel prompts programmatically — both for graceful stop_subtask flows and for urgent interrupt delivery (cancel + re-prompt to inject high-priority messages immediately).

## Research Findings

### Key Files
- `packages/vm-agent/internal/acp/session_host.go` — `CancelPrompt()` at line 728, `IsPrompting()` at line 1519, `Status()` returns `SessionHostStatus`
- `packages/vm-agent/internal/server/workspaces.go` — HTTP handlers for agent sessions (handleSendPrompt at ~856, handleStopAgentSession at ~928)
- `packages/vm-agent/internal/server/server.go:754-760` — Route registration for agent-session endpoints
- `apps/api/src/services/node-agent.ts` — `nodeAgentRequest()` helper, existing `sendPromptToAgentOnNode()`, `stopAgentSessionOnNode()`
- `apps/api/src/services/inbox-drain.ts` — Session inbox drain service, currently leaves messages on 409 (agent busy)
- `apps/api/src/routes/mcp/instruction-tools.ts` — Enqueues urgent inbox messages for parent sessions
- `apps/api/src/routes/mcp/tool-definitions.ts` — MCP tool schema definitions
- `apps/api/src/routes/mcp/index.ts` — MCP tool routing

### Patterns
- VM agent route pattern: `mux.HandleFunc("POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/cancel", s.handleCancelAgentSession)`
- Auth: `requireNodeManagementAuth(w, r, workspaceID)` — JWT validation
- Session host lookup: `s.sessionHosts[workspaceID + ":" + sessionID]`
- API proxy pattern: `nodeAgentRequest(nodeId, env, path, options)` with JWT token
- `CancelPrompt()` is a no-op if no prompt in flight — returns without error

### Phase 1 Status
- `orchestration-tools.ts` with `send_message_to_subtask` and `stop_subtask` was NOT merged to main. These tools need to be created as part of this work.

### Phase 3 Status (merged)
- `session_inbox` table in ProjectData DO SQLite
- `drainSessionInbox()` in `apps/api/src/services/inbox-drain.ts`
- `enqueueInboxMessage()` / `getPendingInboxMessages()` / `markInboxDelivered()` on ProjectData DO
- Drain is triggered after message batch persistence

## Implementation Checklist

### 1. VM Agent: HTTP Cancel Endpoint
- [ ] Add `handleCancelAgentSession()` in `packages/vm-agent/internal/server/workspaces.go`
  - Validate path params (workspaceId, sessionId)
  - Validate JWT auth via `requireNodeManagementAuth()`
  - Look up session host from `sessionHosts` map
  - Return 404 if no session host found
  - Check `host.IsPrompting()` — if not prompting, return 409 with "no prompt in flight"
  - Call `host.CancelPrompt()` — return 200 on success
- [ ] Register route in `server.go`: `POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/cancel`
- [ ] Add to contract test route list in `contract_test.go`

### 2. API Worker: Cancel Proxy
- [ ] Add `cancelAgentSessionOnNode()` in `apps/api/src/services/node-agent.ts`
  - POST to `/workspaces/{workspaceId}/agent-sessions/{sessionId}/cancel`
  - Uses `nodeAgentRequest()` with JWT auth
  - Returns `{ success: boolean; status: number }` — catches errors to return status codes

### 3. Orchestration Tools (MCP)
- [ ] Create `apps/api/src/routes/mcp/orchestration-tools.ts` with:
  - `handleSendMessageToSubtask()` — sends message to child task's inbox
  - `handleStopSubtask()` — cancel → warning message → hard stop
- [ ] Add tool definitions to `tool-definitions.ts`
- [ ] Wire up in `index.ts` switch statement
- [ ] `stop_subtask` flow: cancel → settle wait → warning message → hard stop

### 4. Urgent Interrupt Delivery
- [ ] Modify `drainSessionInbox()` in `inbox-drain.ts`:
  - Partition messages by priority (urgent vs normal)
  - For urgent messages when agent is busy (409):
    1. Call `cancelAgentSessionOnNode()` to interrupt
    2. Wait ORCHESTRATOR_CANCEL_SETTLE_MS (default 2000ms)
    3. Retry `sendPromptToAgentOnNode()` with urgent messages
    4. If still 409, leave in inbox for next drain cycle
  - Normal messages stay in inbox when agent is busy (no cancel)
- [ ] Add configuration constants:
  - `ORCHESTRATOR_CANCEL_TIMEOUT_MS` (default: 5000)
  - `ORCHESTRATOR_URGENT_RETRY_ATTEMPTS` (default: 2)
  - `ORCHESTRATOR_CANCEL_SETTLE_MS` (default: 2000)

### 5. Tests
- [ ] Go test: HTTP cancel endpoint (200 when prompting, 409 when idle, 404 for unknown session)
- [ ] Go test: Cancel endpoint requires valid JWT
- [ ] TypeScript test: `cancelAgentSessionOnNode()` proxy function
- [ ] TypeScript test: Urgent interrupt delivery in drain service
- [ ] TypeScript test: Normal messages skip cancel on 409
- [ ] TypeScript test: `stop_subtask` MCP tool flow
- [ ] TypeScript test: `send_message_to_subtask` MCP tool

### 6. Documentation
- [ ] Update CLAUDE.md with new env vars if needed
- [ ] Add contract test for new route

## Acceptance Criteria

- [ ] `POST /workspaces/{id}/agent-sessions/{sessionId}/cancel` returns 200 when prompt is cancelled, 409 when no prompt running, 404 for unknown session
- [ ] `cancelAgentSessionOnNode()` correctly proxies to VM agent cancel endpoint
- [ ] `stop_subtask` MCP tool uses cancel → warning → stop flow
- [ ] `send_message_to_subtask` MCP tool enqueues message to child task's inbox
- [ ] Urgent messages in inbox trigger cancel+re-prompt when agent is busy
- [ ] Normal messages do NOT trigger cancel when agent is busy
- [ ] All config values are environment-variable-configurable with sensible defaults
- [ ] Tests cover all acceptance criteria

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCHESTRATOR_CANCEL_TIMEOUT_MS` | 5000 | How long to wait after cancel before retrying prompt delivery |
| `ORCHESTRATOR_URGENT_RETRY_ATTEMPTS` | 2 | Max cancel+retry attempts for urgent messages |
| `ORCHESTRATOR_CANCEL_SETTLE_MS` | 2000 | Wait time between cancel and re-prompt |

## References

- Task ID: 01KNKNB12JC8CZ0WWYQ0DQ39XB
- Phase 3 PR #623 (merged): session inbox and drain mechanism
