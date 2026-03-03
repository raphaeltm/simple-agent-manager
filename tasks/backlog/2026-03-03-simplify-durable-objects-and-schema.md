# Simplify Durable Objects and Database Schema

**Status:** backlog
**Priority:** medium
**Estimated Effort:** 4 days
**Created:** 2026-03-03

## Problem Statement

The database schema and Durable Objects layer has accumulated design debt that makes debugging and maintenance difficult:

- **Timestamp inconsistency**: Three different timestamp formats used across the schema — integer milliseconds (BetterAuth tables), text ISO 8601 (most tables), and mixed (observability). This causes type errors and confusing query patterns.
- **ProjectData DO is 1,041 lines** with a 186-line `alarm()` method managing idle cleanup, WebSocket broadcasts, and D1 sync — too many concerns
- **TaskRunner DO is 1,281 lines** with a complex alarm-driven state machine — alarm() handles all step transitions in a single 76-line function
- **Schema drift**: `task_status_events` exists in both D1 and ProjectData DO SQLite with no documented authority
- **Credentials table overloading**: Single table conflates cloud-provider and agent API key credentials using nullable discriminator columns
- **Missing indexes**: No `(userId, status)` index on nodes, no `parentTaskId` index on tasks, no `status` index on agentSessions — affects sweep performance
- **UI Governance tables**: 8 tables (32% of schema) with no apparent active usage
- **No soft-delete**: Cascade deletes permanently destroy data with no audit trail
- **D1 response mappers duplicated**: `toTaskResponse()`, `toWorkspaceResponse()` repeated across every route file

## Acceptance Criteria

- [ ] Audit and document timestamp strategy — choose one format and document migration plan
- [ ] Add missing strategic indexes:
  - `(userId, status)` compound on nodes table
  - `status` on nodes table (for cron sweeps)
  - `parentTaskId` on tasks table
  - `workspaceId` on tasks table
  - `status` on agentSessions table
- [ ] Document data residency split clearly — which data lives in D1 vs. DOs and why
  - Add "Data Residency" section to CLAUDE.md
  - Document sync strategy (DO → D1) and recovery paths
- [ ] Break down `ProjectData DO` alarm() method:
  - Extract idle session cleanup logic
  - Extract D1 sync logic
  - Extract WebSocket broadcast logic
  - Each should be a separate private method called from alarm()
- [ ] Add state machine diagrams (Mermaid) for:
  - Task execution steps (node_selection → ... → running)
  - Task status transitions (draft → ready → queued → ... → completed/failed)
  - Workspace lifecycle (pending → creating → running → stopping → stopped)
  - Node lifecycle (active → warm → destroying)
- [ ] Investigate UI Governance tables — determine if actively used, remove if orphaned
- [ ] Create centralized `services/mappers.ts` for schema-to-DTO conversions
- [ ] Add JSDoc to all state machine types in `packages/shared/src/types.ts`

## Key Files

- `apps/api/src/db/schema.ts` — 19 tables, timestamp inconsistency
- `apps/api/src/db/observability-schema.ts` — separate observability DB
- `apps/api/src/durable-objects/project-data.ts` (1,041 lines)
- `apps/api/src/durable-objects/task-runner.ts` (1,281 lines)
- `apps/api/src/durable-objects/node-lifecycle.ts` (236 lines)
- `apps/api/src/durable-objects/migrations.ts` (191 lines — DO schema)
- `apps/api/src/services/project-data.ts` (255 lines — DO client wrapper)
- `packages/shared/src/types.ts` — state machine types

## Approach

1. Start with documentation — state machine diagrams and data residency docs
2. Add indexes next — DDL-only, no code changes needed
3. Extract alarm() methods — reduce DO complexity
4. Audit UI Governance tables — remove if unused
5. Centralize mappers — reduces cross-cutting duplication
