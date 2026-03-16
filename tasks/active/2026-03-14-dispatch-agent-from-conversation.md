# Dispatch SAM Agents from Conversation Context

## Problem

When working with a SAM agent on research or planning, the natural next step is often "now go build this." Today, that requires the user to leave the conversation, navigate to the project UI, create a new task, paste in the context, and submit it. This breaks flow and loses the rich conversational context that led to the decision.

## Context

This desire surfaced naturally during a research task: after completing a notification system research doc and backlog task, the immediate impulse was "I wish I could just tell you to spin up another agent to start working on this." The agent already has full context — the research findings, the architectural decisions, the phased plan, the key files involved. Having to manually re-describe all of that in a new task submission is friction that shouldn't exist.

This is a meta-capability: SAM agents should be able to spawn other SAM agents. The conversational context becomes the task brief.

## What This Could Look Like

### From the User's Perspective

Mid-conversation, the user says something like:
> "Dispatch an agent to implement Phase 1 of the notification system based on our research"

The current agent:
1. Synthesizes the relevant context from the conversation into a task description
2. Calls a SAM MCP tool (e.g., `dispatch_task`) with the description, target project, and any relevant file references
3. SAM creates the task, assigns it to a node/workspace, and starts execution
4. The user gets a confirmation with a link to the new task ("Task #57 dispatched — agent starting on Project SAM")
5. The user continues their current conversation uninterrupted

### From the Agent's Perspective

A new MCP tool available to agents:

```
dispatch_task:
  project_id: string        # which project to run in (default: current project)
  description: string       # task description synthesized from conversation
  priority: number          # optional priority
  vm_size: string           # optional VM size override
  references: string[]      # optional file paths or URLs for context
```

The tool creates a task via the existing task submission API, which triggers the existing TaskRunner DO orchestration (node selection → workspace creation → agent session). No new orchestration needed — just a new entry point.

### Conversational Dispatch Patterns

Several natural patterns emerge:

1. **Research → Implementation**: "We just figured out the architecture. Dispatch an agent to build Phase 1."
2. **Bug Discovery → Fix**: "I see a bug in the notification grouping logic. Dispatch an agent to fix it."
3. **Parallel Work**: "While we continue on the API, dispatch an agent to build the UI components."
4. **Follow-up**: "The agent finished the PR but tests are failing. Dispatch an agent to fix the test failures."
5. **Cross-Project**: "This notification system needs changes in both the API and the VM agent. Dispatch agents for each."

### Context Synthesis

The key challenge is synthesizing good task descriptions from conversational context. The dispatching agent should:
- Extract the specific goal from the user's request
- Include relevant decisions and constraints from the conversation
- Reference specific files, specs, or research docs discussed
- NOT dump the entire conversation — distill it into an actionable brief
- Optionally attach the research doc or backlog task as a reference

### Relationship to Notifications

This feature pairs naturally with the notification system (see `tasks/backlog/2026-03-14-notification-system.md`). When a dispatched agent completes or needs input, the notification system alerts the user — closing the loop without requiring them to actively monitor the spawned task.

## Acceptance Criteria

- [x] New `dispatch_task` MCP tool registered in `apps/api/src/routes/mcp.ts`
- [x] Tool creates a task via existing task submission flow (reuses TaskRunner DO orchestration)
- [x] Agent synthesizes conversation context into a coherent task description
- [x] User receives confirmation with task ID and link
- [x] Dispatched task runs independently — current conversation continues uninterrupted
- [ ] Cross-project dispatch works (agent in Project A can dispatch a task in Project B) — **Deferred**: token is project-scoped; cross-project dispatch requires a new auth model
- [x] Task description includes relevant file references from the conversation
- [x] Dispatched task appears in the target project's task list / kanban board

## Implementation Details

### Rate Limiting (Three-Layer Defense)

1. **Dispatch depth** (`dispatch_depth` column on tasks table): User-created tasks = 0, each agent dispatch increments by 1. Configurable max via `MCP_DISPATCH_MAX_DEPTH` (default: 3). Prevents unbounded recursive spawning.
2. **Per-task child limit**: Each agent can dispatch at most `MCP_DISPATCH_MAX_PER_TASK` tasks (default: 5). Prevents a single runaway agent from monopolizing resources.
3. **Per-project active limit**: At most `MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT` (default: 10) agent-dispatched tasks can be active concurrently per project. Prevents project-level resource exhaustion.

### Auth Scoping

The existing task-scoped MCP token (`McpTokenData`) already contains `projectId` and `userId`. For same-project dispatch, no token scope change is needed — the handler validates the agent has credentials and the project exists. Cross-project dispatch is deferred.

### Schema Change

Added `dispatch_depth INTEGER NOT NULL DEFAULT 0` to the `tasks` table. Requires D1 migration at deploy time.

### Key Design Decisions

- **No cross-project dispatch** in v1 — the MCP token is project-scoped, and cross-project auth raises trust/permission questions
- **D1 COUNT queries for rate limiting** — dispatch is infrequent enough (not per-message) that D1 queries are fine
- **Parent task's output branch used as checkout branch** — dispatched agents continue from where the parent left off
- **References appended to description** — file paths/URLs are appended as a `## References` section rather than a separate field

## Key Files

- `apps/api/src/routes/mcp.ts` — MCP server; `dispatch_task` tool + `handleDispatchTask` handler
- `apps/api/src/db/schema.ts` — `dispatchDepth` column on tasks table
- `apps/api/src/index.ts` — `MCP_DISPATCH_*` env vars in Env interface
- `apps/api/.env.example` — documented dispatch config vars
- `apps/api/tests/unit/routes/mcp.test.ts` — unit tests for dispatch_task validation

## Design Considerations (Resolved)

- **Auth scoping**: Resolved — same-project dispatch uses existing token. Cross-project deferred.
- **Rate limiting**: Resolved — three-layer defense (depth + per-task + per-project).
- **Context window**: Resolved — tool description instructs agents to synthesize context, not dump raw history.
- **Cost awareness**: Partially addressed — rate limits cap resource usage. User confirmation deferred to future UI work.
- **Circular dispatch prevention**: Resolved — dispatch depth limit prevents unbounded recursion.
