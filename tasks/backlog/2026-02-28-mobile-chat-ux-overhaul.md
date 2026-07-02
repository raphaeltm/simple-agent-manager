# Mobile Chat UX Overhaul

**Created**: 2026-02-28
**Status**: Backlog
**Priority**: High
**Estimated Effort**: Medium

## Problem

The project chat UI is unusable on mobile devices. After submitting a task, the session sidebar appears as a fixed 280px grid column, crushing the chat content into a ~95px sliver on a typical 375px phone screen. There is no way to collapse or hide the sidebar. Additional issues compound the problem: duplicate nav bars waste vertical space, the hamburger menu is on the wrong side, and the chat panel has height constraints designed for desktop.

## Root Cause Analysis

### Issue 1: Session sidebar takes over mobile screen
- **File**: `apps/web/src/pages/ProjectChat.tsx` (line ~190)
- **Cause**: `gridTemplateColumns: '280px 1fr'` has no responsive breakpoint. Zero `useIsMobile` usage in this component.
- **Impact**: After submitting a task (or when any sessions exist), 280px of 375px is consumed by the sidebar, leaving ~95px for actual chat content.

### Issue 2: Two nav bars stacked vertically
- **File**: `apps/web/src/components/AppShell.tsx` (mobile header, line 121) and `apps/web/src/pages/Project.tsx` (uses `PageLayout`)
- **Cause**: AppShell renders `[hamburger] [SAM] [avatar]` header. Then `PageLayout` (used by `Project.tsx`) renders a second header `[Project] [UserMenu]`. These stack, consuming ~100px of vertical space.
- **Impact**: The user sees duplicate headers with duplicate user avatars, and the chat content area shrinks significantly.

### Issue 3: Hamburger menu on left, drawer slides from right
- **File**: `apps/web/src/components/AppShell.tsx` (hamburger button, line 125) and `apps/web/src/components/MobileNavDrawer.tsx` (panel, `right: 0`)
- **Cause**: The hamburger trigger is left-aligned but `MobileNavDrawer` is anchored to `right: 0` and slides in from the right via `translateX(100%)`.
- **Impact**: Usability mismatch — users expect the menu to appear on the same side as the trigger.

### Issue 4: Chat panel height constraints designed for desktop
- **File**: `apps/web/src/pages/ProjectChat.tsx` (line ~193)
- **Cause**: `maxHeight: 'calc(100vh - 240px)'` and `minHeight: '500px'`. The 240px offset accounts for desktop chrome (sidebar header + PageLayout header + breadcrumbs + project header + padding). On mobile, the overhead is different, and the 500px min-height can exceed the viewport.
- **Impact**: Page-level scrolling conflicts with chat scrolling on mobile.

## Proposed Changes

### Change 1: Mobile session sidebar as a drawer overlay

On mobile (`useIsMobile()`), convert the session sidebar from an inline grid column to a slide-out drawer (reusing the existing drawer pattern from `MobileNavDrawer`).

**Behavior:**
- When sessions exist, show a small toggle button (e.g., list icon) in the chat header area to open the session list
- The session list slides in as a full-height drawer overlay (same z-index layer as `MobileNavDrawer`)
- Selecting a session closes the drawer and shows the chat
- The main chat content always gets `1fr` / full width on mobile
- On desktop, behavior is unchanged (`280px 1fr` grid)

**Files to modify:**
- `apps/web/src/pages/ProjectChat.tsx` — add `useIsMobile()`, conditionally render sidebar as drawer vs inline
- `apps/web/src/components/chat/SessionSidebar.tsx` — no changes needed (it already renders as a list; the container decides drawer vs inline)

### Change 2: Eliminate duplicate header on mobile project pages

On mobile, the `Project.tsx` page should skip `PageLayout`'s header and render its content directly inside the AppShell's `<main>`, relying solely on AppShell's mobile header bar.

**Approach:**
- Add `hideHeader` prop to `PageLayout` (or create a `PageLayoutContent` variant that skips the header)
- `Project.tsx` passes `hideHeader` when `isMobile` is true
- The project name, breadcrumb, and action buttons (Settings, Status) merge into a compact inline bar below the AppShell header — or better, the project name goes into the AppShell header itself (replacing "SAM" when inside a project)
- The Settings/Status buttons become part of the project content header row, which is already compact

**Files to modify:**
- `packages/ui/src/primitives/PageLayout.tsx` — add `hideHeader` prop
- `apps/web/src/pages/Project.tsx` — pass `hideHeader={isMobile}`, reorganize project header for mobile
- `apps/web/src/components/AppShell.tsx` — optionally accept a dynamic title override for the mobile header

### Change 3: Move hamburger menu to the right side

Move the hamburger trigger from the left to the right side of the AppShell mobile header, matching the drawer's slide-in direction (from right).

**Layout change:**
- Before: `[hamburger] [SAM] [avatar]`
- After: `[SAM/title] [spacer] [hamburger]`
- Remove the standalone avatar from the header (it's already shown inside the MobileNavDrawer)

**Files to modify:**
- `apps/web/src/components/AppShell.tsx` — reorder mobile header elements

### Change 4: Fix chat panel height for mobile

Replace the desktop-oriented height constraints with responsive values.

**Changes:**
- On mobile: remove `minHeight: '500px'`, use `flex: 1` to fill available space within the AppShell's `<main>` area
- On mobile: change `maxHeight` from `calc(100vh - 240px)` to `calc(var(--sam-app-height, 100vh) - <actual mobile overhead>)` — or better, use flex-based layout that naturally fills the remaining space
- Use `var(--sam-app-height)` (already synced by `mobile-viewport.ts`) for accurate viewport on iOS

**Files to modify:**
- `apps/web/src/pages/ProjectChat.tsx` — conditional height styles based on `isMobile`
- `apps/web/src/pages/Project.tsx` — ensure the project content wrapper uses `flex: 1` and `minHeight: 0` so children can fill the space

### Change 5: Compact project header on mobile

The project header row (project name, repo link, Status/Settings buttons) needs to be more compact on mobile.

**Changes:**
- Stack the project name and repo link vertically (or hide repo link on mobile)
- Make Settings/Status buttons icon-only (drop text labels) on mobile
- Reduce vertical padding/margins

**Files to modify:**
- `apps/web/src/pages/Project.tsx` — conditional layout for mobile

## Implementation Checklist

### Preparation
- [ ] Read `useIsMobile` hook to confirm breakpoint (767px)
- [ ] Review drawer z-index tokens (`--sam-z-drawer`, `--sam-z-drawer-backdrop`)
- [ ] Review `mobile-viewport.ts` for `--sam-app-height` usage

### Change 1: Session sidebar drawer on mobile
- [ ] Add `useIsMobile()` to `ProjectChat.tsx`
- [ ] Add `sidebarOpen` state (default `false`)
- [ ] On mobile: render chat grid as single column (`1fr`)
- [ ] On mobile: add a toggle button (list icon) in the chat area to open sessions
- [ ] On mobile: render `SessionSidebar` inside a drawer overlay when `sidebarOpen` is true
- [ ] On mobile: close drawer on session select
- [ ] Verify desktop behavior unchanged

### Change 2: Single header on mobile
- [ ] Add `hideHeader` prop to `PageLayout`
- [ ] In `Project.tsx`: detect `isMobile`, pass `hideHeader`
- [ ] Ensure breadcrumb still renders below the AppShell header on mobile
- [ ] Remove duplicate `UserMenu` from project page on mobile

### Change 3: Hamburger to right side
- [ ] In `AppShell.tsx`: move hamburger button to right side of mobile header
- [ ] Remove standalone avatar from mobile header (shown in drawer)
- [ ] Verify drawer still opens correctly from right

### Change 4: Mobile chat height
- [ ] Remove `minHeight: '500px'` on mobile
- [ ] Replace fixed `maxHeight` with flex-based fill on mobile
- [ ] Use `var(--sam-app-height)` for iOS viewport accuracy
- [ ] Test that chat scroll works without page-level scroll conflicts

### Change 5: Compact project header on mobile
- [ ] Stack project name/repo vertically or hide repo link on mobile
- [ ] Make Settings/Status buttons icon-only on mobile
- [ ] Reduce spacing/padding on mobile

### Testing
- [ ] Playwright mobile viewport screenshots before/after
- [ ] Test session sidebar drawer open/close/select on mobile
- [ ] Test submitting a new task on mobile — verify chat remains usable
- [ ] Test with 0 sessions (empty state), 1 session, multiple sessions
- [ ] Test hamburger menu opens correctly from right
- [ ] Test Settings/Status drawers still work on mobile
- [ ] Verify all changes are no-ops on desktop (>767px)

## Technical Notes

- The `useIsMobile()` hook at `apps/web/src/hooks/useIsMobile.ts` uses `MOBILE_BREAKPOINT = 767` and `matchMedia`. This is the canonical mobile detection used by `AppShell`, `Workspace`, and admin pages.
- Drawer components should use `--sam-z-drawer` / `--sam-z-drawer-backdrop` from `packages/ui/src/tokens/theme.css`.
- The `mobile-viewport.ts` utility syncs `--sam-app-height` CSS variable with the visual viewport (handles iOS Safari URL bar resize).
- `MobileNavDrawer` provides a reference implementation for drawer slide-in animations and backdrop patterns.
- No new dependencies required — all patterns exist in the codebase already.

## Out of Scope

- Desktop layout changes (all changes gated behind `useIsMobile()`)
- Session sidebar content/styling changes (just the container treatment changes)
- New features or functionality — this is purely a layout/UX fix
- Chat message rendering changes (handled by `ProjectMessageView`)

## Related Files

| File | Role |
|------|------|
| `apps/web/src/pages/ProjectChat.tsx` | Main chat page with sidebar grid |
| `apps/web/src/pages/Project.tsx` | Project wrapper with PageLayout and project header |
| `apps/web/src/components/AppShell.tsx` | App shell with mobile header + hamburger |
| `apps/web/src/components/MobileNavDrawer.tsx` | Reference drawer implementation |
| `apps/web/src/components/chat/SessionSidebar.tsx` | Session list component |
| `packages/ui/src/primitives/PageLayout.tsx` | Page layout with header |
| `apps/web/src/hooks/useIsMobile.ts` | Mobile breakpoint hook |
| `apps/web/src/lib/mobile-viewport.ts` | Visual viewport sync |

## Success Criteria

- [ ] On mobile, chat content always uses full screen width
- [ ] Session list accessible via toggle button, shown as overlay drawer
- [ ] Single header bar on mobile (AppShell header only)
- [ ] Hamburger menu on the right side, matching drawer direction
- [ ] Chat panel fills available vertical space without page-level scroll conflicts
- [ ] All desktop layouts unaffected
