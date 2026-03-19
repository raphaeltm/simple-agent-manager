# Chat-Idea Association: Many-to-Many Linking with MCP Tools

## Problem Statement

Sessions currently have a single `taskId` field — a one-to-one link. SAM needs many-to-many relationships between chat sessions and ideas (tasks) so that:
- A single chat session can be associated with multiple ideas
- A single idea can be discussed across multiple chat sessions
- Agents can associate the current chat with an idea mid-conversation via MCP tools

## Research Findings

### Key Files
- `apps/api/src/durable-objects/project-data.ts` — ProjectData DO with SQLite (sessions live here)
- `apps/api/src/durable-objects/migrations.ts` — Last migration is `011-message-materialization-fts5`; next is `012`
- `apps/api/src/services/project-data.ts` — Service layer wrapping DO RPC calls
- `apps/api/src/routes/mcp.ts` — MCP tool definitions (lines 166-411) and handler dispatch (lines 1880-1905)
- `packages/shared/src/types.ts` — Shared types (ChatSession ~line 254, Task ~line 492)

### Patterns
- **DO methods** are called via typed RPC stubs (`stub.methodName()`), not HTTP fetch
- **Service layer** wraps each DO method with `getStub(env, projectId).methodName(...)`
- **MCP tools** defined in `MCP_TOOLS` array with JSON Schema, dispatched via switch statement
- **MCP token** contains `taskId`, `projectId`, `userId`, `workspaceId` — NOT `sessionId`
- **Session ID derivation**: Use `getChatSessionId(env, workspaceId)` from notification service (queries D1 `workspaces.chat_session_id`)
- **Migrations**: Append to `MIGRATIONS` array in migrations.ts, tracked in `migrations` table
- **Task search** uses D1 directly with Drizzle ORM (tasks in D1, not DO)

### Design Decisions
- Junction table goes in **ProjectData DO SQLite** (same as sessions) for per-project isolation
- MCP tools derive `sessionId` from `workspaceId` via D1 lookup (existing pattern)
- `find_related_ideas` reuses existing D1-based task search pattern
- Keep existing `taskId` on sessions as "primary" task; junction captures all associations
- Use `INSERT OR IGNORE` for idempotent linking (PRIMARY KEY constraint)
- Skip message-level linking for now (session-level is sufficient for MVP)

## Implementation Checklist

- [ ] **1. Add migration 012**: `chat_session_ideas` junction table in DO SQLite
  - Columns: `session_id TEXT NOT NULL`, `task_id TEXT NOT NULL`, `created_at INTEGER`, `context TEXT`
  - Primary key: `(session_id, task_id)`
  - Index: `idx_csi_task` on `task_id`

- [ ] **2. Add DO methods** in `project-data.ts`:
  - `linkSessionIdea(sessionId, taskId, context)` — INSERT OR IGNORE
  - `unlinkSessionIdea(sessionId, taskId)` — DELETE
  - `getIdeasForSession(sessionId)` — SELECT joined with D1 task data
  - `getSessionsForIdea(taskId)` — SELECT sessions linked to a task

- [ ] **3. Add service layer functions** in `services/project-data.ts`:
  - Wrappers for all 4 DO methods above

- [ ] **4. Add MCP tool definitions** in `mcp.ts`:
  - `link_idea` — params: `taskId` (required), `context` (optional)
  - `unlink_idea` — params: `taskId` (required)
  - `list_linked_ideas` — no required params (derives session from workspace)
  - `find_related_ideas` — params: `query` (required), `status` (optional), `limit` (optional)

- [ ] **5. Add MCP tool handlers** in `mcp.ts`:
  - `handleLinkIdea` — derive sessionId from workspaceId, validate task exists in D1, call DO
  - `handleUnlinkIdea` — derive sessionId, call DO
  - `handleListLinkedIdeas` — derive sessionId, call DO, enrich with task data from D1
  - `handleFindRelatedIdeas` — reuse search_tasks D1 pattern

- [ ] **6. Wire handlers** into switch dispatch (lines ~1880-1905)

- [ ] **7. Add shared types** in `packages/shared/src/types.ts`:
  - `SessionIdeaLink` type for MCP responses

- [ ] **8. Add API endpoints** for UI consumption (in chat routes or new route file):
  - `GET /api/projects/:projectId/sessions/:sessionId/ideas` — list linked ideas
  - `GET /api/projects/:projectId/ideas/:taskId/sessions` — list sessions for idea

- [ ] **9. Write tests**:
  - Unit tests for DO methods (link, unlink, list, idempotent behavior)
  - Integration tests for MCP tools
  - Test bidirectional queries
  - Test idempotent linking (same link twice = no error)
  - Test unlinking non-existent link (no error)
  - Test validation (task must exist, session must exist)

- [ ] **10. Update CLAUDE.md** if any new env vars or configurable limits are added

## Acceptance Criteria

- [ ] A single chat session can be linked to multiple ideas (tasks) via MCP tools
- [ ] A single idea can be queried to find all linked sessions
- [ ] `link_idea` MCP tool allows agents to associate the current session with an idea
- [ ] `unlink_idea` MCP tool removes associations
- [ ] `list_linked_ideas` shows all ideas linked to the current session
- [ ] `find_related_ideas` searches existing ideas by keyword
- [ ] Linking is idempotent (duplicate links are silently ignored)
- [ ] Unlinking non-existent links is a no-op (no error)
- [ ] API endpoints exist for UI to query session-idea links bidirectionally
- [ ] Existing `taskId` field on sessions is preserved (backward compatible)
- [ ] All new functionality has test coverage

## References

- Task description from SAM MCP dispatch
- `apps/api/src/durable-objects/project-data.ts`
- `apps/api/src/routes/mcp.ts`
- `apps/api/src/services/project-data.ts`
- `apps/api/src/durable-objects/migrations.ts`
