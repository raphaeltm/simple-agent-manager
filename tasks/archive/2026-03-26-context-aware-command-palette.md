# Context-Aware Command Palette

**Created**: 2026-03-26
**Idea**: 01KMGRGQB6A9895SWS5XBR0DCX
**SAM Task**: 01KMMNAAHNQ4Q6AZN7QH5KQSJ7

## Problem Statement

The global command palette (Cmd+K) shows the same flat list of results regardless of where the user is in the app. When inside a project, the palette should surface project-scoped actions (navigate to chat/ideas/activity/settings, project's own chats/ideas) and session/task-scoped actions (go to workspace, view PR, complete task) based on the current URL context.

## Research Findings

### Key Files
- `apps/web/src/components/GlobalCommandPalette.tsx` — 647-line palette component with 5 categories: Navigation, Projects, Chats, Quick Actions, Nodes, Actions
- `apps/web/src/hooks/useGlobalCommandPalette.ts` — keyboard trigger hook (Cmd+K / Ctrl+K)
- `apps/web/src/lib/fuzzy-match.ts` — VS Code-style fuzzy matching
- `apps/web/src/components/NavSidebar.tsx` — has `extractProjectId()` and `PROJECT_NAV_ITEMS` (Chat, Ideas, Activity, Settings)

### URL Patterns
- `/projects/:id` — project root (redirects to chat)
- `/projects/:id/chat` — project chat (new chat)
- `/projects/:id/chat/:sessionId` — specific chat session
- `/projects/:id/ideas` — ideas list
- `/projects/:id/ideas/:taskId` — idea detail
- `/projects/:id/tasks/:taskId` — task detail
- `/projects/:id/activity` — activity feed
- `/projects/:id/settings` — project settings

### Available Data
- `ChatSessionResponse` has: `workspaceUrl`, `taskId`, `topic`, `status`, `task` (with `outputPrUrl`, `outputBranch`, `outputSummary`)
- `extractProjectId(pathname)` already exists in NavSidebar
- Projects and chat sessions are already fetched in the palette on mount
- `listProjectTasks()` API exists for fetching project ideas/tasks

### Existing Patterns
- Configurable limits via `VITE_CMD_PALETTE_*` env vars
- Fuzzy matching via `fuzzyMatch()`
- Category groups with `CategoryGroup` type
- `flatResults` for keyboard navigation

### Implementation Approach
Option A (additive): Add a new "Context" category that appears first when inside a project/session/task context. No breaking changes to existing behavior.

## Implementation Checklist

- [ ] **1. Extract context from URL**: Create a `useCommandPaletteContext` hook that extracts `projectId`, `sessionId`, and `taskId` from `useLocation()` using the existing `extractProjectId()` pattern
- [ ] **2. Add context result type**: Add a `ContextResult` type (or reuse existing types) for context-aware actions with appropriate icons
- [ ] **3. Project-scoped context actions**: When inside `/projects/:id/*`, add a "Context" group at the top with:
  - Navigate to Chat, Ideas, Activity, Settings (reuse `PROJECT_NAV_ITEMS`)
  - "New Chat" action for current project
- [ ] **4. Session-scoped context actions**: When inside `/projects/:id/chat/:sessionId`, add:
  - "Go to Workspace" (if session has `workspaceUrl`)
  - "View Task" (if session has `taskId`)
  - "Open PR" (if session's task has `outputPrUrl`)
- [ ] **5. Task/Idea-scoped context actions**: When inside `/projects/:id/ideas/:taskId` or `/projects/:id/tasks/:taskId`, add:
  - "Go to Chat" (if task has a linked session — use `getTaskSessions()` or match from fetched sessions)
  - "Open PR" (if task has `outputPrUrl` — need to fetch task detail or match from context)
- [ ] **6. Prioritize current project's items**: When inside a project, show that project's chats/ideas first in their respective categories, demoting (not hiding) other projects' items
- [ ] **7. Add configurable context result limit**: Add `VITE_CMD_PALETTE_MAX_CONTEXT_RESULTS` env var (default: 5)
- [ ] **8. Write unit tests**: Test context detection from various URL patterns, test that context actions appear/disappear correctly, test keyboard navigation still works with context section
- [ ] **9. Write behavioral tests**: Render palette with mocked data in different URL contexts and verify correct context actions appear
- [ ] **10. Update documentation**: Update CLAUDE.md recent changes if needed

## Acceptance Criteria

- [ ] Command palette detects current project/session/task from URL
- [ ] When in a project, project-scoped actions appear in a "Context" section at top
- [ ] When in a chat session with a workspace, "Go to Workspace" action is available
- [ ] When in a chat session with a task, "View Task" action is available
- [ ] When in a task/idea view, "Go to Chat" and "Open PR" actions are available (when data exists)
- [ ] Project's own chats are prioritized over other projects' items
- [ ] All existing global functionality continues to work unchanged
- [ ] Keyboard navigation works correctly with new context section
- [ ] Configurable result limits via env vars (existing pattern)

## References

- Idea: 01KMGRGQB6A9895SWS5XBR0DCX
- `apps/web/src/components/NavSidebar.tsx` — `extractProjectId()`, `PROJECT_NAV_ITEMS`
- `apps/web/src/components/GlobalCommandPalette.tsx` — current implementation
- `.claude/rules/06-technical-patterns.md` — React interaction-effect analysis
