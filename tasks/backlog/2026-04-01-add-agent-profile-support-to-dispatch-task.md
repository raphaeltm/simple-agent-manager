# Add Agent Profile Support to dispatch_task MCP Tool

## Problem Statement

The `dispatch_task` MCP tool currently doesn't support specifying an agent profile when dispatching tasks to other agents. This limits the flexibility of agent-to-agent delegation, as dispatched tasks can only use project defaults rather than specialized agent configurations.

## Research Findings

### Current Implementation
- `dispatch_task` tool in `/apps/api/src/routes/mcp/dispatch-tool.ts`
- Tool definition in `/apps/api/src/routes/mcp/tool-definitions.ts`
- Database schema already has `agentProfileHint` field in tasks table
- Agent profiles are defined in `/packages/shared/src/types/agent-settings.ts`
- Task types include `agentProfileId` field in `SubmitTaskRequest`

### Key Files to Modify
1. `/apps/api/src/routes/mcp/tool-definitions.ts` - Add `agentProfileId` parameter to input schema
2. `/apps/api/src/routes/mcp/dispatch-tool.ts` - Handle agent profile parameter and pass to TaskRunner DO
3. Tests in `/apps/api/tests/unit/routes/mcp.test.ts` - Add tests for agent profile parameter

### Existing Patterns
- Agent profiles are already supported in the regular task submission flow
- The `startTaskRunnerDO` function accepts agent profile parameters
- The database schema supports `agentProfileHint` on tasks

## Implementation Checklist

- [ ] Add `agentProfileId` parameter to `dispatch_task` tool definition
- [ ] Update `handleDispatchTask` to accept and validate `agentProfileId`
- [ ] Pass `agentProfileId` to `startTaskRunnerDO` function
- [ ] Add validation to ensure agent profile exists and belongs to the project
- [ ] Update tests to cover agent profile parameter scenarios
- [ ] Add documentation to tool description

## Acceptance Criteria

1. ✅ `dispatch_task` accepts optional `agentProfileId` parameter
2. ✅ Agent profile is validated (exists and belongs to project)
3. ✅ Agent profile settings are passed to the dispatched task
4. ✅ Dispatched task uses agent profile settings instead of project defaults
5. ✅ Tests cover happy path and error cases
6. ✅ Documentation updated

## References

- Agent profile types: `/packages/shared/src/types/agent-settings.ts`
- Task schema: `/apps/api/src/db/schema.ts`
- Current dispatch implementation: `/apps/api/src/routes/mcp/dispatch-tool.ts`
- Task runner DO: `/apps/api/src/services/task-runner-do.ts`