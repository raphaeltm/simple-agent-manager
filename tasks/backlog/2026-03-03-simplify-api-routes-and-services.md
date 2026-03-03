# Simplify API Routes and Services

**Status:** backlog
**Priority:** high
**Estimated Effort:** 1 week
**Created:** 2026-03-03

## Problem Statement

The API layer (`apps/api/src/`) has grown organically and now contains several files that are too large, mix concerns, and duplicate logic. This makes debugging difficult and increases the risk of introducing bugs during changes.

Key pain points:
- `routes/workspaces.ts` is 1,625 lines — handles workspace CRUD, agent sessions, bootstrap tokens, boot logs, and provisioning callbacks
- `routes/tasks.ts` is 1,036 lines — mixes task CRUD, status transitions, dependency graph, and event recording
- Three route files mount at the same path (`/api/projects/:projectId/tasks`) creating hidden routing behavior
- `services/node-agent.ts` exports 18 functions mixing workspace commands, session commands, and system queries
- `services/observability.ts` is 641 lines mixing error persistence, querying, and Cloudflare API proxying
- Validation helpers like `parsePositiveInt()` are duplicated across 3+ route files
- Response mappers (`toTaskResponse`, `toWorkspaceResponse`) duplicated across every route file
- Auth middleware patterns are inconsistent (blanket auth vs. conditional skip lists vs. per-route exceptions)

## Acceptance Criteria

- [ ] Split `routes/workspaces.ts` into focused sub-routers:
  - `workspaces-crud.ts` — create, read, update, delete
  - `workspaces-lifecycle.ts` — stop, restart, rebuild
  - `agent-sessions.ts` — session management endpoints
  - `workspace-provisioning.ts` — ready/failed callbacks, bootstrap tokens
- [ ] Split `routes/tasks.ts` and merge the three task route files (`tasks.ts`, `task-runs.ts`, `task-submit.ts`) into a coherent structure — eliminate triple-mount at same path
- [ ] Extract shared validation helpers to `services/validation.ts` — consolidate all `parsePositiveInt`, normalization, and parsing functions
- [ ] Create `lib/mappers.ts` for schema-to-DTO converters — centralize `toTaskResponse`, `toWorkspaceResponse`, `toProjectResponse`, etc.
- [ ] Refactor `services/node-agent.ts` into focused client classes:
  - `NodeAgentWorkspaceClient` — create, stop, restart, delete, rebuild
  - `NodeAgentSessionClient` — create, start, stop, suspend, resume, list
  - `NodeAgentSystemClient` — info, logs, events
- [ ] Split `services/observability.ts` into: error persistence, error querying, and CF API proxy
- [ ] Centralize auth middleware pattern — use route metadata or a single auth registry instead of scattered skip lists
- [ ] All existing tests pass after refactoring
- [ ] No new functionality added — pure structural refactor

## Key Files

- `apps/api/src/routes/workspaces.ts` (1,625 lines)
- `apps/api/src/routes/tasks.ts` (1,036 lines)
- `apps/api/src/routes/task-runs.ts` (312 lines)
- `apps/api/src/routes/task-submit.ts` (297 lines)
- `apps/api/src/routes/projects.ts` (808 lines)
- `apps/api/src/routes/nodes.ts` (681 lines)
- `apps/api/src/services/node-agent.ts` (415 lines, 18 exports)
- `apps/api/src/services/observability.ts` (641 lines, 16 exports)
- `apps/api/src/index.ts` (route mounting — lines 430-434 triple-mount)
- `apps/api/src/middleware/` (auth patterns)

## Approach

1. Start with validation and mapper extraction — low risk, high deduplication value
2. Split route files next — maintains all endpoints, just reorganizes
3. Refactor services last — requires updating route imports
4. Run `pnpm typecheck && pnpm lint && pnpm test` after each major extraction
