# Quickstart: Projects and Tasks Foundation MVP

**Phase 1 output** | **Date**: 2026-02-18

## Overview

This feature introduces project-first planning to SAM:
- Create Projects linked to GitHub repositories
- Manage project-scoped Tasks and dependencies
- Manually delegate ready tasks to existing workspaces

No orchestrator automation is included in this MVP.

## Implementation Phases

### Phase 1: API Data Layer (D1 + Drizzle)

**Goal**: Persist Project/Task entities with ownership-safe constraints.

1. Add migrations for:
- `projects`
- `tasks`
- `task_dependencies`
- `task_status_events`

2. Update `apps/api/src/db/schema.ts` with new tables and indexes.
3. Add shared constants/defaults for project/task limits in `packages/shared/src/constants.ts`.
4. Extend `Env` and runtime limit parsing in `apps/api/src/index.ts` and `apps/api/src/services/limits.ts`.

### Phase 2: API Routes and Business Rules

**Goal**: Expose Project/Task APIs with strict ownership + DAG validation.

1. Add `apps/api/src/routes/projects.ts`:
- `POST /api/projects`
- `GET /api/projects`
- `GET /api/projects/:id`
- `PATCH /api/projects/:id`
- `DELETE /api/projects/:id`

2. Add `apps/api/src/routes/tasks.ts` (or nested under project routes):
- Task CRUD/list/filter/sort
- Status transitions with transition matrix validation
- Dependency CRUD with cycle checks
- Manual delegation endpoint (`task -> workspace`)

3. Add `apps/api/src/services/task-graph.ts`:
- Cycle detection on edge writes
- Blocked-state computation

4. Register new route modules in `apps/api/src/index.ts`.

### Phase 3: Web UI (Project-first Views)

**Goal**: Deliver basic project/task UX before advanced board automation.

1. Add project pages:
- `apps/web/src/pages/Projects.tsx` (list/create)
- `apps/web/src/pages/Project.tsx` (detail/tasks)

2. Add project/task components:
- Task list with filter/sort
- Task create/edit dialog
- Dependency editor UI
- Manual delegation UI to pick running workspace

3. Extend API client in `apps/web/src/lib/api.ts`.
4. Add route entries and navigation from dashboard.

### Phase 4: Contracts, Telemetry, and Hardening

**Goal**: Ensure operability and measurable outcomes.

1. Add structured task status events for audit/debug visibility.
2. Emit telemetry for success criteria (creation latency, transition latency, delegation latency).
3. Validate pagination/limit behavior under configurable bounds.
4. Confirm error payload consistency (`{ error, message }`).

## Key Files to Modify

| File | Change |
|------|--------|
| `apps/api/src/db/schema.ts` | Add Project/Task tables and indexes |
| `apps/api/src/db/migrations/*.sql` | New migrations for project/task model |
| `apps/api/src/index.ts` | Env additions + route registration |
| `apps/api/src/services/limits.ts` | Parse new project/task limits |
| `apps/api/src/routes/projects.ts` | NEW Project CRUD routes |
| `apps/api/src/routes/tasks.ts` | NEW Task/dependency/delegation routes |
| `apps/api/src/services/task-graph.ts` | NEW cycle + blocked checks |
| `apps/web/src/pages/Projects.tsx` | NEW project list page |
| `apps/web/src/pages/Project.tsx` | NEW project detail/tasks page |
| `apps/web/src/lib/api.ts` | Project/task endpoint client methods |
| `packages/shared/src/types.ts` | Add Project/Task/Dependency API types |
| `packages/shared/src/constants.ts` | Add default configurable limits |

## Testing Strategy

### API Tests (Vitest + Miniflare)

- Project CRUD ownership checks.
- Repository/installation ownership validation at project create/update.
- Task lifecycle transition matrix tests.
- Dependency cycle rejection and blocked-state gating tests.
- Delegation rules (`ready` + unblocked + owned running workspace).
- Callback auth and ownership checks for status updates.
- Limit and pagination behavior with env overrides.

### Web Tests (Vitest + RTL)

- Project list/create flows.
- Task create/edit/filter/sort flows.
- Dependency editor error handling (cycle/self-edge).
- Manual delegation interaction states.

### Optional End-to-End / Smoke

- Create project -> create tasks -> add dependencies -> delegate task -> observe completion metadata.

## Validation Checklist

1. Create a project from a repository tied to the authenticated user's GitHub installation.
2. Confirm duplicate project names are rejected/normalized per user scope.
3. Create tasks and move through valid transitions; invalid transitions return structured errors.
4. Add dependencies and confirm cycles are rejected.
5. Confirm blocked tasks cannot be queued/delegated/in-progress.
6. Manually delegate a ready unblocked task to a running owned workspace.
7. Confirm delegated callback updates via `POST /api/projects/:projectId/tasks/:taskId/status/callback` update task status/output metadata.
8. Confirm task status and output metadata updates are visible in project task detail.
9. Verify all new limits/timeouts are configurable via env vars and reflected in runtime behavior.
