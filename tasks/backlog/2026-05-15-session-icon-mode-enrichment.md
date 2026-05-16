# Fix Session Icons and Mode Labels in Chat Sidebar

## Problem

Two data flow bugs with the same root cause in the project chat session list:

1. **Icons**: Completed/failed tasks show gray pause icon instead of green checkmark or red X. `getAttentionState()` checks `session.task?.status`, but the list API returns sessions without the `task` embed — so all terminal tasks fall through to `'stopped'`.

2. **Mode labels**: All sessions show "Task" mode icon even when they are conversation-mode sessions. `getSessionMode()` checks `session.task?.taskMode`, hits the same missing data, and the fallback (`if taskId, return 'task'`) is wrong because ALL sessions get a `taskId`.

## Root Cause

The session list API (`GET /api/projects/:id/sessions`) returns `taskId` but no `task` embed (task data lives in D1, sessions in ProjectData DO). The detail API enriches with task data, but the sidebar renders from the list response. The frontend had task status available in `taskInfoMap` (from the separate tasks API) but never merged it into session objects before calling `getAttentionState()` or `getSessionMode()`.

## Research Findings

- `apps/api/src/routes/chat.ts`: List endpoint (line 132) goes to DO without D1 enrichment. Detail endpoint (line 195+) enriches with task data from D1.
- `apps/web/src/lib/chat-session-utils.ts`: `getAttentionState()` and `getSessionMode()` both rely on `session.task?.*` which is missing from list responses.
- `apps/web/src/pages/project-chat/SessionTreeItem.tsx`: Renders list sessions → SessionItem. This is the right place to bridge taskInfoMap data.
- `apps/web/src/pages/project-chat/useTaskGroups.ts`: `TaskInfo` has `status` but was missing `taskMode`. The `Task` type in shared has `taskMode`.
- `apps/web/src/hooks/useCommandPaletteContext.tsx`: Accessed `session.task?.outputPrUrl` on list items — always undefined (dead code).

## Implementation Checklist

- [x] Extract `ChatSessionTaskEmbed` interface from inline type
- [x] Create `ChatSessionListItem` interface (list API shape, no `task`)
- [x] Make `ChatSessionResponse extends ChatSessionListItem` with optional `task`
- [x] Update `ChatSessionListResponse` to use `ChatSessionListItem[]`
- [x] Export new types from `api/index.ts`
- [x] Add `taskMode` to `TaskInfo` interface
- [x] Populate `taskMode` in `buildTaskInfoMap`
- [x] Add enrichment in `SessionTreeItem` — merge `taskInfoMap` status + taskMode onto session
- [x] Update `chat-session-utils.ts` functions to accept `ChatSessionListItem` where appropriate
- [x] Propagate `ChatSessionListItem` to list-data consumers:
  - [x] `sessionTree.ts` (SessionTreeNode.session, buildSessionTree params)
  - [x] `lineageUtils.ts` (all session params)
  - [x] `SessionList.tsx` (sessions/allSessions props)
  - [x] `MobileSessionDrawer.tsx` (sessions prop)
  - [x] `useProjectChatState.ts` (sessions state, recentSessions/staleSessions)
  - [x] `useAllChatSessions.ts` (EnrichedChatSession base type)
  - [x] `useRecentChats.ts` (RecentChat base type)
  - [x] `ChatSessionList.tsx` (sessions prop)
  - [x] `GlobalCommandPalette.tsx` (session type in inline intersection)
  - [x] `useCommandPaletteContext.tsx` (chatSessions type)
  - [x] `IdeasPage.tsx` (sessions state)
- [x] Remove dead `.task` access from command palette (was always undefined)
- [x] Write data flow tests for icon states (completed/failed/cancelled/active)
- [x] Write data flow tests for mode enrichment (task vs conversation)
- [x] Verify tests catch the bug (revert fix → exactly 2 failures)

## Acceptance Criteria

- [x] Completed task sessions show green checkmark icon
- [x] Failed task sessions show red X icon
- [x] In-progress sessions show green spinner
- [x] Conversation-mode sessions show "Chat" label with MessageSquare icon
- [x] Task-mode sessions show "Task" label with ListTodo icon
- [x] needs_input attention marker overrides task status icon
- [x] 16 data flow tests pass covering all states
- [x] No type errors in changed files
- [x] No regressions in existing test suite

## References

- `apps/web/src/lib/api/sessions.ts` — type definitions
- `apps/web/src/lib/chat-session-utils.ts` — state derivation functions
- `apps/web/src/pages/project-chat/SessionItem.tsx` — icon rendering (ATTENTION_ICON_MAP)
- `apps/web/src/pages/project-chat/SessionTreeItem.tsx` — enrichment point
