# Agent Profiles — Phase 1: Schema, API & Resolution Logic

**Created**: 2026-03-15
**Depends on**: Nothing (first in series)
**Blocks**: Phase 2 (Task Runner Integration), Phase 3 (UI), Phase 4 (System Prompt Injection)
**Series**: Agent Profiles (1 of 4)

## Problem

SAM currently supports multiple agent types (Claude Code, Codex, Gemini, Mistral Vibe) with per-user settings (`agentSettings` table) and a free-text `agentProfileHint` on tasks. But there's no way to define **reusable, project-scoped agent configurations** — combinations of agent type, model, permission mode, system prompt, timeout, and infrastructure hints that can be selected when submitting tasks.

The orchestration vision doc (`docs/design/orchestration-platform-vision.md`) defines an `agent_profiles` table and built-in profiles (planner, implementer, reviewer, tester). The orchestrator maturity assessment (`docs/notes/2026-03-08-orchestrator-maturity-assessment.md`) identifies this as Gap 6 (MEDIUM priority). Neither is implemented.

## Goal

Implement the data layer and API for agent profiles so that profiles can be created, read, updated, deleted, and resolved at task execution time. This phase does NOT include UI or task runner wiring — those are subsequent tasks.

## Acceptance Criteria

- [ ] D1 migration adds `agent_profiles` table with fields: id, project_id (nullable for global), user_id, name, description, agent_type, model, permission_mode, system_prompt_append, max_turns, timeout_minutes, vm_size_override, created_at, updated_at
- [ ] Unique constraint on (project_id, name) — no two profiles with the same name in the same project
- [ ] Drizzle schema definition in `apps/api/src/db/schema.ts`
- [ ] Shared TypeScript types in `packages/shared/src/types.ts`: `AgentProfile`, `CreateAgentProfileRequest`, `UpdateAgentProfileRequest`
- [ ] REST API endpoints (all require auth):
  - `GET /api/projects/:projectId/agent-profiles` — list profiles for a project (includes global profiles)
  - `POST /api/projects/:projectId/agent-profiles` — create a profile scoped to a project
  - `GET /api/projects/:projectId/agent-profiles/:profileId` — get profile details
  - `PUT /api/projects/:projectId/agent-profiles/:profileId` — update a profile
  - `DELETE /api/projects/:projectId/agent-profiles/:profileId` — delete a profile
- [ ] Profile resolution function: `resolveAgentProfile(projectId, profileNameOrId, env)` that returns the merged configuration. Resolution order: explicit profile > project default > platform default (env var `DEFAULT_TASK_AGENT_TYPE`)
- [ ] Seed built-in profiles on first access (or migration): `default`, `planner`, `implementer`, `reviewer` with sensible defaults per the vision doc
- [ ] Validation: agent_type must be a valid `AgentType` from the agent catalog; model/permission_mode are freeform strings (agents define their own valid values)
- [ ] Integration tests covering CRUD operations, profile resolution, and uniqueness constraints
- [ ] Capability test: create a profile, resolve it, verify all fields propagate correctly

## Implementation Notes

- The existing `agentSettings` table is per-user, per-agent-type. Agent profiles are per-project and define a *role* (planner, implementer, etc.), not just agent preferences. They coexist — `agentSettings` is "how I like Claude configured" while `agentProfiles` is "what kind of agent should do this task."
- The `agentProfileHint` field on tasks will eventually reference a profile name/ID instead of being free text. That wiring happens in Phase 2.
- No org_id column for now — SAM doesn't have org-level entities yet. Use `project_id = NULL` for "global" profiles owned by the user.
- Keep the API scoped under projects (`/api/projects/:projectId/agent-profiles`) to match the project-first architecture.

## References

- Vision doc: `docs/design/orchestration-platform-vision.md` (lines 320-365)
- Maturity assessment: `docs/notes/2026-03-08-orchestrator-maturity-assessment.md` (Gap 6)
- Current agent catalog: `packages/shared/src/agents.ts`
- Current agent settings schema: `apps/api/src/db/schema.ts` (lines 517-544)
- Task runner agent type resolution: `apps/api/src/durable-objects/task-runner.ts` (line 806)
