# MCP Idea Management Tools

## Problem

Agents currently have no way to **create** ideas via MCP. The `dispatch_task` tool creates executable tasks that get queued for workspace provisioning. When an agent wants to record an idea (a lightweight note for future consideration), it's forced to use `dispatch_task`, which incorrectly triggers the full task execution pipeline.

The existing session-idea linking tools (`link_idea`, `unlink_idea`, `list_linked_ideas`, `find_related_ideas`) let agents associate sessions with existing tasks/ideas, but there's no dedicated tool to **create** an idea without triggering execution.

## Solution

Add dedicated MCP tools for idea CRUD that create tasks with `status: 'draft'` and never trigger execution. Also add an `update_idea` tool for appending content (since ideas accumulate text from multiple conversations).

## Research Findings

### Current Architecture
- Tasks and ideas share the same `tasks` D1 table — ideas are tasks with `status: 'draft'`
- The frontend (`IdeasPage.tsx`, `IdeaDetailPage.tsx`) already maps task statuses to idea statuses (draft → "exploring")
- `dispatch_task` creates tasks in `'queued'` status which triggers the task runner pipeline
- Session-idea linking exists via `chat_session_ideas` junction table in ProjectData DO
- The `find_related_ideas` tool already searches all tasks (not filtered by status)
- `CreateTaskRequest` type exists with `title`, `description`, `priority`, `parentTaskId`, `agentProfileHint`
- REST CRUD routes exist at `apps/api/src/routes/tasks/crud.ts`

### Key Files
- `apps/api/src/routes/mcp.ts` — MCP tool definitions and handlers
- `packages/shared/src/types.ts` — Task/TaskStatus types
- `apps/api/src/db/schema.ts` — Database schema
- `apps/api/src/routes/tasks/crud.ts` — REST task CRUD (for reference pattern)

### Design Decisions
- Ideas = tasks with `status: 'draft'` (no new status needed — frontend already handles this)
- New tools wrap existing D1 queries with `status = 'draft'` filter
- `create_idea` inserts into `tasks` table with `status: 'draft'`, no task runner trigger
- `update_idea` allows appending/replacing description content
- `get_idea` is like `get_task_details` but scoped to draft tasks
- `list_ideas` is like `list_tasks` but filtered to `status: 'draft'`
- `search_ideas` is like `search_tasks` but filtered to `status: 'draft'`
- No new database schema changes needed

## Implementation Checklist

- [ ] 1. Add 5 new MCP tool definitions to `MCP_TOOLS` array in `mcp.ts`:
  - `create_idea` — title (required), content (optional, large text), priority
  - `update_idea` — ideaId (required), title (optional), content (optional), append (boolean, default true)
  - `get_idea` — ideaId (required)
  - `list_ideas` — limit, include_linked (show which are linked to current session)
  - `search_ideas` — query (required), limit
- [ ] 2. Implement `handleCreateIdea` handler — INSERT into tasks with status='draft', createdBy from token
- [ ] 3. Implement `handleUpdateIdea` handler — UPDATE task description (append or replace), verify status='draft'
- [ ] 4. Implement `handleGetIdea` handler — SELECT from tasks where status='draft' and project_id matches
- [ ] 5. Implement `handleListIdeas` handler — SELECT from tasks where status='draft', ordered by updated_at desc
- [ ] 6. Implement `handleSearchIdeas` handler — LIKE search on title/description with status='draft' filter
- [ ] 7. Wire all 5 handlers into the tools/call switch statement
- [ ] 8. Add configurable limits: `MCP_IDEA_CONTENT_MAX_LENGTH` (default 64KB), `MCP_IDEA_LIST_LIMIT`/`MAX`
- [ ] 9. Update the file header comment to document the new idea management tools
- [ ] 10. Add unit tests for all 5 new handlers
- [ ] 11. Update `find_related_ideas` to default to `status: 'draft'` when no status filter is provided (so it returns ideas, not all tasks)

## Acceptance Criteria

- [ ] Agent can call `create_idea` to create a draft task without triggering execution
- [ ] Agent can call `update_idea` to append content to an existing idea's description
- [ ] Agent can call `get_idea` to retrieve full idea details
- [ ] Agent can call `list_ideas` to see all draft ideas in the project
- [ ] Agent can call `search_ideas` to find ideas by keyword
- [ ] All new tools respect project scoping (project_id from token)
- [ ] `create_idea` returns the idea ID so it can be linked via `link_idea`
- [ ] `update_idea` with `append: true` concatenates new content to existing description
- [ ] Ideas support large text content (up to 64KB configurable)
- [ ] All limits are configurable via env vars (constitution Principle XI)
- [ ] Existing `find_related_ideas` defaults to draft status for idea-focused results
