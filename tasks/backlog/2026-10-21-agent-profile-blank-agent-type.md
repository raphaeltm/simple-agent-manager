# Agent profiles can store a blank agent type

## Problem

`agent_profiles.agent_type` is `NOT NULL`, but `createAgentProfile` and `updateAgentProfile` (`apps/api/src/services/agent-profiles.ts`) validate with `if (body.agentType && !isValidAgentType(body.agentType))`. A blank string skips that check. `baseProfileInsertValues` then stores it, because `body.agentType ?? env.DEFAULT_TASK_AGENT_TYPE ?? 'opencode'` does not fall through on `''`. A profile with `agent_type = ''` would give runs an empty agent type, including through `resolveSkillProfile` when the skill has no override.

## Context

Found by review of `sam/skill-agent-empty-clears`, the follow-up to #2399, on 2026-10-21. That branch normalizes a blank skill agent type to NULL ("no override"). Profiles need a different rule, because a profile must always name an agent. This predates #2399 and is not made worse by it.

## Acceptance criteria

- [ ] Creating or updating an agent profile with a blank or whitespace agent type either applies the documented default (create) or is rejected with 400 (update). It never stores `''`.
- [ ] Real-SQL tests cover create and update, through the REST route and the MCP profile tools.
