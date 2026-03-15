# Move SAM instructions from prompt prefix to suffix

## Problem

When SAM submits a task to an agent, it prepends an `IMPORTANT:` instruction block before the user's actual task description (`task-runner.ts:870-874`). This prefix forces the agent to call `get_instructions` before doing anything else.

This breaks workflows where users specify skills, slash commands, or specific workflow triggers in their task description. The prefix competes for agent attention and delays or overrides the user's actual intent.

## Research Findings

- **Prefix location**: `apps/api/src/durable-objects/task-runner.ts:870-874` in `handleAgentSession()`
- **Current format**: `IMPORTANT: Before starting any work...` + separator + task content
- **MCP tool**: `get_instructions` already returns the clean task description + metadata via `apps/api/src/routes/mcp.ts:326-388`
- **No other injection points**: The prefix is the only place SAM instructions are injected into the initial prompt
- **Agent types affected**: All agents receive the same prefixed prompt regardless of type

## Implementation Checklist

- [ ] Move the SAM instruction from a prefix to a suffix in `task-runner.ts:870-874`
- [ ] Soften the language — make it a helpful note rather than a demanding `IMPORTANT:` block
- [ ] Keep the user's task content as the first thing the agent sees
- [ ] Update existing tests that assert on the initial prompt format
- [ ] Verify no other code depends on the prefix format

## Acceptance Criteria

- [ ] User's task description appears first in the initial prompt (before any SAM instructions)
- [ ] SAM instructions appear after a separator as a note/hint
- [ ] The `get_instructions` MCP tool reference is preserved so agents know it's available
- [ ] All existing tests pass (updated if they assert on prompt format)
- [ ] No hardcoded values introduced (constitution Principle XI compliance)

## References

- `apps/api/src/durable-objects/task-runner.ts` — prefix injection point
- `apps/api/src/routes/mcp.ts` — MCP get_instructions handler
- `apps/api/src/services/node-agent.ts` — startAgentSessionOnNode
