# Fix: Project Delete Button Not Working

## Problem

User clicks "Delete Project" on the project settings page, completes the confirmation flow, but the project still appears in the dashboard. The delete operation appears to succeed (no error toast visible) but the project persists in D1.

## Root Cause Analysis

The delete endpoint at `apps/api/src/routes/projects/crud.ts:653-665` relies entirely on D1's `ON DELETE CASCADE` foreign key behavior to clean up child records before deleting the project. Two issues:

1. **CASCADE may fail silently**: D1 (SQLite) foreign key cascades can fail when there are complex FK chains (projects → tasks → task_dependencies/task_status_events). If CASCADE fails, D1 returns a constraint violation error. The `app.onError()` handler returns a 500, but the user may not notice the error toast.

2. **ALTER TABLE FK not enforced**: `workspaces.project_id` was added via `ALTER TABLE ADD COLUMN` (migration 0012). SQLite ignores `REFERENCES` constraints in ALTER TABLE — so `ON DELETE SET NULL` never fires. Orphaned workspaces keep stale `project_id` values.

3. **No delete verification**: The endpoint returns `{ success: true }` without verifying the row was actually deleted.

## Key Files

| Layer | File | Lines |
|-------|------|-------|
| Frontend handler | `apps/web/src/pages/ProjectSettings.tsx` | 137-148 |
| API client | `apps/web/src/lib/api.ts` | 281-285 |
| Backend delete | `apps/api/src/routes/projects/crud.ts` | 653-665 |
| Schema | `apps/api/src/db/schema.ts` | 174-226 |
| Project auth | `apps/api/src/middleware/project-auth.ts` | 8-25 |
| Workspace migration | `apps/api/src/services/workspace-migration.ts` | full file |

## FK References to `projects.id`

| Table | Column | Action | Via |
|-------|--------|--------|-----|
| `project_runtime_env_vars` | `project_id` | CASCADE | CREATE TABLE |
| `project_runtime_files` | `project_id` | CASCADE | CREATE TABLE |
| `tasks` | `project_id` | CASCADE | CREATE TABLE |
| `workspaces` | `project_id` | SET NULL | ALTER TABLE (NOT enforced) |
| `agent_profiles` | `project_id` | CASCADE | CREATE TABLE |

## Implementation Checklist

- [ ] Explicitly delete child records before deleting the project (don't rely on CASCADE):
  - [ ] Delete `task_status_events` for all project tasks
  - [ ] Delete `task_dependencies` for all project tasks
  - [ ] Delete `tasks` where `project_id` matches
  - [ ] Delete `project_runtime_env_vars` where `project_id` matches
  - [ ] Delete `project_runtime_files` where `project_id` matches
  - [ ] Delete `agent_profiles` where `project_id` matches
  - [ ] Set `workspaces.project_id = NULL` where `project_id` matches
- [ ] Delete the project row itself
- [ ] Verify deletion succeeded (query for the project after delete)
- [ ] Return proper error if verification fails
- [ ] Add integration test for project deletion with child records
- [ ] Add regression test that creates a project with tasks and runtime config, deletes it, and verifies all records are removed

## Acceptance Criteria

- [ ] Clicking "Delete Project" and confirming actually removes the project from D1
- [ ] Project no longer appears in the dashboard after deletion
- [ ] Child records (tasks, runtime config, agent profiles) are cleaned up
- [ ] Workspace `project_id` is set to NULL for associated workspaces
- [ ] Integration test proves the fix works with child records present
- [ ] Error is returned and displayed if deletion fails

## References

- SQLite ALTER TABLE FK limitation: https://www.sqlite.org/lang_altertable.html
- D1 foreign key docs: https://developers.cloudflare.com/d1/
