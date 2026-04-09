# Unified Agent-Workspace Lifecycle: Eliminate "Agent Offline" Zombie State

## Problem

In conversation-mode chat, 4 independent kill mechanisms can independently kill the agent while leaving the workspace running, creating a permanent "Agent offline" zombie state. This is the #1 UX issue.

The 4 kill mechanisms:
1. **Heartbeat timeout** (5 min) — VM agent never sends ACP session heartbeats, so the DO alarm ALWAYS fires and marks sessions as `interrupted`
2. **VM auto-suspend** (30 min) — `SessionHost.DetachViewer()` starts a 30-min timer when last viewer disconnects; fires even in conversation mode
3. **Idle cleanup** (15 min) — `scheduleIdleCleanup()` fires when agent signals `awaiting_followup` (conversation-mode `complete_task` remaps to this)
4. **Workspace idle timeout** (2 hr) — the ONLY mechanism that should apply to conversation-mode

## Design Decisions (confirmed by user)

1. **Single lifecycle**: Agent lifecycle = workspace lifecycle. No intermediate zombie states.
2. **Single timer**: The 2-hour workspace idle timeout (per-project configurable) is the ONLY mechanism that kills conversation-mode sessions.
3. **Task mode unchanged**: Agent says "done" → workspace cleaned up on next sweep.

## Research Findings

### Fix A: VM Agent ACP Session Heartbeats
- **`session_host.go`**: SessionHost has `config.ControlPlaneURL` and `config.CallbackToken` for control plane API calls (line 2048 pattern)
- **`gateway.go:96-196`**: `GatewayConfig` has `ControlPlaneURL`, `CallbackToken`, `WorkspaceID` but NO `ProjectID` or `NodeID`
- **`config.go:138-141`**: Config has `ProjectID`, `NodeID`, `ChatSessionID`, `TaskMode` fields
- **`agent_ws.go:265-267`**: CallbackToken is set from server config at SessionHost creation
- **Heartbeat endpoint**: `POST /api/projects/:projectId/acp-sessions/:sessionId/heartbeat` with body `{ nodeId }` — already exists and works
- **Pattern**: Must add `ProjectID`, `NodeID`, `AcpSessionID` to GatewayConfig so SessionHost can construct heartbeat URL
- **AcpSessionID**: Available after `startAgent()` sets `h.sessionID` via ACP SDK. But we also need to send heartbeats before the ACP session starts (when status is 'assigned'). The control plane ACP session ID is NOT the same as the SDK session ID — it's the one created by the DO.
- **Missing link**: The VM agent doesn't know the control plane ACP session ID. It knows the SDK session ID (`h.sessionID`). The control plane ACP session ID is created by the DO and passed via... need to check how the TaskRunner assigns it.

### Fix A (revised): ACP Session ID propagation
- The control plane creates the ACP session (`createAcpSession`) and assigns it to a workspace (`transitionAcpSession` → 'assigned')
- The VM agent needs the control plane ACP session ID to send heartbeats
- Currently the VM agent gets `ChatSessionID` via cloud-init env var but NOT the ACP session ID
- **Solution**: Pass the ACP session ID to the VM agent via cloud-init env vars OR pass it in the agent session creation endpoint. Let me check how the TaskRunner works...
- Actually, looking at the heartbeat endpoint more carefully: it uses the ACP session ID in the URL path. The VM agent needs this ID.
- The ID flow: TaskRunner creates ACP session → assigns to workspace → tells VM agent to create agent session. The ACP session ID should be passed to the VM agent at that point.
- For conversation-mode, the ACP session is created by the control plane when the user opens a chat. The workspace gets a chat session ID via cloud-init.
- **Simplest approach**: Add `AcpSessionId` field to `GatewayConfig`. The server populates it from the workspace's assigned ACP session (queried from the agent session manager or from a new cloud-init env var). Then the SessionHost can send heartbeats to the correct endpoint.
- Actually, looking at the heartbeat pattern: the node heartbeat in `health.go:100` uses `/api/nodes/:nodeId/heartbeat`. The ACP heartbeat needs `/api/projects/:projectId/acp-sessions/:sessionId/heartbeat`. The VM agent already has `ProjectID` and `NodeID` in config. We need the ACP session ID.
- **Best approach**: Pass ACP session ID via cloud-init env var `ACP_SESSION_ID`, or better yet, when the control plane assigns the ACP session it calls the VM agent to start the agent session — at that point it can include the ACP session ID in the request body.

### Fix B: VM Auto-Suspend for Conversation Mode
- `session_host.go:313`: `DetachViewer()` starts suspend timer when `IdleSuspendTimeout > 0` and no viewers
- `agent_ws.go:254`: `cfg.IdleSuspendTimeout = s.config.ACPIdleSuspendTimeout` — uses global 30m default
- `config.go:110,318`: `ACPIdleSuspendTimeout` defaults to 30 minutes
- **Fix**: Need `TaskMode` in GatewayConfig. If conversation mode, set `IdleSuspendTimeout = 0` (disable auto-suspend)

### Fix C: Idle Cleanup Exemption
- `crud.ts:535-557`: When agent signals `awaiting_followup`, `scheduleIdleCleanup()` is called with 15-min timeout
- `task-tools.ts:144-193`: In conversation mode, `complete_task` remaps to `awaiting_followup` step
- This means conversation-mode sessions get the 15-min idle cleanup timer
- **Fix**: In `crud.ts:536`, check task mode before scheduling idle cleanup. If conversation mode, skip scheduling.
- Alternative: Check in `processExpiredCleanups()` — but better to not schedule in the first place.

### Fix D: Couple Agent Death to Workspace Death
- `acp-sessions.ts:381-427`: `checkHeartbeatTimeouts()` transitions stale sessions to `interrupted` but does NOT stop workspace
- `index.ts:267-269`: Alarm handler calls `checkHeartbeatTimeouts` then `transitionAcpSession`
- **Fix**: In the alarm handler's transition callback, when toStatus is `interrupted` and session is conversation-mode, also call `stopWorkspaceInD1()`
- **UI fix**: `MessageBanners.tsx:41-52` shows "Agent offline" with no recovery option. Should show "Reconnect" button for conversation-mode when workspace is still running.

## Implementation Checklist

### Fix A: VM Agent ACP Session Heartbeats

- [ ] A1. Add `ProjectID`, `NodeID`, `AcpSessionId` fields to `GatewayConfig` in `gateway.go`
- [ ] A2. Add `ACP_SESSION_ID` env var support in `config.go` (set via cloud-init)
- [ ] A3. Populate new GatewayConfig fields in `agent_ws.go:getOrCreateSessionHost()`
- [ ] A4. Add `startHeartbeat()` method to `SessionHost` that POSTs to control plane every 60s
- [ ] A5. Start heartbeat goroutine in `NewSessionHost()` or after first agent select
- [ ] A6. Stop heartbeat goroutine in `Stop()` and `Suspend()` methods
- [ ] A7. Add `ACP_SESSION_HEARTBEAT_INTERVAL` env var config (default: 60s)
- [ ] A8. Add cloud-init template changes to pass `ACP_SESSION_ID` env var to VM agent
- [ ] A9. Write unit tests for heartbeat start/stop lifecycle

### Fix B: Disable VM Auto-Suspend for Conversation Mode

- [ ] B1. Add `TaskMode` field to `GatewayConfig` in `gateway.go`
- [ ] B2. Populate `TaskMode` in `agent_ws.go:getOrCreateSessionHost()` from `s.config.TaskMode`
- [ ] B3. In `agent_ws.go:getOrCreateSessionHost()`, set `IdleSuspendTimeout = 0` when TaskMode is "conversation"
- [ ] B4. Write unit test: conversation-mode SessionHost has IdleSuspendTimeout=0, task-mode keeps 30m default

### Fix C: Exempt Conversation-Mode from Idle Cleanup

- [ ] C1. In `crud.ts:536`, check task mode before scheduling idle cleanup — skip for conversation mode
- [ ] C2. Verify `complete_task` → `awaiting_followup` remap still works without idle cleanup
- [ ] C3. Write integration test: conversation-mode task completion does NOT schedule idle cleanup

### Fix D: Couple Agent Death to Workspace Death + UI Recovery

- [ ] D1. In DO alarm handler (`index.ts:267-269`), when heartbeat timeout fires for conversation-mode session, also stop workspace via `stopWorkspaceInD1()`
- [ ] D2. Need to determine conversation-mode from ACP session context — may need session mode stored in ACP session table
- [ ] D3. Add `session_mode` column to acp_sessions table (or derive from linked task's mode)
- [ ] D4. In `MessageBanners.tsx`, when session is `interrupted` and workspace is `running`, show "Reconnect" button
- [ ] D5. Add `reconnect` handler that re-attaches to the workspace's agent session
- [ ] D6. Write test for UI reconnect behavior

### Documentation & Configuration

- [ ] E1. Add `ACP_SESSION_HEARTBEAT_INTERVAL` to shared constants/defaults
- [ ] E2. Update CLAUDE.md with new configurable env vars
- [ ] E3. Update `apps/api/.env.example` with new env vars

## Acceptance Criteria

- [ ] VM agent sends ACP session heartbeats every 60s while agent is alive
- [ ] Conversation-mode sessions survive 30+ minutes without viewer connected
- [ ] Conversation-mode sessions are NOT killed by 15-min idle cleanup
- [ ] When heartbeat timeout fires for conversation-mode, workspace is also stopped (no zombie)
- [ ] The 2-hour workspace idle timeout is the single authoritative kill mechanism for conversation mode
- [ ] UI shows reconnect option instead of permanent "offline" when recovery is possible
- [ ] Task-mode sessions retain existing cleanup behavior (no regression)

## Key Files

- `packages/vm-agent/internal/acp/session_host.go` — heartbeat goroutine, auto-suspend
- `packages/vm-agent/internal/acp/gateway.go` — GatewayConfig additions
- `packages/vm-agent/internal/server/agent_ws.go` — SessionHost creation, config population
- `packages/vm-agent/internal/config/config.go` — new env vars
- `apps/api/src/durable-objects/project-data/acp-sessions.ts` — heartbeat timeout
- `apps/api/src/durable-objects/project-data/idle-cleanup.ts` — idle cleanup
- `apps/api/src/durable-objects/project-data/index.ts` — DO alarm handler
- `apps/api/src/routes/tasks/crud.ts` — awaiting_followup cleanup trigger
- `apps/web/src/components/project-message-view/MessageBanners.tsx` — UI banners
- `packages/shared/src/types/session.ts` — ACP session defaults
