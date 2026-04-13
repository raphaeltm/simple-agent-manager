# Direct VM Agent ACP Session Heartbeats

## Problem

ACP sessions consistently go offline ("Agent offline") while workspaces are still running. The current heartbeat mechanism piggybacks on the node heartbeat via a `waitUntil` callback in `apps/api/src/routes/nodes.ts:636-675`. This is a 7-hop chain where any single failure causes heartbeats to silently not update, and after 5 minutes (ACP_SESSION_DETECTION_WINDOW_MS=300000), sessions get marked `interrupted`.

## Research Findings

### Current piggybacking architecture (broken)
1. VM agent sends node heartbeat → `POST /api/nodes/:nodeId/heartbeat`
2. Node heartbeat handler runs `waitUntil` callback
3. Callback queries D1 for running workspaces on the node
4. Deduplicates by projectId
5. For each project, calls `projectDataService.updateNodeHeartbeats()`
6. Which gets the ProjectData DO stub
7. Which runs SQL: `UPDATE acp_sessions SET last_heartbeat_at = ? WHERE node_id = ? AND status IN ('assigned', 'running')`

Any failure in steps 2-7 causes silent heartbeat loss.

### ACP session lifecycle
- ACP sessions are created via `POST /projects/:projectId/acp-sessions` (REST endpoint in `apps/api/src/routes/projects/acp-sessions.ts`)
- For task-mode, the TaskRunner does NOT create ACP sessions — they're created by the web UI
- ACP sessions track agent lifecycle independently from `chatSessionId` and `agentSessionId`
- The heartbeat endpoint exists: `POST /api/projects/:projectId/acp-sessions/:sessionId/heartbeat` with `{ nodeId }`
- `updateNodeHeartbeats(nodeId)` in the ProjectData DO updates ALL active sessions for a node

### Key files
- `apps/api/src/routes/nodes.ts:636-675` — broken piggybacking sweep
- `apps/api/src/durable-objects/project-data/acp-sessions.ts:483-505` — `updateNodeHeartbeats()`
- `apps/api/src/durable-objects/project-data/index.ts:242-259` — DO heartbeat methods
- `apps/api/src/routes/projects/acp-sessions.ts:194-221` — per-session heartbeat endpoint
- `packages/vm-agent/internal/acp/gateway.go:96-196` — GatewayConfig struct
- `packages/vm-agent/internal/acp/session_host.go:192-212` — NewSessionHost
- `packages/vm-agent/internal/acp/session_host.go:799-848` — Stop()
- `packages/vm-agent/internal/acp/session_host.go:1568-1620` — Suspend()
- `packages/vm-agent/internal/server/agent_ws.go:194-312` — getOrCreateSessionHost
- `packages/vm-agent/internal/server/workspaces.go:610-680` — handleCreateAgentSession
- `packages/vm-agent/internal/server/workspaces.go:690-800` — handleStartAgentSession
- `packages/vm-agent/internal/server/health.go:49-168` — node heartbeat pattern (reference)
- `apps/api/src/services/node-agent.ts:246-318` — createAgentSessionOnNode / startAgentSessionOnNode
- `apps/api/src/durable-objects/task-runner/agent-session-step.ts` — TaskRunner agent session step

### Design decision: Node-level heartbeat vs per-session heartbeat
The task asks to pass ACP session IDs to the VM agent. However, for task-mode tasks the TaskRunner doesn't create ACP sessions. Rather than adding ACP session creation to the TaskRunner flow (which would require additional complexity and changes to the task state machine), we'll use a **node-level ACP heartbeat approach**:

1. Create a new API endpoint: `POST /api/projects/:projectId/acp-heartbeat`
2. This endpoint calls `updateNodeHeartbeats(nodeId)` on the ProjectData DO — same as the piggybacking sweep but called directly
3. The VM agent's Server (not per-SessionHost) sends these heartbeats for each active workspace's project
4. Auth: Bearer callback token (same as node heartbeat)

This is simpler, more robust, and works for both task-mode and conversation-mode without requiring changes to the task state machine.

**Updated approach**: Actually, reading the existing code more carefully, I'll have the VM agent make a single heartbeat call per node per project, using a new lightweight endpoint. The Server already tracks workspace-to-project mappings.

## Implementation Checklist

### Phase 1: API — New node-level ACP heartbeat endpoint
- [ ] Add `POST /api/projects/:projectId/node-acp-heartbeat` route in `apps/api/src/routes/projects/acp-sessions.ts`
  - Auth: callback token (Bearer) — same as node heartbeat
  - Body: `{ nodeId: string }`
  - Calls `projectDataService.updateNodeHeartbeats(env, projectId, nodeId)`
  - Returns 204 on success
- [ ] Add schema validation for the new endpoint

### Phase 2: VM Agent — Direct ACP heartbeat goroutine
- [ ] Add `AcpHeartbeatInterval` to `config.Config` loaded from `ACP_SESSION_HEARTBEAT_INTERVAL_MS` env var (default: 60s per `ACP_SESSION_DEFAULTS.HEARTBEAT_INTERVAL_MS`)
- [ ] Add `startAcpHeartbeatReporter()` method on Server in a new file `packages/vm-agent/internal/server/acp_heartbeat.go`
  - Goroutine that ticks every `AcpHeartbeatInterval`
  - On each tick, collect unique (projectId, workspaceId) pairs from active workspaces
  - For each unique projectId, POST to `{ControlPlaneURL}/api/projects/{projectId}/node-acp-heartbeat` with `{ nodeId }`
  - Use callback token for auth
  - Log errors but don't crash
- [ ] Call `startAcpHeartbeatReporter()` in Server startup (alongside `startNodeHealthReporter()`)
- [ ] Store projectId in WorkspaceRuntime so the heartbeat goroutine can find it

### Phase 3: Diagnostic logging for piggybacking sweep
- [ ] Add structured log at START of `waitUntil` callback in `nodes.ts:640` (before D1 query)
- [ ] Log workspace query results: count found, how many have projectId
- [ ] Log per-project update results

### Phase 4: Tests
- [ ] Unit test for new heartbeat endpoint
- [ ] Go test for ACP heartbeat goroutine lifecycle (starts/stops with Server)
- [ ] Verify heartbeat goroutine skips when no active workspaces

## Acceptance Criteria
- [ ] VM agent sends direct ACP heartbeats every 60s to control plane while workspaces have active projects
- [ ] Heartbeat goroutine stops cleanly when Server shuts down
- [ ] Sessions survive beyond the 5-minute detection window when agent is running
- [ ] Existing piggybacking sweep is retained as backup (not removed)
- [ ] Diagnostic logging added to piggybacking sweep
- [ ] All new config values are configurable via environment variables
- [ ] Both task-mode and conversation-mode sessions benefit from direct heartbeats
- [ ] Tests verify heartbeat goroutine starts/stops with Server lifecycle
