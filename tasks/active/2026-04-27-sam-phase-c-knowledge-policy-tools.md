# SAM Phase C: Knowledge & Policy Layer Tools

## Problem

SAM currently lacks knowledge graph and policy management tools. Users cannot ask SAM to search project knowledge, add observations, or manage policies from the chat interface. Phase C adds 5 tools that make SAM the user's cross-project institutional memory.

## Research Findings

- **Existing tool pattern**: Each tool is a separate file in `apps/api/src/durable-objects/sam-session/tools/` exporting an `AnthropicToolDef` and async handler `(input, ctx: ToolContext) => Promise<unknown>`
- **ToolContext**: `{ env, userId, searchMessages? }` — has all Worker bindings via `env` and authenticated `userId`
- **Ownership verification**: Tools that accept `projectId` verify ownership via D1 `projects` table query with `userId` + `projectId` filter (see `get-project-status.ts`)
- **ProjectData DO access**: `env.PROJECT_DATA.idFromName(projectId)` → `env.PROJECT_DATA.get(id)` → typed `DurableObjectStub<ProjectData>` with RPC methods like `searchKnowledgeObservations()`, `listKnowledgeEntities()`, etc.
- **Service layer**: `apps/api/src/services/project-data.ts` wraps DO calls; policy functions in `project-data-policies.ts`
- **Shared types**: `KNOWLEDGE_ENTITY_TYPES`, `KNOWLEDGE_SOURCE_TYPES`, `KNOWLEDGE_DEFAULTS` in `packages/shared/src/types/knowledge.ts`; `isPolicyCategory`, `POLICY_CATEGORIES`, `resolvePolicyLimits` in `packages/shared/src/types/policy.ts`
- **Test pattern**: `sam-tools-phase-a.test.ts` uses `mockD1()` helper and `buildCtx()` for ToolContext, tests parameter validation + ownership rejection + executeTool dispatch
- **Cross-project search**: For `search_knowledge` without `projectId`, query user's projects from D1, then iterate each ProjectData DO's `searchKnowledgeObservations()` — aggregate and sort results

## Implementation Checklist

- [ ] Create `tools/search-knowledge.ts` — search knowledge graph across one or all projects
- [ ] Create `tools/get-project-knowledge.ts` — list knowledge entities in a project
- [ ] Create `tools/add-knowledge.ts` — add knowledge entity/observation to a project
- [ ] Create `tools/list-policies.ts` — list active policies for a project
- [ ] Create `tools/add-policy.ts` — add a policy to a project
- [ ] Register all 5 tools in `tools/index.ts` (SAM_TOOLS array + toolHandlers map)
- [ ] Update `SAM_SYSTEM_PROMPT` in `agent-loop.ts` with Knowledge and Policy tool descriptions
- [ ] Write unit tests covering parameter validation, ownership rejection, cross-project search, and executeTool dispatch

## Acceptance Criteria

- [ ] All 5 tools are registered and callable via `executeTool`
- [ ] All tools verify project ownership via D1 before accessing ProjectData DO
- [ ] `search_knowledge` supports cross-project search when `projectId` is omitted (queries all user projects)
- [ ] `add_knowledge` creates entity if not existing, adds observation
- [ ] `add_policy` validates category enum
- [ ] Unit tests cover: missing params, invalid params, unowned project rejection, successful execution, cross-project search, executeTool dispatch
- [ ] System prompt updated with Knowledge and Policy tool categories
- [ ] All quality gates pass (lint, typecheck, test, build)
