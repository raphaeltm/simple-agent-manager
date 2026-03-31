# Wire Agent Profile systemPromptAppend to Initial Prompt

**Created**: 2026-03-31
**Status**: backlog

## Problem

Agent profiles have a `systemPromptAppend` field (stored in the `agent_profiles` table, modeled in the `AgentProfile` and `ResolvedAgentProfile` types) that is intended to append custom instructions to the agent's initial prompt. However, this field is fully modeled but **completely unwired** — it is resolved from the database but never forwarded to the TaskRunner DO or included in the initial prompt sent to the agent.

### Current Flow (Broken)

1. User creates an agent profile with `systemPromptAppend` value → stored in DB
2. On task submission, `resolveAgentProfile()` loads the profile including `systemPromptAppend`
3. **GAP**: `submit.ts:397-402` passes `agentType`, `model`, and `permissionMode` from the resolved profile but **drops `systemPromptAppend`**
4. `task-runner.ts:1032-1036` builds `initialPrompt` from only task description + attachments + MCP instructions — no profile system prompt
5. Agent never sees the profile's custom instructions

### Expected Flow (Fixed)

1. Same as above
2. Same as above
3. `submit.ts` passes `systemPromptAppend` to the TaskRunner DO config
4. `task-runner.ts` appends the profile's instructions to the initial prompt before the MCP instructions block
5. Agent sees the custom instructions in its first message

## Research Findings

### Key Files

- `apps/api/src/routes/tasks/submit.ts` — Task submission route; resolves agent profile but drops `systemPromptAppend` at line 397-402
- `apps/api/src/durable-objects/task-runner.ts` — `TaskRunConfig` interface (line 104) and initial prompt construction (line 1032-1036)
- `apps/api/src/services/agent-profiles.ts` — `resolveAgentProfile()` correctly returns `systemPromptAppend`
- `packages/shared/src/types.ts` — `ResolvedAgentProfile` type includes `systemPromptAppend: string | null`

### ACP / Claude Code System Prompt

ACP does not have a separate system prompt mechanism. The initial prompt is sent as a user message via `Prompt()`. The "(append)" mode means appending the profile's instructions to this initial user message string.

### Built-in Profiles

Three built-in profiles already define `systemPromptAppend` values:
- "planner": "Decompose tasks. Do not write code directly."
- "implementer": "Focus on implementation. Write tests for all changes."
- "reviewer": "Review code for correctness, security, and style."

None of these are currently delivered to the agent.

## Implementation Checklist

- [x] Add `systemPromptAppend: string | null` field to `TaskRunConfig` interface in `task-runner.ts`
- [x] Pass `resolvedProfile?.systemPromptAppend ?? null` in the config object in `submit.ts`
- [x] Append `systemPromptAppend` to the initial prompt in `task-runner.ts` (before the MCP instructions separator)
- [x] Add unit test: verify `systemPromptAppend` is included in the initial prompt when present
- [x] Add unit test: verify initial prompt is unchanged when `systemPromptAppend` is null
- [x] Update existing tests if they assert on the exact initial prompt format (none needed — existing tests are source-contract and unaffected)

## Acceptance Criteria

- [ ] When a task is submitted with an agent profile that has a `systemPromptAppend`, the agent's initial prompt includes the appended text
- [ ] When a task is submitted without an agent profile (or with one that has null `systemPromptAppend`), the initial prompt is unchanged from current behavior
- [ ] Built-in profiles ("planner", "implementer", "reviewer") deliver their instructions when selected
- [ ] At least one test verifies the system prompt append reaches the initial prompt
- [ ] At least one test verifies null/missing systemPromptAppend doesn't alter the prompt

## References

- Agent profile types: `packages/shared/src/types.ts` (ResolvedAgentProfile)
- Agent profile service: `apps/api/src/services/agent-profiles.ts`
- Task runner: `apps/api/src/durable-objects/task-runner.ts`
- Submit route: `apps/api/src/routes/tasks/submit.ts`
