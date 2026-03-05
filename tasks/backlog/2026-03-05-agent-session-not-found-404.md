# Agent Session "session not found" 404 During Task Execution

## Problem

Task execution on staging fails at the `agent_session` step with:
```
Task failed at step "agent_session": Node Agent request failed: 404 {"error":"session not found"}
```

The task runner's two-step agent session flow (create → start) fails because the VM agent's `handleStartAgentSession()` cannot find the session that was created in the previous step.

## Impact

- Task execution fails after node provisioning, workspace creation, and devcontainer build complete
- All the expensive provisioning work (~4 minutes) is wasted
- Observed on staging 2026-03-05 during E2E verification test

## Context

### Task Runner Flow (apps/api/src/durable-objects/task-runner.ts:748-846)
1. Create agent session in D1 (control plane record)
2. `POST /workspaces/{workspaceId}/agent-sessions` → VM agent creates session in memory (201 OK expected)
3. `POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/start` → VM agent starts Claude Code (← FAILS with 404)

### VM Agent Code
- **Create handler**: `packages/vm-agent/internal/server/workspaces.go:516-574` - stores session in `agentSessions.Create()` (in-memory map only)
- **Start handler**: `packages/vm-agent/internal/server/workspaces.go:584-645` - looks up session via `agentSessions.Get()`, returns 404 "session not found" at line 614
- **Sessions manager**: `packages/vm-agent/internal/agentsessions/manager.go` - in-memory map with no disk persistence

### Clues
- Boot logs show duplicate entries (volume_create, git_clone, devcontainer_up all appear twice with different timestamps) suggesting a retry/re-creation occurred during provisioning
- Agent sessions are stored ONLY in process memory - no persistence to disk
- The task runner has retry logic that can skip the create step and retry only the start step (lines 817-819 comment)

## Root Cause Hypotheses

1. **VM agent restart during provisioning**: If the VM agent process restarts between the create and start HTTP calls, all in-memory sessions are lost
2. **Retry logic skipping create**: The task runner's retry logic may incorrectly skip the create step when the start fails, causing subsequent retries to also fail
3. **Network timeout on create**: The create request may time out from the task runner's perspective (returning error) while actually succeeding on the VM, but the task runner then retries the entire step starting from a new create
4. **Race with workspace readiness**: The workspace container may not be fully ready when the create request arrives

## Investigation Steps

- [ ] Check VM agent logs on staging to see if the create request was received and succeeded
- [ ] Check if VM agent restarted during the provisioning flow (check systemd journal)
- [ ] Review task runner retry logic for the `agent_session` step
- [ ] Check if the duplicate boot log entries indicate a workspace re-creation that reset the VM agent
- [ ] Consider adding persistence for agent sessions (e.g., local SQLite or container labels)
- [ ] Consider combining create+start into a single atomic operation

## Acceptance Criteria

- [ ] Simple task submission on staging completes end-to-end (node provision → workspace creation → agent session → file creation)
- [ ] Agent session creation is resilient to transient failures between create and start
- [ ] Root cause documented in post-mortem if it's a bug fix
