# Project Settings: Default Agent Type Selection

**Created**: 2026-02-28
**Status**: Backlog
**Priority**: Medium
**Estimated Effort**: Small

## Problem

When tasks are submitted, the system defaults to `claude-code` as the agent type via the `DEFAULT_TASK_AGENT_TYPE` env var. There is no way for users to choose a different agent (e.g., `openai-codex`, `google-gemini`) per project. The agent catalog already exists in `packages/shared/src/agents.ts` and the VM agent supports multiple agent types, but the task submission flow bypasses agent selection entirely.

## Proposed Solution

Add an "Agent Type" setting to project settings that determines which agent is used for task execution in that project.

### Changes

1. **Database**: Add `default_agent_type` column to `projects` table (nullable, defaults to platform default)
2. **API**: Include `defaultAgentType` in project settings GET/PUT endpoints
3. **UI**: Add agent type dropdown to project settings page, populated from the agent catalog
4. **Task Submit**: Read project's `defaultAgentType` and pass it through the task config to the TaskRunner DO
5. **TaskRunner DO**: Use `state.config.agentType` instead of env var fallback

### Precedence Order

1. Task-level override (future — if we add agent selection to the task submit form)
2. Project-level `defaultAgentType` setting
3. Platform-level `DEFAULT_TASK_AGENT_TYPE` env var
4. Hardcoded fallback: `"claude-code"`

## Related Files

| File | Role |
|------|------|
| `apps/api/src/db/schema.ts` | Add column to projects table |
| `apps/api/src/routes/projects.ts` | Project settings endpoints |
| `apps/web/src/pages/ProjectSettings.tsx` | Settings UI |
| `packages/shared/src/agents.ts` | Agent catalog (already exists) |
| `apps/api/src/durable-objects/task-runner.ts` | Reads agent type for task execution |
| `apps/api/src/routes/task-submit.ts` | Passes config to TaskRunner |

## Context

This task was created alongside the initial prompt delivery fix (feat/initial-prompt-delivery), which introduced the `DEFAULT_TASK_AGENT_TYPE` env var as a temporary default. This task replaces that blunt default with per-project configurability.
