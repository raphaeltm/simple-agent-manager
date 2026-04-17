# Recent Chats Dropdown (Mobile + Desktop)

## Problem

Switching between active conversations across different projects requires too many taps on mobile: hamburger → project → chat → session (3-4 taps). Users need a quick way to jump between recently active chats from anywhere in the app.

## Solution

Add a message bubble icon to the mobile nav bar (between search and notifications) that opens a dropdown showing recently active chat sessions across all projects. Tapping a session navigates directly to it (2 taps total). Also available on desktop in the sidebar header.

## Research Findings

### Key Files
- `apps/web/src/components/AppShell.tsx` — mobile header (lines 131-151), desktop sidebar
- `apps/web/src/components/NotificationCenter.tsx` — reference dropdown pattern (portal, positioning, click-outside, escape)
- `apps/web/src/hooks/useAllChatSessions.ts` — existing hook that fan-out fetches sessions across all projects
- `apps/web/src/pages/Chats.tsx` — reference for session item rendering
- `apps/web/src/lib/chat-session-utils.ts` — session state helpers (getSessionState, isStaleSession, formatRelativeTime, STATE_COLORS)
- `packages/ui/src/components/DropdownMenu.tsx` — existing dropdown component (not suitable here — needs custom rich items)

### Patterns to Follow
- **Portal pattern**: NotificationCenter uses `createPortal(el, document.body)` for the dropdown panel
- **Positioning**: `buttonRef.getBoundingClientRect()` for panel placement, mobile full-width (`inset-x-4`), desktop fixed-width
- **Close behavior**: click-outside + Escape key handlers
- **Icon style**: 18px Lucide icons, w-9 h-9 buttons, `bg-transparent border-none text-fg-muted cursor-pointer`
- **Badge count**: Same pattern as notification bell badge (accent bg, 10px font)

### Polling Strategy
- Use `document.visibilityState` to pause polling when tab is hidden
- Poll every 30s when tab is visible and dropdown is open
- Fetch once on dropdown open, then poll
- Reuse `useAllChatSessions` pattern but with configurable auto-refresh

### Session Display
- Filter: non-stale + active (status !== 'stopped')
- Sort by lastActivity DESC
- Limit to 8 items in dropdown
- Show: state dot, topic (truncated), project name, relative time
- Navigate to `/projects/:projectId/chat/:sessionId` on click

## Implementation Checklist

- [ ] Create `useRecentChats` hook — wraps `useAllChatSessions` logic with polling and visibility awareness
- [ ] Create `RecentChatsDropdown` component — portal-based dropdown following NotificationCenter pattern
- [ ] Add message bubble icon to mobile header in AppShell.tsx (between search and notifications)
- [ ] Add message bubble icon to desktop sidebar header in AppShell.tsx (between logo and notifications)
- [ ] Handle edge cases: empty state, loading state, error state
- [ ] Write Playwright visual audit tests with mock data (mobile + desktop, normal/long-text/empty/many-items)
- [ ] Run lint, typecheck, test, build

## Acceptance Criteria

- [ ] Message bubble icon visible in mobile nav bar between search and notifications
- [ ] Tapping the icon opens a dropdown showing recent active chats across all projects
- [ ] Each chat item shows: state indicator, topic, project name, relative time
- [ ] Tapping a chat item navigates to that chat session
- [ ] Dropdown refreshes automatically while open (30s interval, visibility-aware)
- [ ] Active chat count badge shown on icon when there are active sessions
- [ ] Empty state shown when no active chats exist
- [ ] Dropdown closes on click-outside, Escape, and navigation
- [ ] Works on both mobile (375px) and desktop (1280px) viewports
- [ ] No horizontal overflow on mobile
- [ ] Accessible: proper ARIA roles, keyboard navigation
