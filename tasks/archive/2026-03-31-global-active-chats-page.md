# Global Active Chats Page

## Problem Statement

Users currently have no way to see all active chat sessions across projects in one view. They must navigate into each project individually. A global `/chats` page will show all active sessions sorted by most recent activity, enabling quick context-switching.

## Research Findings

### Key Files
- `apps/web/src/pages/ProjectChat.tsx` — `getSessionState()`, `isStaleSession()`, `STALE_SESSION_THRESHOLD_MS` (3 hours), `formatRelativeTime()`, `getLastActivity()`, session state types/colors/labels
- `apps/web/src/components/GlobalCommandPalette.tsx:196-213` — cross-project fan-out pattern: list projects → `listChatSessions()` per project in parallel
- `apps/web/src/components/NavSidebar.tsx:28-33` — `GLOBAL_NAV_ITEMS` array, `MessageSquare` already imported
- `apps/web/src/components/MobileNavDrawer.tsx` — receives navItems prop from `AppShell.tsx:56`
- `apps/web/src/components/AppShell.tsx:56` — maps `GLOBAL_NAV_ITEMS` to mobile nav items
- `apps/web/src/App.tsx:67` — protected route layout area
- `apps/web/src/lib/api.ts:726` — `ChatSessionResponse` type, `listChatSessions()`, `listProjects()`

### Patterns to Follow
- Dashboard uses `PageLayout`, `EmptyState`, `SkeletonCard` from `@simple-agent-manager/ui`
- Session state helpers (getSessionState, isStaleSession, formatRelativeTime, STATE_COLORS, STATE_LABELS) are in ProjectChat.tsx — need to extract to shared location
- GlobalCommandPalette already fetches sessions from all projects — extract to shared hook

### Session State Logic
- `SessionState`: 'active' | 'idle' | 'terminated'
- Stale threshold: 3 hours (`STALE_SESSION_THRESHOLD_MS`)
- `getLastActivity()`: returns `lastMessageAt ?? startedAt`
- State colors: active=success, idle=warning, terminated=fg-muted

## Implementation Checklist

### 1. Extract shared session helpers
- [ ] Create `apps/web/src/lib/session-utils.ts` with `getSessionState()`, `isStaleSession()`, `getLastActivity()`, `formatRelativeTime()`, `SessionState`, `STATE_COLORS`, `STATE_LABELS`, `STALE_SESSION_THRESHOLD_MS`
- [ ] Update `ProjectChat.tsx` to import from `session-utils.ts` instead of defining locally

### 2. Create `useAllChatSessions` hook
- [ ] Create `apps/web/src/hooks/useAllChatSessions.ts`
- [ ] Fan-out pattern: list projects → `listChatSessions()` per project in parallel
- [ ] Return sessions enriched with `projectId` + `projectName`
- [ ] Sort by `lastMessageAt` DESC
- [ ] Expose `loading`, `error`, `sessions`, `refresh()`
- [ ] Refactor `GlobalCommandPalette.tsx` to use `useAllChatSessions` for its chat session data

### 3. Create Chats page
- [ ] Create `apps/web/src/pages/Chats.tsx`
- [ ] Use `PageLayout` from UI library
- [ ] Loading state with `SkeletonCard`
- [ ] Error state with `Alert`
- [ ] Empty state with `EmptyState`
- [ ] Session list: topic (or "Untitled Chat"), project badge, state badge (active/idle/terminated), relative time
- [ ] Filter to non-stale sessions (using `isStaleSession`)
- [ ] Include idle sessions with amber visual distinction
- [ ] Click navigates to `/projects/:projectId/chat/:sessionId`

### 4. Navigation integration
- [ ] Add "Chats" to `GLOBAL_NAV_ITEMS` in `NavSidebar.tsx` (between Home and Projects), `MessageSquare` icon, path `/chats`
- [ ] Verify `MobileNavDrawer` picks it up automatically via `AppShell.tsx` mapping
- [ ] Add "Chats" to navigation items in `GlobalCommandPalette.tsx`
- [ ] Add `/chats` route to `App.tsx`

### 5. Update `isActive` in NavSidebar
- [ ] Ensure `/chats` path highlights correctly in the sidebar (current `isActive` function should handle this)

## Acceptance Criteria

- [ ] `/chats` page shows all non-stale chat sessions across all projects, sorted by `lastMessageAt` DESC
- [ ] Each row shows: topic (or "Untitled Chat"), project name badge, session state badge (active/idle/terminated with correct colors), relative time
- [ ] Clicking a session navigates to `/projects/:projectId/chat/:sessionId`
- [ ] Idle sessions are included with amber badge visual distinction
- [ ] Loading skeleton shows during data fetch
- [ ] Empty state shows when no active sessions exist
- [ ] Error state shows when fetch fails
- [ ] "Chats" appears in desktop sidebar, mobile nav drawer, and command palette
- [ ] No backend changes needed — uses existing APIs only
- [ ] No horizontal overflow on mobile (375px) or desktop (1280px)

## References
- Idea: `01KN1Z2EG7ZFH53M1ESJF6RMJS`
- SAM task: `01KN1Z324XFJ4DQV91T30TSAXV`
