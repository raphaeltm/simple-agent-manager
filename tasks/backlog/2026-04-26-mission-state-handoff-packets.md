# Mission State and Handoff Packets (Phase 2)

## Problem Statement

SAM agents currently share context by improvising through git, chat, library uploads, and knowledge graph entries. When tasks are decomposed into subtasks via `dispatch_task`, there's no structured mechanism for:
- Grouping related tasks into a coordinated body of work (a "mission")
- Sharing structured state (decisions, assumptions, facts, risks) across tasks in a mission
- Passing structured handoff packets between sequential tasks

This phase adds the mission, mission state, and handoff packet primitives that the project orchestrator (Phase 3) and policy propagation (Phase 4) will build on.

## Research Findings

### Existing Infrastructure
- **D1 schema** (`apps/api/src/db/schema.ts`): `tasks` table has `parentTaskId` and `dispatchDepth` for parent-child. `taskDependencies` junction table exists. Next migration number: **0048**.
- **ProjectData DO** (`apps/api/src/durable-objects/project-data/`): Modular architecture — each feature is a separate `.ts` module with pure functions accepting `sql: SqlStorage`. Migrations in `migrations.ts` (sequential numbered array). Currently at migration **016**. Next: **017**.
- **MCP tools** (`apps/api/src/routes/mcp/`): Split across files — tool definitions in `tool-definitions-*.ts`, handlers in separate files. `dispatch-tool.ts` is the model for new dispatch params.
- **Shared types** (`packages/shared/src/types/`): `task.ts` defines `TaskStatus`, `TaskMode`, etc. Types re-exported from `index.ts`.

### Architecture Decisions
- **Missions in D1**: Cross-project queryable (dashboard, task list). New `missions` table with FK to `projects`.
- **Task-mission link**: `ALTER TABLE tasks ADD COLUMN mission_id TEXT` (nullable). Tasks without a mission unchanged.
- **Scheduler state on tasks**: `ALTER TABLE tasks ADD COLUMN scheduler_state TEXT` (nullable). Only meaningful for mission tasks.
- **Mission state entries in ProjectData DO SQLite**: Per-project, high-write. New `mission_state_entries` table in DO migration 017.
- **Handoff packets in ProjectData DO SQLite**: Per-project, tied to task transitions. New `handoff_packets` table in DO migration 017.

### Migration Safety
- `tasks` table is a CASCADE parent (has children: `task_dependencies`, `task_status_events`). Rule 31 applies: only ALTER TABLE ADD COLUMN, never DROP TABLE.
- New `missions` table can use CREATE TABLE safely (no existing children).

## Implementation Checklist

### 1. Shared Types
- [ ] Add `MissionStatus` type to `packages/shared/src/types/`
- [ ] Add `SchedulerState` type (the 10 states from the vision doc)
- [ ] Add `MissionStateEntryType` type (7 types: decision, assumption, fact, contract, artifact_ref, risk, todo)
- [ ] Add `Mission`, `MissionStateEntry`, `HandoffPacket` types
- [ ] Add configurable constants (`MISSION_*`, `HANDOFF_*`)
- [ ] Re-export from `packages/shared/src/types/index.ts`

### 2. D1 Migration (0048)
- [ ] `CREATE TABLE missions` (id, projectId FK, userId FK, title, description, status, rootTaskId, budget fields as nullable JSON, createdAt, updatedAt)
- [ ] `ALTER TABLE tasks ADD COLUMN mission_id TEXT` (nullable, no FK — missions may be in D1 while tasks reference them loosely)
- [ ] `ALTER TABLE tasks ADD COLUMN scheduler_state TEXT` (nullable)
- [ ] Add index on `tasks.mission_id` for mission-scoped queries
- [ ] Add index on `missions.project_id` for project-scoped queries

### 3. D1 Schema (Drizzle)
- [ ] Add `missions` table definition to `schema.ts`
- [ ] Add `missionId` and `schedulerState` columns to `tasks` table
- [ ] Add type exports (`Mission`, `NewMission`)

### 4. ProjectData DO Migration (017)
- [ ] `CREATE TABLE mission_state_entries` (id, missionId, type, title, content, publishedBy, publishedByTaskId, supersedes, confidence, createdAt, updatedAt)
- [ ] `CREATE TABLE handoff_packets` (id, missionId, fromTaskId, toTaskId, summary, factsJson, openQuestionsJson, artifactRefsJson, suggestedActionsJson, version, createdAt)
- [ ] Add indexes for missionId lookups

### 5. ProjectData DO Module
- [ ] Create `apps/api/src/durable-objects/project-data/missions.ts` with pure functions for mission state and handoff CRUD
- [ ] Add public RPC methods to ProjectData DO class (`publishMissionState`, `getMissionState`, `publishHandoff`, `getHandoff`, etc.)

### 6. Service Layer
- [ ] Add mission state and handoff functions to `apps/api/src/services/project-data.ts`

### 7. MCP Tools — Mission Management
- [ ] Add tool definitions in `apps/api/src/routes/mcp/tool-definitions-mission-tools.ts`
- [ ] Add tool handlers in `apps/api/src/routes/mcp/mission-tools.ts`:
  - `create_mission` — create a new mission for the current project
  - `get_mission` — get mission details + task graph
  - `publish_mission_state` — publish a state entry (decision, fact, etc.)
  - `get_mission_state` — get all state entries for a mission
  - `publish_handoff` — publish a handoff packet from current task
  - `get_handoff` — get handoff packet(s) for a task
- [ ] Register tools in MCP index

### 8. Dispatch Tool Upgrade
- [ ] Add `missionId` parameter to `dispatch_task` tool definition
- [ ] Pass `missionId` through to task creation in `dispatch-tool.ts`
- [ ] Child tasks inherit `mission_id` from parent when dispatching within a mission

### 9. REST API
- [ ] `GET /api/projects/:projectId/missions` — list missions for a project
- [ ] `GET /api/projects/:projectId/missions/:missionId` — get mission with task tree
- [ ] `GET /api/projects/:projectId/missions/:missionId/state` — get mission state entries
- [ ] `GET /api/projects/:projectId/missions/:missionId/handoffs` — get handoff packets
- [ ] Register routes in API index

### 10. Scheduler State Computation
- [ ] Create `apps/api/src/services/scheduler-state.ts` — deterministic computation of scheduler state from dependency graph + task status
- [ ] Integrate: recompute scheduler state on task status changes (in task-tools.ts or task-runner-do)

### 11. Tests
- [ ] Unit tests for shared types and constants
- [ ] Unit tests for scheduler state computation
- [ ] Integration tests for D1 mission CRUD
- [ ] Integration tests for ProjectData DO mission state + handoff operations
- [ ] Capability test: mission lifecycle (create mission → dispatch tasks → publish state → handoff → complete)
- [ ] Verify existing single-task workflow is unaffected (mission_id = null)

### 12. Documentation
- [ ] Update CLAUDE.md with mission-related info
- [ ] Update `apps/api/.env.example` with new configurable env vars

## Acceptance Criteria

- [ ] Missions can be created, queried, and associated with tasks
- [ ] Tasks can be grouped into missions via `mission_id`
- [ ] Scheduler state computed and stored per-task
- [ ] Handoff packets can be published by completing agents and read by dependent tasks
- [ ] Mission state entries (all 7 types) can be CRUD'd by agents via MCP tools
- [ ] `dispatch_task` supports `mission_id` parameter for child task inheritance
- [ ] REST API for mission browsing (list missions, get mission with task graph, get mission state)
- [ ] Capability tests proving mission lifecycle works across boundaries
- [ ] Migration safety verified (ALTER TABLE ADD COLUMN for existing tables, new tables for new data)
- [ ] Existing single-task workflows unaffected (mission is opt-in)
- [ ] All limits and timeouts configurable via env vars (Constitution Principle XI)

## References

- Vision: `strategy/orchestration/sam-the-orchestrator.md` (project library)
- D1 schema: `apps/api/src/db/schema.ts`
- DO migrations: `apps/api/src/durable-objects/migrations.ts`
- Dispatch tool: `apps/api/src/routes/mcp/dispatch-tool.ts`
- MCP helpers: `apps/api/src/routes/mcp/_helpers.ts`
- Migration safety: `.claude/rules/31-migration-safety.md`
