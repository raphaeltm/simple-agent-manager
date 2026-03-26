# Agent Profiles — Phase 2: Task Runner Integration

**Created**: 2026-03-15
**Depends on**: Phase 1 (Schema & API)
**Blocks**: Phase 4 (System Prompt Injection)
**Series**: Agent Profiles (2 of 4)

## Problem

The task runner (`apps/api/src/durable-objects/task-runner.ts`) currently resolves agent type with a simple fallback chain: `state.config.agentType || env.DEFAULT_TASK_AGENT_TYPE || 'claude-code'`. It ignores the `agentProfileHint` field on tasks entirely. Agent profiles created in Phase 1 have no effect on task execution.

## Goal

Wire agent profiles into the task runner so that when a task specifies a profile (via the existing `agentProfileHint` field or a new `agentProfileId` field), the task runner uses that profile's configuration (agent type, model, permission mode, timeout, VM size) when provisioning the workspace and starting the agent.

## Acceptance Criteria

- [ ] `TaskSubmitRequest` in shared types accepts `agentProfileId` (optional, references an agent profile)
- [ ] Task runner's `resolveConfig()` step uses `resolveAgentProfile()` from Phase 1 to determine: agent type, model, permission mode, VM size override, timeout
- [ ] Profile-specified `vm_size_override` feeds into workspace provisioning (existing VM size precedence: explicit task override > profile override > project default > platform default)
- [ ] Profile-specified `timeout_minutes` sets a task execution timeout alarm in the task runner DO
- [ ] Profile-specified `model` is passed to the agent session start (forwarded to VM agent in the agent session creation payload)
- [ ] Profile-specified `permission_mode` is passed to the agent session start
- [ ] The existing `agentProfileHint` free-text field continues to work as a fallback — if it matches a profile name, use that profile
- [ ] Integration tests: submit a task with a profile, verify the task runner applies all profile settings
- [ ] Capability test: end-to-end from task submission through to the agent session creation payload containing profile-derived settings

## Implementation Notes

- The VM agent's `handleCreateAgentSession` already receives agent type. Extend the payload to include model and permission mode so the agent process can be started with those settings.
- The VM agent's `session_host.go:SelectAgent()` may need updates to accept model/permission mode overrides. Check the ACP command construction in `session_host.go`.
- Profile resolution happens in the API worker (task runner DO), not in the VM agent. The VM agent receives fully resolved configuration.

## References

- Task runner config resolution: `apps/api/src/durable-objects/task-runner.ts` (lines 806, 871)
- Agent session start: `apps/api/src/services/node-agent.ts:startAgentSessionOnNode()`
- VM agent session host: `packages/vm-agent/internal/acp/session_host.go`
