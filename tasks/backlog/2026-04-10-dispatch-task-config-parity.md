# Dispatch Task MCP Tool — Full Task Execution Config Parity

## Problem Statement

The `dispatch_task` MCP tool currently only supports `vmSize`, `priority`, `references`, and `branch` parameters. It cannot specify agent profiles, task mode, agent type, workspace profile, provider, or VM location. This means agent-dispatched tasks always use project defaults, limiting the flexibility of agent-to-agent delegation.

The normal task submit path (`submit.ts`) and trigger submit path (`trigger-submit.ts`) both support the full configuration chain: explicit field → agent profile → project default → platform default. The dispatch path must reach parity.

## Research Findings

### Current State
- **dispatch-tool.ts** (line 240–249): Hardcodes VM config resolution without profile support. Comment on line 393–396 explicitly says "Agent profile resolution is not supported on the MCP dispatch path."
- **submit.ts** (line 187–228): Full precedence chain with `resolveAgentProfile()` for vmSize, provider, vmLocation, workspaceProfile, taskMode, agentType, model, permissionMode, systemPromptAppend.
- **trigger-submit.ts** (line 102–131): Same pattern for trigger-fired tasks.
- **agent-profiles.ts**: `resolveAgentProfile()` resolves by ID or name, seeds built-in profiles, returns `ResolvedAgentProfile`.
- **task-runner-do.ts**: `startTaskRunnerDO()` already accepts all config fields — dispatch just passes nulls for profile-derived values.

### maxTurns and timeoutMinutes
Confirmed NOT enforced by runtime. Grepped `apps/api/src/durable-objects/` — only unrelated `SESSION_IDLE_TIMEOUT_MINUTES` references found. These fields exist in the schema but are not used by TaskRunner DO. Will document this clearly and exclude from implementation.

### Key Files to Modify
1. `apps/api/src/routes/mcp/tool-definitions-task-tools.ts` — extend dispatch_task schema
2. `apps/api/src/routes/mcp/dispatch-tool.ts` — add profile resolution and config precedence
3. `apps/api/tests/unit/routes/mcp.test.ts` — add tests for new params
4. `CLAUDE.md` — update recent changes section

### Existing Test Patterns
- Tests in `mcp.test.ts` use `mockD1Results` and `setupHappyPathMocks` for sequential D1 mock chains
- Tests verify JSON-RPC error codes and messages

## Implementation Checklist

- [ ] 1. Add new fields to `dispatch_task` tool definition in `tool-definitions-task-tools.ts`:
  - `agentProfileId` (string), `taskMode` (enum), `agentType` (string), `workspaceProfile` (enum), `provider` (enum), `vmLocation` (string)
- [ ] 2. Update `handleDispatchTask` in `dispatch-tool.ts`:
  - Import `resolveAgentProfile` from agent-profiles service
  - Validate new parameters (agentType via `isValidAgentType`, provider via `CREDENTIAL_PROVIDERS`, taskMode, workspaceProfile, vmLocation)
  - Call `resolveAgentProfile()` when `agentProfileId` is provided
  - Apply precedence chain: explicit → profile → project default → platform default
  - Pass resolved values to `startTaskRunnerDO()`
  - Remove the "not supported" comment
- [ ] 3. Persist `agentProfileHint` in the task INSERT for observability
- [ ] 4. Add/update tests:
  - Schema acceptance (new fields in tools/list)
  - Invalid agentType rejection
  - Invalid provider rejection
  - Invalid taskMode rejection
  - Invalid workspaceProfile rejection
  - Profile resolution happy path (profile overrides project defaults)
  - Conversation mode dispatch
  - Backward compatibility (existing minimal dispatch still works)
- [ ] 5. Update CLAUDE.md recent changes section

## Acceptance Criteria

1. `dispatch_task` accepts optional `agentProfileId`, `taskMode`, `agentType`, `workspaceProfile`, `provider`, `vmLocation`
2. Config precedence matches submit path: explicit field → profile → project default → platform default
3. Invalid parameter values return descriptive JSON-RPC errors
4. Existing dispatch calls without new params continue to work identically
5. `startTaskRunnerDO()` receives resolved profile-derived values (model, permissionMode, systemPromptAppend)
6. `agentProfileHint` is persisted in task metadata
7. Tests cover all new validation and precedence scenarios
8. `maxTurns` and `timeoutMinutes` are documented as not runtime-enforced

## References

- `apps/api/src/routes/mcp/dispatch-tool.ts`
- `apps/api/src/routes/mcp/tool-definitions-task-tools.ts`
- `apps/api/src/routes/tasks/submit.ts`
- `apps/api/src/services/agent-profiles.ts`
- `apps/api/src/services/task-runner-do.ts`
- `packages/shared/src/types/agent-settings.ts`
