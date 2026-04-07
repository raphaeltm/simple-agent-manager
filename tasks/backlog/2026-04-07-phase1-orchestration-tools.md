# Merge Phase 1 Orchestration Tools into Main

## Problem

Phase 1 of agent-to-agent communication implemented two MCP tools — `send_message_to_subtask` and `stop_subtask` — on branch `sam/phase-1-downward-communication-01knkh`, but the branch was never merged. Phase 5 (PR #625) later created `orchestration-tools.ts` with only its own tools (retry_subtask, add_dependency, remove_pending_subtask). The Phase 1 tools need to be integrated alongside the Phase 5 tools.

## Research Findings

### Current state on main
- `orchestration-tools.ts` has: `handleRetrySubtask`, `handleAddDependency`, `handleRemovePendingSubtask`
- `tool-definitions.ts` has definitions for: `retry_subtask`, `add_dependency`, `remove_pending_subtask`
- `index.ts` router has cases for the above three tools
- `_helpers.ts` `getMcpLimits()` has `orchestratorMaxRetriesPerTask` and `orchestratorDependencyMaxEdges` but NOT `orchestratorStopGraceMs` or `orchestratorMessageMaxLength`
- `packages/shared/src/types/orchestration.ts` has types for retry/add_dependency/remove but NOT for send_message/stop
- `Env` interface has `ORCHESTRATOR_MAX_RETRIES_PER_TASK` and `ORCHESTRATOR_DEPENDENCY_MAX_EDGES` but NOT `ORCHESTRATOR_STOP_GRACE_MS` or `ORCHESTRATOR_MESSAGE_MAX_LENGTH`

### Phase 1 code (branch `sam/phase-1-downward-communication-01knkh`)
- `orchestration-tools.ts` has: `resolveChildAgent()` helper, `handleSendMessageToSubtask`, `handleStopSubtask`
- `resolveChildAgent()` resolves child task → workspace → node → agent session with parent auth
- `handleSendMessageToSubtask` calls `sendPromptToAgentOnNode()`, handles 409 as "agent_busy"
- `handleStopSubtask` sends optional warning, waits grace period, calls `stopAgentSessionOnNode()`, updates task status to failed
- Both use `sendPromptToAgentOnNode` and `stopAgentSessionOnNode` from `node-agent.ts` — both exist on main
- Adds `orchestratorStopGraceMs` (default 5000ms) and `orchestratorMessageMaxLength` (default 32768) to `getMcpLimits()`
- Test file has ~604 lines covering both tools

### Key dependencies (all exist on main)
- `sendPromptToAgentOnNode()` in `services/node-agent.ts` (line 318)
- `stopAgentSessionOnNode()` in `services/node-agent.ts` (line 372)
- `ACTIVE_STATUSES`, `getMcpLimits`, helpers from `_helpers.ts`
- `agentSessions` table in schema (for resolving running sessions)

## Implementation Checklist

- [ ] Add `orchestratorStopGraceMs` and `orchestratorMessageMaxLength` to `_helpers.ts` `getMcpLimits()`
- [ ] Add `ORCHESTRATOR_STOP_GRACE_MS` and `ORCHESTRATOR_MESSAGE_MAX_LENGTH` to `Env` interface
- [ ] Add `resolveChildAgent()` helper and `isError()` type guard to `orchestration-tools.ts`
- [ ] Add `handleSendMessageToSubtask()` to `orchestration-tools.ts`
- [ ] Add `handleStopSubtask()` to `orchestration-tools.ts`
- [ ] Add tool definitions for `send_message_to_subtask` and `stop_subtask` to `tool-definitions.ts`
- [ ] Add router cases and imports for both tools in `index.ts`
- [ ] Add shared types (`SendMessageToSubtaskRequest/Response`, `StopSubtaskRequest/Response`) to `packages/shared/src/types/orchestration.ts`
- [ ] Add/adapt tests for both new tools
- [ ] Add env vars to `apps/api/.env.example`
- [ ] Run lint, typecheck, and tests

## Acceptance Criteria

- [ ] `send_message_to_subtask` MCP tool registered and functional
- [ ] `stop_subtask` MCP tool registered and functional
- [ ] Both enforce direct-parent authorization
- [ ] `send_message_to_subtask` handles 409 (agent_busy) gracefully
- [ ] `stop_subtask` sends warning message before hard stop with configurable grace period
- [ ] All env vars configurable (no hardcoded values)
- [ ] Existing Phase 5 tools unaffected
- [ ] Tests pass for both new and existing tools
