# Timeline Drawer Post-Merge Fixes

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** H1, the focus trap on the timeline drawer (`useDialogFocusTrap` at
>   `apps/web/src/components/chat/ChatTimelineDrawer.tsx:55`, PR #1897).
> - **Still open:**
>   - M1/M2: `hover:bg-bg-hover` and `group-hover:text-fg-accent` are still used
>     (`ChatTimelineDrawer.tsx:108-286`) and are not defined in `apps/web/src/app.css`. The
>     suggested `text-accent-primary` is undefined too; use `hover:bg-surface-hover` and
>     `text-accent`. The same classes spread to `SessionCommentsDrawer.tsx`,
>     `SessionEventsDrawer.tsx` and `comments/MessageCommentPanels.tsx`.
>   - M3: `useSessionTimeline` exposes no error state
>     (`apps/web/src/components/project-message-view/useSessionTimeline.ts:17-22`).
>   - C1: drawers still open independently (`SessionMessageView.tsx:116-127`). Check it still
>     reproduces first: each drawer has a click-to-close backdrop and is full-screen on mobile.
>   - Focus trap for `ChatFilePanel`; the Playwright audit.

**Source**: UI/UX specialist late review of PR #1304 (chat timeline feature)
**Priority**: High (includes CRITICAL panel overlap)

## Problem

The UI/UX specialist review completed after PR #1304 was merged and deployed. Several findings were not addressed before merge.

## Findings

### CRITICAL: Panel Overlap (C1)
Both `ChatFilePanel` and `ChatTimelineDrawer` can be open simultaneously at `z-50`. They overlap on desktop and completely obscure each other on mobile. Need mutual exclusion in `ProjectMessageView/index.tsx` — when one opens, the other should close.

**Fix**: In `ProjectMessageView/index.tsx`, add mutual exclusion:
- When `setShowTimeline(true)` is called, also call `lc.setFilePanel(false)` (or equivalent)
- When file panel opens, also call `setShowTimeline(false)`

### MEDIUM: Undefined Tailwind Tokens (M1, M2)
- `hover:bg-bg-hover` in `ChatTimelineDrawer.tsx` — should be `hover:bg-surface-hover`
- `group-hover:text-fg-accent` in `ChatTimelineDrawer.tsx` — should be `group-hover:text-accent-primary`

These tokens don't exist in the design system, so the hover states silently do nothing.

### MEDIUM: Error State Swallowed (M3)
`useSessionTimeline` hook catches fetch errors but only logs to console. The drawer shows no error UI when the activity events API fails. Should expose error state and render an inline error message.

### HIGH: Missing Focus Trap (H1)
`ChatTimelineDrawer` uses `aria-modal="true"` but has no focus trap. This is a pre-existing pattern inherited from `ChatFilePanel` — both drawers have this issue.

## Implementation Checklist

- [ ] Add mutual exclusion between timeline drawer and file panel in `ProjectMessageView/index.tsx`
- [ ] Fix `hover:bg-bg-hover` → `hover:bg-surface-hover` in `ChatTimelineDrawer.tsx`
- [ ] Fix `group-hover:text-fg-accent` → `group-hover:text-accent-primary` in `ChatTimelineDrawer.tsx`
- [ ] Expose error state from `useSessionTimeline` and render error UI in drawer
- [ ] (Optional) Add focus trap to both `ChatTimelineDrawer` and `ChatFilePanel` — or remove `aria-modal` if full modal semantics aren't intended

## Acceptance Criteria

- [ ] Only one drawer (file panel or timeline) can be open at a time
- [ ] Hover states on timeline entries are visible (tokens resolve correctly)
- [ ] Activity fetch errors display an inline error message in the drawer
- [ ] Playwright visual audit passes at mobile and desktop viewports
