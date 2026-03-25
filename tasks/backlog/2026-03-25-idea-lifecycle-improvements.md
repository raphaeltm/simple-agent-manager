# Idea Lifecycle Improvements

## Problem

Ideas (draft tasks) lack lifecycle management:
1. No way for agents to transition idea status via MCP (update_idea only works on draft)
2. No "Execute" button to start working on an idea from the detail page
3. No auto-linking of ideas to the sessions that execute them
4. No execution status visibility on the idea detail page

## Research Findings

### Current State
- `update_idea` MCP tool (idea-tools.ts:281-367): Only operates on `status = 'draft'` ideas. No `status` param exposed.
- `get_idea` MCP tool (idea-tools.ts:369-411): Also restricted to `status = 'draft'` — should be relaxed.
- `update_idea` tool definition (tool-definitions.ts:351-381): No `status` property in schema.
- IdeaDetailPage (IdeaDetailPage.tsx): Has status pill + conversations panel but no Execute button.
- ProjectChat.tsx:handleSubmit (line 364-400): Calls `submitTask()`, gets back `{ taskId, sessionId }`, navigates to chat session.
- Session-idea linking REST API exists: POST `/api/projects/:projectId/sessions/:sessionId/ideas` (chat.ts:449-480).
- No web API client function for linking ideas to sessions yet.
- Status mapping in IdeaDetailPage: draft→exploring, ready→ready, queued/delegated/in_progress→executing, completed→done, failed/cancelled→parked.

### Key Patterns
- Ideas are stored as tasks with `status = 'draft'` in D1 `tasks` table.
- Status transitions go through task-status.ts service.
- Session-idea linking uses ProjectData DO via `chat_session_ideas` junction table.
- Web app uses `react-router-dom` navigation with query params for state passing.

## Implementation Checklist

- [ ] 1. Add `status` param to `update_idea` MCP tool definition (tool-definitions.ts)
- [ ] 2. Add status transition validation in `handleUpdateIdea` (idea-tools.ts) — allow draft→ready, draft→cancelled, ready→draft, ready→completed, ready→cancelled, completed/cancelled as terminal (no transitions out)
- [ ] 3. Remove draft-only restriction from `handleUpdateIdea` (allow updating ideas in non-terminal statuses)
- [ ] 4. Relax `get_idea` to work on any status (not just draft)
- [ ] 5. Add `linkSessionIdea` API client function in web app (api.ts)
- [ ] 6. Add "Execute" button to IdeaDetailPage header
- [ ] 7. Wire Execute button to navigate to `/projects/:id/chat?executeIdea=<ideaId>` with pre-filled message
- [ ] 8. In ProjectChat.tsx, read `executeIdea` query param and pre-fill message input
- [ ] 9. After task submit in handleSubmit, if executeIdea context is present, call link API
- [ ] 10. Show linked sessions / execution status on IdeaDetailPage (already has ConversationsPanel — enhance with status)
- [ ] 11. Unit tests for status transition validation in MCP tool
- [ ] 12. Unit test for execute flow navigation (IdeaDetailPage)
- [ ] 13. Unit test for auto-linking on submit (ProjectChat)

## Acceptance Criteria

- [ ] Agents can transition idea status via `update_idea` MCP tool (draft→ready→completed/cancelled)
- [ ] "Execute" button on idea detail page navigates to chat with pre-filled message
- [ ] User can edit the pre-filled message before sending
- [ ] Submitting a task from the execute flow auto-links the idea to the new session
- [ ] Idea detail page shows linked sessions with execution status
- [ ] All status transitions are validated (no invalid transitions allowed)
- [ ] get_idea works for ideas in any status (not just draft)

## References

- apps/api/src/routes/mcp/idea-tools.ts
- apps/api/src/routes/mcp/tool-definitions.ts
- apps/web/src/pages/IdeaDetailPage.tsx
- apps/web/src/pages/ProjectChat.tsx
- apps/web/src/lib/api.ts
- apps/api/src/routes/chat.ts (session-idea linking endpoints)
