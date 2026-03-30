# Add compound indexes for account-map query performance

## Problem

The account map API route filters nodes and tasks by `(userId, status)` but neither table has a compound index matching this access pattern:

- `nodes` table: only has `idx_nodes_user_id` (single column)
- `tasks` table: existing indexes lead with `projectId`, not `userId`

The workspaces table already has `idx_workspaces_user_status` which is the correct pattern.

## Context

Discovered during cloudflare-specialist review of PR for map active-resources filtering. Not a regression — the pre-existing queries already scanned by userId without a status index. The new `activeOnly` filtering adds `inArray(status, ...)` which would benefit from compound indexes.

## Acceptance Criteria

- [ ] Add `idx_nodes_user_status` compound index on `(userId, status)` to nodes table
- [ ] Add `idx_tasks_user_status` compound index on `(userId, status)` to tasks table
- [ ] Create Drizzle migration for both indexes
- [ ] Verify migration runs cleanly on staging
