# Idea Detail Page: Display Linked Conversations

## Problem

When clicking an idea card on the Ideas page, users are taken to the TaskDetail page — a task management view with status transitions, dependencies, delegation, etc. This contradicts the product vision: everything in SAM is conversation-centric. The idea detail page should show the **conversations** linked to that idea, not task management controls.

## Research Findings

### Backend Infrastructure (Already Exists)
- `GET /api/projects/:projectId/tasks/:taskId/sessions` — returns linked sessions with `{ sessionId, topic, status, context, linkedAt }`
- `chat_session_ideas` junction table (migration 012) — many-to-many session↔idea
- MCP tools (`link_idea`, `unlink_idea`, `list_linked_ideas`, `find_related_ideas`) for agents
- `ProjectData DO` methods: `getSessionsForIdea()`, `linkSessionIdea()`, etc.

### Frontend (Needs Changes)
- `IdeasPage.tsx` — timeline list, `handleIdeaClick` navigates to `/projects/:id/ideas/:taskId`
- `App.tsx` routing: `/ideas/:taskId` currently maps to `TaskDetail` component
- `TaskDetail.tsx` — full task management page (status transitions, deps, delegation, audio)
- **No frontend API client** for `GET /tasks/:taskId/sessions` — needs to be added
- Session count on ideas list uses `session.taskId` direct lookup, not the junction table

### Design Direction (From Planning Conversation)
- Read-only page showing idea title, status, creation date
- List of linked chat sessions, each clickable to navigate to the conversation
- Minimal metadata — no task management controls (no status transitions, deps, delegation)
- Empty state: "No conversations linked yet. Start chatting to discuss this idea."

## Implementation Checklist

- [ ] Add `getTaskSessions()` API client function in `apps/web/src/lib/api.ts`
- [ ] Create `IdeaDetailPage.tsx` component in `apps/web/src/pages/`
  - Fetch idea details via `getProjectTask()`
  - Fetch linked sessions via new `getTaskSessions()`
  - Display idea title, status badge, creation date
  - List linked conversations with topic, status, context, linked date
  - Each session row clickable → navigates to `/projects/:id/chat/:sessionId`
  - Back button → navigates to ideas list
  - Empty state for no linked sessions
  - Loading and error states
  - Mobile-responsive layout
- [ ] Update routing in `App.tsx`: change `/ideas/:taskId` from `TaskDetail` to `IdeaDetailPage`
- [ ] Add unit tests for IdeaDetailPage
- [ ] Verify the TaskDetail page is still accessible via `/tasks/:taskId` route (for direct task management needs)

## Acceptance Criteria

- [ ] Clicking an idea card navigates to the idea detail page (not TaskDetail)
- [ ] Idea detail page shows idea title, status, and creation date
- [ ] Linked conversations are listed with topic, status, and when they were linked
- [ ] Clicking a conversation row navigates to that chat session
- [ ] Empty state is shown when no conversations are linked
- [ ] Back navigation returns to the ideas list
- [ ] Mobile layout works correctly
- [ ] TaskDetail still accessible via `/tasks/:taskId` route
