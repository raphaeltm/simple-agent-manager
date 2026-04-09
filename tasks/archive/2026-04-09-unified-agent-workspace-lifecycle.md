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

### Fix A: ACP Session Heartbeats via Node Heartbeat Piggybacking

**Approach changed**: Instead of adding per-session heartbeat goroutines in the VM agent (which would require propagating ACP session IDs to the VM agent), we piggyback on the existing node heartbeat. When the node heartbeat handler fires (every 60s), it queries D1 for running workspaces on that node, groups by project, and calls `updateNodeHeartbeats()` on each ProjectData DO to update all ACP session `last_heartbeat_at` timestamps. This is simpler, requires no VM agent changes for heartbeats, and achieves the same goal: ACP sessions stay alive as long as the node is healthy.

- [x] A1. Add `updateNodeHeartbeats(sql, nodeId, projectId)` function to `acp-sessions.ts`
- [x] A2. Add `updateNodeHeartbeats(nodeId)` DO method to `project-data/index.ts`
- [x] A3. Add `updateNodeHeartbeats(env, projectId, nodeId)` service function to `project-data.ts`
- [x] A4. Extend node heartbeat handler in `nodes.ts` to sweep ACP sessions via `waitUntil`
- [x] A5. Add per-call timeout guard (`HEARTBEAT_ACP_SWEEP_TIMEOUT_MS`, default 8s) to prevent waitUntil budget exhaustion
- [x] A6. Write unit tests for heartbeat update grouping logic

### Fix B: Disable VM Auto-Suspend for Conversation Mode

- [x] B1. In `agent_ws.go:getOrCreateSessionHost()`, check `s.config.TaskMode` (already available via cloud-init `TASK_MODE` env var)
- [x] B2. Set `IdleSuspendTimeout = 0` when TaskMode is "conversation" (zero disables auto-suspend per `gateway.go:167`)
- [x] B3. Task-mode keeps default `s.config.ACPIdleSuspendTimeout` (30m)
- [x] B4. Write unit test: config decision logic for IdleSuspendTimeout

### Fix C: Exempt Conversation-Mode from Idle Cleanup

- [x] C1. In `crud.ts:536`, add `task.taskMode !== 'conversation'` guard before scheduling idle cleanup
- [x] C2. Write unit test: conversation-mode idle cleanup exemption decision logic

### Fix D: Couple Agent Death to Workspace Death + UI Recovery

- [x] D1. In DO alarm handler, after `checkHeartbeatTimeouts` returns timed-out entries, query D1 for task_mode
- [x] D2. For conversation-mode workspaces, call `stopWorkspaceInD1()` to prevent zombie state
- [x] D3. Parallelized via `Promise.allSettled` for error isolation (Cloudflare specialist review finding)
- [x] D4. In `MessageBanners.tsx`, add "Reconnect" button to offline banner that calls `session.reconnect()`
- [x] D5. Added focus ring for keyboard accessibility (UI/UX specialist review finding)
- [x] D6. Write unit tests for coupled workspace stop logic

### Documentation & Configuration

- [x] E1. Add `HEARTBEAT_ACP_SWEEP_TIMEOUT_MS` to Env interface (configurable, default 8s)
- [ ] E2. Update CLAUDE.md with new configurable env vars — deferred, env var is optional with sensible default

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
