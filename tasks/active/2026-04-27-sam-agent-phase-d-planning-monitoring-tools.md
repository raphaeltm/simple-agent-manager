# SAM Agent Phase D: Planning & Monitoring Tools

## Problem

SAM needs planning and monitoring capabilities — 5 tools that let it manage ideas, check CI status, and view orchestrator state. These round out SAM as a planning partner and monitoring hub.

## Research Findings

- **Existing SAM tool pattern**: Each tool is a separate file in `apps/api/src/durable-objects/sam-session/tools/` exporting a `*Def: AnthropicToolDef` and an async handler `(input, ctx: ToolContext) => Promise<unknown>`. Registered in `tools/index.ts`.
- **ToolContext**: `{ env, userId, searchMessages? }` — user auth, not workspace-scoped.
- **Ownership**: Every tool accepting `projectId` must verify via Drizzle `projects.userId === ctx.userId`.
- **Ideas are tasks**: Stored in D1 `tasks` table with `status='draft'`. MCP idea tools in `routes/mcp/idea-tools.ts` show the exact query patterns.
- **CI status**: Existing MCP `get_ci_status` in `routes/mcp/workspace-tools-direct.ts` uses `getUserGitHubToken()` to decrypt stored GitHub credentials, then calls `GET /repos/{owner}/{repo}/actions/runs`. SAM version should query the default branch (not task branch) and use the same credential resolution pattern.
- **Orchestrator status**: `services/project-orchestrator.ts` has `getOrchestratorStatus(env, projectId)` which calls the ProjectOrchestrator DO stub. The existing `get-project-status.ts` SAM tool already queries the orchestrator — dedicated tool gives more detail.
- **File size limit**: Under 500 lines per file.
- **System prompt**: Lives in `agent-loop.ts` as `SAM_SYSTEM_PROMPT`. Needs a new "Planning & Monitoring" section.

## Implementation Checklist

- [ ] Create `tools/create-idea.ts` — insert into tasks table with status='draft', verify project ownership
- [ ] Create `tools/list-ideas.ts` — query tasks with status='draft' for a project, verify ownership
- [ ] Create `tools/find-related-ideas.ts` — LIKE search on title/description in tasks, verify ownership
- [ ] Create `tools/get-ci-status.ts` — resolve GitHub token, query Actions API for default branch, verify ownership
- [ ] Create `tools/get-orchestrator-status.ts` — query ProjectOrchestrator DO via service, verify ownership
- [ ] Register all 5 tools in `tools/index.ts` (SAM_TOOLS array + toolHandlers map)
- [ ] Update `SAM_SYSTEM_PROMPT` in `agent-loop.ts` with Planning & Monitoring section
- [ ] Add unit tests in `tests/unit/durable-objects/sam-tools-phase-d.test.ts`
- [ ] Run typecheck, lint, test, build

## Acceptance Criteria

- [ ] All 5 tools are callable via `executeTool` and return proper results
- [ ] All tools reject unowned projectIds with `{ error: 'Project not found...' }`
- [ ] `create_idea` creates a task row with status='draft' in D1
- [ ] `list_ideas` returns draft tasks for the project with snippet descriptions
- [ ] `find_related_ideas` performs LIKE search and returns matching ideas
- [ ] `get_ci_status` resolves GitHub credentials and calls Actions API (gracefully handles missing credentials)
- [ ] `get_orchestrator_status` queries the ProjectOrchestrator DO and returns scheduling status
- [ ] SAM_SYSTEM_PROMPT describes all new tools
- [ ] All new tools have unit tests covering parameter validation, ownership rejection, and registration
- [ ] No hardcoded values (Constitution Principle XI) — limits and timeouts configurable via env vars
