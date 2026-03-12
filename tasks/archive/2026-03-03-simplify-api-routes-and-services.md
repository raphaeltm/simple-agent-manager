# Simplify API Routes and Services

**Status:** backlog
**Priority:** high
**Created:** 2026-03-03
**Updated:** 2026-03-12

## Problem Statement

The API layer (`apps/api/src/`) has grown organically with several route files that are too large and mix concerns. This makes debugging difficult and increases the risk of introducing bugs.

Key pain points:
- `routes/workspaces.ts` is 1,813 lines — handles workspace CRUD, agent sessions, bootstrap tokens, boot logs, provisioning callbacks, runtime assets, and messages
- `routes/projects.ts` is 1,118 lines — mixes project CRUD/runtime-config with ACP session lifecycle (270+ lines of ACP endpoints)
- `routes/tasks.ts` (1,037 lines), `task-runs.ts` (315 lines), `task-submit.ts` (302 lines) — three files all mounted at `/api/projects/:projectId/tasks` creating hidden triple-mount behavior
- `parsePositiveInt()` is duplicated across `projects.ts` and `tasks.ts`
- Response mappers (`toTaskResponse`, `toWorkspaceResponse`, `toProjectResponse`) are defined inline in each route file
- Auth middleware is inconsistent (blanket auth vs. conditional skip lists)

## Approach

Pure structural refactoring — no new functionality, no behavior changes. All existing tests must pass. Focus on the three largest route files.

## Implementation Checklist

### Phase 1: Extract shared utilities
- [ ] Create `lib/route-helpers.ts` with `parsePositiveInt`, `requireRouteParam`, and other shared route utilities
- [ ] Create `lib/mappers.ts` with `toWorkspaceResponse`, `toProjectResponse`, `toProjectSummaryResponse`, `toTaskResponse`, `toDependencyResponse`, `toAgentSessionResponse`
- [ ] Update all route files to import from the new shared modules
- [ ] Verify: `pnpm typecheck && pnpm lint && pnpm test`

### Phase 2: Split workspaces.ts (1,813 → ~4 files)
- [ ] `routes/workspaces/index.ts` — re-exports the combined router
- [ ] `routes/workspaces/crud.ts` — workspace CRUD (create, list, get, update, delete)
- [ ] `routes/workspaces/lifecycle.ts` — stop, restart, rebuild, provisioning callbacks (ready/failed)
- [ ] `routes/workspaces/agent-sessions.ts` — agent session CRUD and lifecycle
- [ ] `routes/workspaces/runtime.ts` — bootstrap tokens, boot logs, runtime assets, agent keys, messages, credential sync
- [ ] Update `index.ts` route mounting to use the new combined router
- [ ] Verify: `pnpm typecheck && pnpm lint && pnpm test`

### Phase 3: Split projects.ts (1,118 → 2 files)
- [ ] `routes/projects/index.ts` — re-exports the combined router
- [ ] `routes/projects/crud.ts` — project CRUD, runtime config (env vars, files)
- [ ] `routes/projects/acp-sessions.ts` — all ACP session endpoints (lines 850–1118)
- [ ] Update `index.ts` route mounting
- [ ] Verify: `pnpm typecheck && pnpm lint && pnpm test`

### Phase 4: Consolidate task routes (3 files → 1 directory)
- [ ] `routes/tasks/index.ts` — re-exports the combined router
- [ ] `routes/tasks/crud.ts` — task CRUD, status transitions, dependencies, delegation, events
- [ ] `routes/tasks/run.ts` — autonomous task execution (from `task-runs.ts`)
- [ ] `routes/tasks/submit.ts` — chat-first task submission (from `task-submit.ts`)
- [ ] Eliminate the triple-mount in `index.ts` — single `app.route('/api/projects/:projectId/tasks', tasksRoutes)`
- [ ] Verify: `pnpm typecheck && pnpm lint && pnpm test`

### Phase 5: Final validation
- [ ] Full quality suite: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- [ ] No new functionality added — pure structural refactor
- [ ] All existing tests pass

## Acceptance Criteria

- [ ] No route file exceeds 500 lines
- [ ] No duplicated utility functions across route files
- [ ] Triple-mount eliminated — single mount point for task routes
- [ ] All existing tests pass unchanged (tests prove behavior is preserved)
- [ ] Response mappers centralized in `lib/mappers.ts`

## Key Files

- `apps/api/src/routes/workspaces.ts` (1,813 lines) → `routes/workspaces/` directory
- `apps/api/src/routes/projects.ts` (1,118 lines) → `routes/projects/` directory
- `apps/api/src/routes/tasks.ts` (1,037 lines) → `routes/tasks/` directory
- `apps/api/src/routes/task-runs.ts` (315 lines) → merged into `routes/tasks/`
- `apps/api/src/routes/task-submit.ts` (302 lines) → merged into `routes/tasks/`
- `apps/api/src/index.ts` — route mounting (lines 463–468 triple-mount)
