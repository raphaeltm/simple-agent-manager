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

- [ ] New `dispatch_task` MCP tool registered in `apps/api/src/routes/mcp.ts`
- [ ] Tool creates a task via existing task submission flow (reuses TaskRunner DO orchestration)
- [ ] Agent synthesizes conversation context into a coherent task description
- [ ] User receives confirmation with task ID and link
- [ ] Dispatched task runs independently — current conversation continues uninterrupted
- [ ] Cross-project dispatch works (agent in Project A can dispatch a task in Project B)
- [ ] Task description includes relevant file references from the conversation
- [ ] Dispatched task appears in the target project's task list / kanban board

## Key Files

- `apps/api/src/routes/mcp.ts` — MCP server; add `dispatch_task` tool here
- `apps/api/src/routes/tasks/crud.ts` — existing task submission endpoint to reuse
- `apps/api/src/durable-objects/task-runner.ts` — existing orchestration (no changes needed)
- `packages/vm-agent/internal/server/mcp.go` — VM agent MCP tool registration (if applicable)

## Design Considerations

- **Auth scoping**: The MCP token is currently task-scoped. A `dispatch_task` tool would need permission to create tasks in the current project (or other projects if cross-project dispatch is supported). May need a broader token scope or a separate auth mechanism.
- **Rate limiting**: Prevent runaway agent-spawning-agent loops. Consider a max dispatch depth or per-user concurrency limit.
- **Context window**: The dispatching agent has a finite context window. Context synthesis should happen before dispatch, not by passing raw conversation history.
- **Cost awareness**: Dispatching agents consumes compute resources. Consider requiring explicit user confirmation for dispatch, or at least surfacing the estimated cost.
- **Circular dispatch prevention**: An agent dispatched by another agent should probably not be able to dispatch further agents (or should have a depth limit).
