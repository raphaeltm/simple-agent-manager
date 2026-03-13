# Implement System Limits Relaxation

**Created**: 2026-03-13
**Status**: Active
**Depends on**: Research from `tasks/backlog/2026-03-13-system-limits-review.md`

## Problem

Multiple system limits are too restrictive for real-world usage. Task descriptions are capped at 2K chars (too short for detailed prompts), credential update rate limit (5/hr) punishes onboarding, log/activity messages are truncated too aggressively, and several hardcoded limits violate constitution configurability principle.

Additionally, workspaces-per-node should be resource-based (CPU/memory thresholds) rather than a hard count limit.

## Research Findings

### Files to modify

**Shared constants** (`packages/shared/src/constants.ts`):
- `DEFAULT_MAX_PROJECTS_PER_USER`: 25 → 100
- `DEFAULT_MAX_TASK_DEPENDENCIES_PER_TASK`: 25 → 50
- Remove `DEFAULT_MAX_WORKSPACES_PER_NODE` (replace with resource-based approach)

**Rate limits** (`apps/api/src/middleware/rate-limit.ts`):
- `WORKSPACE_CREATE`: 10 → 30
- `CREDENTIAL_UPDATE`: 5 → 30

**Task submit** (`apps/api/src/routes/tasks/submit.ts`):
- `MAX_MESSAGE_LENGTH`: 2000 → 16000, make configurable via env var

**MCP routes** (`apps/api/src/routes/mcp.ts`):
- `ACTIVITY_MESSAGE_MAX_LENGTH`: 500 → 2000, make configurable
- `LOG_MESSAGE_MAX_LENGTH`: 200 → 1000, make configurable

**ACP sessions** (`apps/api/src/routes/projects/acp-sessions.ts`):
- `MAX_PROMPT_BYTES`: 65536 → 262144, make configurable via env var
- `MAX_CONTEXT_BYTES`: 65536 → 262144, make configurable via env var

**Workspace CRUD** (`apps/api/src/routes/workspaces/crud.ts`):
- Remove MAX_WORKSPACES_PER_NODE hard limit enforcement
- Resource thresholds in task-runner already handle capacity

**Task Runner DO** (`apps/api/src/durable-objects/task-runner.ts`):
- Remove MAX_WORKSPACES_PER_NODE check from `findNodeWithCapacity()`
- Keep CPU/memory threshold checks (these are the real capacity gate)

**Other hardcoded → configurable**:
- `apps/api/src/routes/workspaces/runtime.ts`: messages batch limit (100), payload limit (256KB)
- `apps/api/src/routes/workspaces/agent-sessions.ts`: agent session label length (50)

## Implementation Checklist

- [ ] Update `packages/shared/src/constants.ts` — raise limits, add new configurable defaults
- [ ] Update `apps/api/src/middleware/rate-limit.ts` — raise rate limits
- [ ] Update `apps/api/src/routes/tasks/submit.ts` — raise + make configurable
- [ ] Update `apps/api/src/routes/mcp.ts` — raise + make configurable
- [ ] Update `apps/api/src/routes/projects/acp-sessions.ts` — raise + make configurable
- [ ] Remove MAX_WORKSPACES_PER_NODE from workspace CRUD route
- [ ] Remove MAX_WORKSPACES_PER_NODE from task runner DO node selection
- [ ] Make runtime.ts batch/payload limits configurable
- [ ] Make agent-sessions.ts label length configurable
- [ ] Update existing tests to reflect new limit values
- [ ] Add tests for new configurable limits (env var override works)
- [ ] Update .env.example with new env vars
- [ ] Run lint, typecheck, test, build

## Acceptance Criteria

- [ ] All identified limits raised to recommended values
- [ ] All previously hardcoded limits now configurable via env vars
- [ ] Workspaces-per-node uses resource-based approach (no hard count)
- [ ] Existing tests updated, new env var override tests added
- [ ] All quality gates pass (lint, typecheck, test, build)
