# SAM Agent Phase A — Core Orchestration Tools

## Problem Statement

SAM currently has 4 read-only tools (list_projects, get_project_status, search_tasks, search_conversation_history). Users cannot take action through SAM — they must switch to the project chat UI to dispatch tasks or manage missions. Phase A adds 4 core orchestration tools that transform SAM from a read-only status dashboard into a functional orchestration manager.

## Research Findings

### Existing Tool Pattern
- Tools in `apps/api/src/durable-objects/sam-session/tools/`
- Each file exports `*Def: AnthropicToolDef` + async handler `(input, ctx: ToolContext) => Promise<unknown>`
- `ToolContext` has `{ env, userId, searchMessages? }` — user auth context, NOT workspace tokens
- Registered in `tools/index.ts` via `toolHandlers` map and `SAM_TOOLS` array
- Ownership verification: query projects table with `and(eq(projects.id, projectId), eq(projects.userId, userId))`

### Service Layer Reuse
- **Task submission**: `startTaskRunnerDO()` from `services/task-runner-do.ts`, `generateBranchName()`, `generateTaskTitle()`, `resolveAgentProfile()`, `projectDataService.createSession/persistMessage`
- **Mission CRUD**: Direct D1 queries for missions table + `orchestratorService.startOrchestration()` for scheduling
- **Task details**: Direct D1 query on tasks table with projects join for ownership
- **Mission details**: Direct D1 query on missions table with task summary aggregation

### Key Differences from MCP Tools
- SAM has no `taskId` or `workspaceId` — it operates as the user, not as an agent in a workspace
- SAM dispatch doesn't need depth tracking (no parent task), sub-task limits, or credential source resolution (the platform submits on behalf of the user)
- SAM needs to resolve provider credentials for the user (like the submit route does)
- Mission creation via SAM uses userId directly, not tokenData.userId from MCP context

### System Prompt
- `SAM_SYSTEM_PROMPT` in `agent-loop.ts` needs updating to describe new orchestration capabilities
- Currently mentions "dispatch work" but no tools exist for it

## Implementation Checklist

- [ ] 1. Create `dispatch-task.ts` tool
  - Validate projectId, description (required), optional: agentType, vmSize, workspaceProfile, priority, branch, taskMode, agentProfileId
  - Verify project ownership via D1 query
  - Generate task title via AI (reuse `generateTaskTitle`)
  - Generate branch name (reuse `generateBranchName`)
  - Resolve agent profile if provided (reuse `resolveAgentProfile`)
  - Resolve VM config (explicit → profile → project default → platform default)
  - Resolve credential source (reuse `resolveCredentialSource`)
  - Insert task into D1
  - Create chat session + persist initial message
  - Start TaskRunner DO
  - Record activity event
  - Return taskId, sessionId, branchName, URL

- [ ] 2. Create `get-task-details.ts` tool
  - Validate taskId (required)
  - Query tasks table joined with projects for ownership check
  - Return full task details: id, title, description, status, priority, outputBranch, outputPrUrl, outputSummary, errorMessage, timestamps

- [ ] 3. Create `create-mission.ts` tool
  - Validate projectId, title (required), optional: description, tasks array
  - Verify project ownership
  - Insert mission into D1 missions table
  - Register with ProjectOrchestrator DO
  - If tasks array provided, dispatch each as a child task with missionId
  - Return missionId, status, title

- [ ] 4. Create `get-mission.ts` tool
  - Validate missionId (required)
  - Query missions table with ownership check (join projects)
  - Get task summary (count by status)
  - Return mission details + task summary

- [ ] 5. Register all 4 tools in `tools/index.ts`
  - Import defs and handlers
  - Add to `SAM_TOOLS` array
  - Add to `toolHandlers` map

- [ ] 6. Update `SAM_SYSTEM_PROMPT` in `agent-loop.ts`
  - Add section describing orchestration capabilities
  - Mention dispatch_task, get_task_details, create_mission, get_mission

- [ ] 7. Write unit tests for each tool
  - Test ownership verification (reject unowned projectId)
  - Test successful execution with mocked D1/DO
  - Test parameter validation (missing required params)
  - Test through `executeTool` dispatch

- [ ] 8. Update CLAUDE.md recent changes section

## Acceptance Criteria

- [ ] SAM can dispatch a task to a project and the task appears in the project's task list
- [ ] SAM can get detailed status of any task owned by the user
- [ ] SAM can create a mission grouping tasks in a project
- [ ] SAM can check mission status including task summary
- [ ] All tools reject operations on projects not owned by the user
- [ ] All tools validate required parameters and return clear error messages
- [ ] System prompt describes the new capabilities
- [ ] Unit tests cover happy path, ownership rejection, and parameter validation for each tool

## References

- Existing tools: `apps/api/src/durable-objects/sam-session/tools/`
- MCP dispatch: `apps/api/src/routes/mcp/dispatch-tool.ts`
- MCP missions: `apps/api/src/routes/mcp/mission-tools.ts`
- Task submit route: `apps/api/src/routes/tasks/submit.ts`
- Service layer: `apps/api/src/services/task-runner-do.ts`, `services/task-title.ts`, `services/branch-name.ts`
