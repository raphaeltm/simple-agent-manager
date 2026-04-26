# Phase 4: Policy Propagation

## Problem Statement

Build the layered policy system for SAM's orchestration (Phase 4 of 7-phase orchestrator vision). Today policy is static files (CLAUDE.md, agent profiles, `.claude/rules/`). Phase 4 adds a dynamic layer where preferences stated in conversation become project policy, flow into mission context, and propagate to sub-agents.

## Research Findings

### Key Files
- **ProjectData DO**: `apps/api/src/durable-objects/project-data/` — per-project SQLite, module pattern (knowledge.ts as template)
- **DO Migrations**: `apps/api/src/durable-objects/migrations.ts` — latest is `018-mission-state-handoffs`, new = `019`
- **MCP tool index**: `apps/api/src/routes/mcp/index.ts` — switch/case routing
- **Tool definitions**: `apps/api/src/routes/mcp/tool-definitions.ts` — barrel, imports domain-specific definition files
- **Knowledge tools**: `apps/api/src/routes/mcp/knowledge-tools.ts` — exact pattern to follow for CRUD tools
- **Instruction tools**: `apps/api/src/routes/mcp/instruction-tools.ts` — `get_instructions` builds `result.instructions[]` array, knowledge injected via `knowledgeInstructions` and `knowledgeDirectives`
- **Dispatch tool**: `apps/api/src/routes/mcp/dispatch-tool.ts` — creates child tasks, passes missionId, connects to orchestrator
- **Service layer**: `apps/api/src/services/project-data.ts` — thin wrapper resolving DO stub
- **REST routes**: `apps/api/src/routes/knowledge.ts` — CRUD pattern with `requireOwnedProject`
- **Shared constants**: `packages/shared/src/constants/missions.ts` — `DEFAULT_*` pattern with env var override
- **Constants index**: `packages/shared/src/constants/index.ts` — re-exports all constants
- **Shared types**: `packages/shared/src/types/` — domain-specific type files

### Patterns to Follow
1. DO module: pure functions in `apps/api/src/durable-objects/project-data/policies.ts`
2. Row parsing via Valibot schemas in `row-schemas.ts`
3. Service layer: thin wrapper in `project-data.ts` calling DO methods
4. MCP tools: handler file + tool-definitions file, registered in index.ts
5. REST routes: Hono router with `requireOwnedProject` middleware
6. Constants: `DEFAULT_POLICY_*` in shared, resolver function reads env vars

### Integration Points
- `get_instructions`: inject active policies after knowledge directives (line ~126 of instruction-tools.ts)
- `dispatch_task`: fetch and attach policies when task has missionId (dispatch-tool.ts ~467)
- `ProjectOrchestrator`: log warning when handoff missing policies (orchestrator scheduling.ts)

## Implementation Checklist

### 1. Shared Types & Constants
- [ ] Create `packages/shared/src/types/policy.ts` with `PolicyCategory`, `PolicySource`, `ProjectPolicy`, `CreatePolicyRequest`, `UpdatePolicyRequest` types
- [ ] Create `packages/shared/src/constants/policies.ts` with `DEFAULT_POLICY_*` constants and `resolvePolicyLimits()` function
- [ ] Export from `packages/shared/src/types/index.ts` and `packages/shared/src/constants/index.ts`
- [ ] Build shared package

### 2. ProjectData DO Storage (Migration 019)
- [ ] Add migration `019-project-policies` in `migrations.ts` — `project_policies` table with: id, category, title, content, source, source_session_id, confidence, active, created_at, updated_at
- [ ] Create `apps/api/src/durable-objects/project-data/policies.ts` with CRUD functions: createPolicy, getPolicy, listPolicies, updatePolicy, removePolicy, getActivePolicies
- [ ] Add Valibot row schemas in `row-schemas.ts` for policy rows
- [ ] Wire into `ProjectData` DO class (index.ts) — add public methods that delegate to policies module

### 3. Service Layer
- [ ] Add policy service functions in `apps/api/src/services/project-data.ts`: createPolicy, getPolicy, listPolicies, updatePolicy, removePolicy, getActivePolicies

### 4. MCP Tools (5 tools)
- [ ] Create `apps/api/src/routes/mcp/tool-definitions-policy-tools.ts` with tool schemas
- [ ] Create `apps/api/src/routes/mcp/policy-tools.ts` with handlers: handleAddPolicy, handleListPolicies, handleGetPolicy, handleUpdatePolicy, handleRemovePolicy
- [ ] Register in `tool-definitions.ts` barrel and `index.ts` switch/case

### 5. Policy Injection into get_instructions
- [ ] In `instruction-tools.ts`, fetch active policies via `projectDataService.getActivePolicies()`
- [ ] Format as `policyDirectives` text block and `policyContext` structured data
- [ ] Add to `result.instructions[]` array with clear "PROJECT POLICY" headers
- [ ] Add policy-related instructions (how to use add_policy, when to capture preferences)

### 6. Policy Propagation via dispatch_task
- [ ] In `dispatch-tool.ts`, when task has missionId, fetch active policies
- [ ] Append policy summary to the task description so child agents receive them
- [ ] In ProjectOrchestrator scheduling, validate handoff packets reference policies (log warning if not)

### 7. REST API
- [ ] Create `apps/api/src/routes/policies.ts` with CRUD endpoints: GET /, POST /, GET /:policyId, PATCH /:policyId, DELETE /:policyId
- [ ] Mount at `/api/projects/:projectId/policies` in `index.ts`
- [ ] Guard with `requireAuth()`, `requireApproved()`, `requireOwnedProject()`

### 8. Tests
- [ ] Unit tests for DO policy CRUD (create, list, get, update, soft-delete)
- [ ] Unit tests for policy limits enforcement (max per project, title/content length)
- [ ] Integration test for policy injection into `get_instructions`
- [ ] Integration test for policy propagation through `dispatch_task`
- [ ] Unit tests for REST API routes

### 9. Documentation
- [ ] Update CLAUDE.md with Phase 4 changelog entry

## Acceptance Criteria
- [ ] Project policies stored in ProjectData DO SQLite with migration 019
- [ ] 5 MCP tools for policy CRUD work correctly
- [ ] `get_instructions` includes active project policies in its response
- [ ] `dispatch_task` propagates project policies to child tasks in missions
- [ ] REST API endpoints for UI consumption (guarded by ownership)
- [ ] All configurable limits via environment variables with defaults
- [ ] Unit tests for policy CRUD operations
- [ ] Integration tests for policy injection into `get_instructions`
- [ ] Integration test for policy propagation through `dispatch_task`
- [ ] CLAUDE.md updated with Phase 4 changelog entry
