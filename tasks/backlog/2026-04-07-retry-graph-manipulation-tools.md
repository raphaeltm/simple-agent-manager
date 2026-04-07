# Retry and Graph Manipulation MCP Tools

## Problem Statement

Phase 5 of the agent-to-agent communication feature. Orchestrator agents need the ability to retry failed tasks, add runtime dependency edges between tasks, and remove not-yet-started tasks from the execution graph. This requires three new MCP tools: `retry_subtask`, `add_dependency`, and `remove_pending_subtask`.

## Research Findings

### Key Files
- `apps/api/src/routes/mcp/dispatch-tool.ts` — existing dispatch logic to reuse for retry
- `apps/api/src/routes/mcp/_helpers.ts` — shared MCP helpers (jsonRpc*, McpTokenData, ACTIVE_STATUSES, getMcpLimits)
- `apps/api/src/routes/mcp/tool-definitions.ts` — tool schema definitions
- `apps/api/src/routes/mcp/index.ts` — tool routing switch statement
- `apps/api/src/db/schema.ts:390-410` — `task_dependencies` table (taskId, dependsOnTaskId, createdBy, createdAt)
- `apps/api/src/db/schema.ts:412-431` — `task_status_events` table
- `apps/api/src/db/schema.ts:333-388` — `tasks` table
- `apps/api/tests/unit/routes/mcp.test.ts` — existing MCP test patterns

### Patterns Observed
- MCP tool handlers follow signature: `(requestId, params, tokenData, env) => Promise<JsonRpcResponse>`
- Tools validate `tokenData.taskId` for task-agent scope
- D1 accessed via raw SQL (env.DATABASE.prepare) for atomic operations, drizzle for simpler queries
- Tool definitions in `tool-definitions.ts`, routing in `index.ts` switch
- Phase 1 (orchestration-tools.ts with send_message_to_subtask, stop_subtask) is NOT merged — need to create the file

### Dependencies
- `task_dependencies` table already exists with columns: taskId, dependsOnTaskId, createdBy (user ref), createdAt
- ACTIVE_STATUSES = ['queued', 'in_progress', 'delegated', 'awaiting_followup']
- Env interface at `apps/api/src/index.ts` needs new config vars

## Implementation Checklist

- [ ] 1. Create `packages/shared/src/types/orchestration.ts` with shared request/response types
- [ ] 2. Export from `packages/shared/src/types/index.ts`
- [ ] 3. Add config constants to `_helpers.ts` (ORCHESTRATOR_MAX_RETRIES_PER_TASK, ORCHESTRATOR_DEPENDENCY_MAX_EDGES) and extend `getMcpLimits()`
- [ ] 4. Add env vars to Env interface in `apps/api/src/index.ts`
- [ ] 5. Create `apps/api/src/routes/mcp/orchestration-tools.ts` with three tool handlers:
  - [ ] 5a. `handleRetrySubtask` — validate parent auth, stop if running, dispatch replacement
  - [ ] 5b. `handleAddDependency` — validate authority, cycle detection, insert edge
  - [ ] 5c. `handleRemovePendingSubtask` — validate parent auth, verify queued status, cancel + cleanup deps
- [ ] 6. Add tool definitions to `tool-definitions.ts`
- [ ] 7. Add tool routing cases to `index.ts`
- [ ] 8. Write tests in `apps/api/tests/unit/routes/mcp-orchestration-tools.test.ts`
- [ ] 9. Build shared package and verify typecheck/lint pass

## Acceptance Criteria

- [ ] `retry_subtask` stops running child tasks and dispatches a replacement with context
- [ ] `retry_subtask` rejects non-parent callers
- [ ] `retry_subtask` respects max retries limit (configurable via ORCHESTRATOR_MAX_RETRIES_PER_TASK)
- [ ] `add_dependency` creates edges between tasks in the same project
- [ ] `add_dependency` rejects cycles via BFS detection
- [ ] `add_dependency` rejects edges exceeding max edge count (configurable)
- [ ] `remove_pending_subtask` cancels queued tasks and cleans up dependency edges
- [ ] `remove_pending_subtask` rejects attempts on non-queued tasks
- [ ] All tools validate MCP token has taskId (task-agent scope)
- [ ] All config values are configurable via env vars with defaults
- [ ] Tests cover happy paths, authorization failures, edge cases

## References

- Task description for Phase 5 of agent-to-agent communication
- Idea `01KNKGFAX12VQ34M48FTXV0K4P` in SAM
- Phase 1 branch: `sam/phase-1-downward-communication-01knkh` (not yet merged)
