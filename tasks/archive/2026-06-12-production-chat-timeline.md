# Production Chat Timeline Integration

## Problem Statement

The V2 chat timeline prototype proved out a vertical stem + colored dot timeline pattern that works well in the SAM glass UI. The reusable `Timeline`, `TimelineItem`, `TimelineSeparator` components are already extracted to `packages/ui`. Now we need to integrate a real timeline drawer into the production project chat, powered by real activity events and messages.

## Research Findings

### Data Sources
- **Activity events**: `listActivityEvents()` in ProjectData DO (`apps/api/src/durable-objects/project-data/activity.ts:35-65`) — already supports `eventType`, `limit`, `before` pagination, but NOT `sessionId` filtering
- **Web client**: `listActivityEvents()` in `apps/web/src/lib/api/sessions.ts:312-324` — passes `eventType`, `before`, `limit` but NOT `sessionId`
- **API route**: `GET /api/projects/:projectId/activity` in `apps/api/src/routes/activity.ts:32-60` — accepts `eventType`, `before`, `limit` query params
- **Service layer**: `listActivityEvents()` in `apps/api/src/services/project-data.ts:408-417` — RPC wrapper to DO

### Drawer Pattern (ChatFilePanel)
- Uses `createPortal(…, document.body)`
- Glass classes: `glass-panel-container glass-composited glass-modal`
- Z-index: `z-50` for panel, `z-40` for backdrop (desktop only)
- Responsive: `inset-0` on mobile, `md:inset-y-0 md:right-0 md:w-[min(560px,50vw)]` on desktop
- Green edge glow via `before:` pseudo-element
- Escape key closes panel
- State managed via `lc.filePanel` / `lc.setFilePanel()` in useSessionLifecycle

### SessionHeader Action Buttons
- Located at lines 573-614 of SessionHeader.tsx
- Files/Git/Workspace gated on `session.workspaceId && sessionState === 'active'`
- Complete button gated on `canMarkComplete`
- Timeline button should NOT be gated on active workspace — useful for completed sessions

### ProjectMessageView Integration
- 445 lines total (safe to add to)
- `projectId` and `sessionId` available as component props
- `lc.messages` provides all messages from DO WebSocket
- ChatFilePanel rendered at bottom of JSX, after all other content
- Virtuoso ref available for scroll-to-message via `scrollToIndex`

## Implementation Checklist

### API: Session-scoped activity events
- [ ] Add optional `sessionId` parameter to `listActivityEvents()` in `apps/api/src/durable-objects/project-data/activity.ts`
- [ ] Add `sessionId` filter to SQL query (`AND session_id = ?` when provided)
- [ ] Add `sessionId` parameter to service layer in `apps/api/src/services/project-data.ts`
- [ ] Add `sessionId` query param to route handler in `apps/api/src/routes/activity.ts`
- [ ] Add `sessionId` to client fetch function in `apps/web/src/lib/api/sessions.ts`

### Timeline types + builder
- [ ] Create `apps/web/src/components/project-message-view/timeline-types.ts` with `TimelineEntry` discriminated union
- [ ] Create `apps/web/src/components/project-message-view/buildSessionTimeline.ts` — pure function merging messages + activity events chronologically, mapping event types to severity/colors

### Timeline hook
- [ ] Create `apps/web/src/components/project-message-view/useSessionTimeline.ts` — fetches activity events when drawer opens, derives timeline entries via useMemo, manages context toggle state

### Timeline drawer
- [ ] Create `apps/web/src/components/chat/ChatTimelineDrawer.tsx` — exact same drawer pattern as ChatFilePanel (createPortal, glass classes, z-drawer tokens, green edge glow, responsive layout, escape key)

### Wire into SessionHeader + ProjectMessageView
- [ ] Add `onOpenTimeline?: () => void` prop to SessionHeader
- [ ] Add Timeline button in action buttons row (NOT gated on active workspace)
- [ ] Add `showTimeline` state to ProjectMessageView
- [ ] Init useSessionTimeline hook
- [ ] Render ChatTimelineDrawer alongside ChatFilePanel
- [ ] Add jump-to-message handler using Virtuoso scrollToIndex

### Cleanup prototype
- [ ] Remove `/prototype/chat-timeline-v1` and `/prototype/chat-timeline-v2` routes from App.tsx
- [ ] Delete `apps/web/src/pages/chat-timeline-v1/` directory
- [ ] Delete `apps/web/src/pages/chat-timeline-v2/` directory
- [ ] Remove lazy imports from App.tsx

### Tests
- [ ] Unit tests for `buildSessionTimeline` (merges + sorts entries, maps severity colors, handles empty data)
- [ ] Playwright visual audit of the drawer (mobile + desktop)

## Acceptance Criteria

- [ ] Timeline button visible in SessionHeader alongside Files/Git/Workspace/Complete
- [ ] Timeline button always visible (not gated on active workspace state)
- [ ] Clicking Timeline opens a glass drawer matching ChatFilePanel style
- [ ] Drawer shows user messages + activity events merged chronologically
- [ ] Activity events filtered by current sessionId
- [ ] Context toggle switches between user messages only / all entries
- [ ] Clicking a user message entry scrolls to it in the chat (Virtuoso scrollToIndex)
- [ ] Escape key closes the drawer
- [ ] Works on mobile (375px) and desktop (1280px)
- [ ] Prototype routes removed before merge
- [ ] No TypeScript errors, lint errors, or test failures
