# LLM-Powered Task Prioritization

**Created**: 2026-03-09
**Research**: `docs/notes/2026-03-09-llm-task-prioritization-research.md`

## Problem

Task priority in SAM is currently manual — users set an integer priority on each task. As task queues grow, users need a way to dynamically prioritize tasks based on project-specific criteria (e.g., "bugs before features", "payment code is critical", "deprioritize cosmetic changes"). An LLM with access to the git repo can evaluate tasks against these criteria far more accurately than static rules.

## Research Findings

- **Priority infrastructure exists**: `tasks.priority` column, composite index, `sort=priorityDesc` API param, kanban sort — all working.
- **Workers AI + Mastra pattern proven**: `task-title.ts` demonstrates the full pattern (AI binding, Mastra agent, structured output, retry, fallback, env var config).
- **Project-level settings pattern exists**: `projects.defaultVmSize`, `defaultAgentType` — schema supports per-project config additions.
- **No automated prioritization exists today**: Priority is purely manual integer assignment.

## Implementation Checklist

### Phase 1: Foundation (MVP)

- [ ] Add `prioritization_prompt` (text, nullable) and `prioritization_enabled` (integer, default 0) columns to `projects` table
- [ ] Create D1 migration for new columns
- [ ] Update `Project` type in `packages/shared/src/types.ts`
- [ ] Update project PATCH route to accept new fields
- [ ] Create `apps/api/src/services/task-prioritization.ts` service:
  - [ ] Mastra agent with configurable model (default: same as task-title)
  - [ ] System prompt that includes user criteria + repo context
  - [ ] Batch evaluation: accept list of tasks, return priority scores (0-100) with reasoning
  - [ ] Structured JSON output via Mastra
  - [ ] Repo context: file tree (depth 3) + README.md + recent git log (20 commits)
  - [ ] Retry logic matching `task-title.ts` pattern
  - [ ] Graceful fallback: tasks keep existing priority on failure
  - [ ] Configurable env vars: `TASK_PRIORITY_MODEL`, `TASK_PRIORITY_TIMEOUT_MS`, `TASK_PRIORITY_ENABLED`, `TASK_PRIORITY_MAX_TASKS_PER_BATCH`
- [ ] Add defaults to `packages/shared/src/constants.ts`
- [ ] Create API endpoint: `POST /api/projects/:projectId/prioritize`
  - [ ] Accepts optional `taskIds` array (defaults to all draft/ready tasks)
  - [ ] Returns `{ results: [{taskId, priority, reasoning}], model, tokenUsage }`
  - [ ] Validates project has prioritization enabled + prompt configured
- [ ] Write unit tests for prioritization service (success, fallback, batch handling)
- [ ] Write integration test for API endpoint

### Phase 2: UI + Auto-Trigger

- [ ] Add "Task Prioritization" section to project settings UI
  - [ ] Textarea for criteria prompt with placeholder examples
  - [ ] Enable/disable toggle
- [ ] Add "Re-prioritize" button to kanban board toolbar
- [ ] Show priority reasoning tooltip on task cards (hover)
- [ ] Auto-prioritize on task submit (async, fire-and-forget after task creation)
- [ ] Upgrade repo context to targeted file retrieval (Option B from research)

### Phase 3: Refinement

- [ ] Priority stability: hysteresis (only update if delta > threshold)
- [ ] Batch chunking for large task queues (50+ tasks)
- [ ] User feedback on priority assignments (thumbs up/down)
- [ ] Analytics: track override frequency
- [ ] Optional periodic re-prioritization via DO alarm

## Acceptance Criteria

- [ ] User can configure a natural-language prioritization prompt per project
- [ ] Calling the prioritize endpoint re-scores all pending tasks using the LLM
- [ ] LLM receives repo context (file tree + README) alongside task descriptions
- [ ] Priority scores are written to `tasks.priority` and reflected in kanban sort order
- [ ] Feature is fully configurable via env vars (model, timeout, enable/disable)
- [ ] Failure does not modify existing priorities (graceful fallback)
- [ ] Unit + integration tests cover happy path, failure path, and batch handling

## Key Dependencies

- Workers AI binding (already configured)
- Mastra + workers-ai-provider (already in deps)
- `tasks.priority` column + index (already exists)
- Project settings pattern (already established)

## References

- Research doc: `docs/notes/2026-03-09-llm-task-prioritization-research.md`
- Task title service (pattern): `apps/api/src/services/task-title.ts`
- Task schema: `apps/api/src/db/schema.ts:283-334`
- Task routes: `apps/api/src/routes/tasks.ts`
- Shared constants pattern: `packages/shared/src/constants.ts:204-227`
