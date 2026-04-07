# Smooth Nav Toggle: In-Place Global/Project Nav Switching

## Problem Statement

When inside a project, clicking "Back to Projects" in the sidebar/nav causes a full page navigation to `/projects`. The user then has to open the nav again and click to reach their desired global destination (Home, Chats, Settings, etc.). This is 4 interactions (click, wait for load, click nav, click item) when it should be 2 (toggle nav view, click item).

**Desired behavior:**
- Clicking "Back to Projects" toggles the sidebar/drawer in-place to show global nav items (no page load)
- When viewing global nav items, a "Back to [Project Name]" button toggles back to project-specific nav
- Smooth slide transition between the two views
- Works on both mobile (drawer) and desktop (sidebar)

## Research Findings

### Key Files
- `apps/web/src/components/NavSidebar.tsx` — Desktop sidebar with project/global nav rendering
- `apps/web/src/components/MobileNavDrawer.tsx` — Mobile slide-out drawer
- `apps/web/src/components/AppShell.tsx` — Shell layout, manages project name state, constructs mobile nav items

### Current Architecture
- `NavSidebar` renders either project nav or global nav based on `extractProjectId(pathname)`
- The "Back to Projects" is a `<Link to="/projects">` that triggers full navigation
- `AppShell` constructs `mobileNavItems` with "Back to Projects" as first item with path `/projects`
- `MobileNavDrawer` calls `onNavigate(path)` which does `navigate(path)` then closes drawer
- Project name is passed through AppShellContext from `Project.tsx`

### Design Approach
- Add `showGlobalNav` boolean state to `AppShell` (shared between desktop/mobile)
- Pass toggle callback + state to `NavSidebar` and `MobileNavDrawer`
- In project context: "Back to Projects" becomes a toggle button (not a Link)
- When toggled to global: show global nav items with "Back to [Project Name]" button at top
- CSS transition for smooth slide effect between views
- Reset `showGlobalNav` to false when navigating to a different page (route change)
- Clicking a global nav item should navigate AND close the toggle (reset state)

## Implementation Checklist

- [ ] **1. Add nav toggle state to AppShell**
  - Add `showGlobalNav` state, default `false`
  - Reset to `false` on route change (existing `useEffect` on `location.pathname`)
  - Pass `showGlobalNav` and `onToggleGlobalNav` to NavSidebar and MobileNavDrawer
  - Expose `projectName` and `projectId` to both components

- [ ] **2. Update NavSidebar for desktop toggle**
  - Replace `<Link to="/projects">` with `<button>` that calls toggle
  - When `showGlobalNav` is true AND in project context: render global nav with "Back to [Project Name]" button
  - Add CSS transition (slide/fade) between project and global views
  - Keep Infrastructure section visible in global view

- [ ] **3. Update MobileNavDrawer for mobile toggle**
  - Replace "Back to Projects" nav item with a toggle button
  - When toggled: show global nav items with "Back to [Project Name]" at top
  - Animate the transition between views (slide left/right)
  - Clicking a global nav item should navigate AND close drawer

- [ ] **4. Add smooth CSS transitions**
  - Slide animation between project ↔ global nav views
  - Use `transform: translateX()` or similar for smooth sliding
  - Respect `prefers-reduced-motion`

- [ ] **5. Write Playwright visual audit tests**
  - Mobile (375px) and desktop (1280px) viewports
  - Test scenarios: project nav view, global nav view after toggle, toggle back
  - Long project names, many nav items
  - Verify no overflow, proper truncation
  - Test animation/transition occurs

- [ ] **6. Write behavioral unit tests**
  - Toggle button renders correctly
  - Clicking toggle switches between views
  - Navigation items are correct in each view
  - Route changes reset toggle state
  - Project name displays correctly in "Back to [Name]" button

## Acceptance Criteria

- [ ] Clicking "Back to Projects" in desktop sidebar toggles to global nav (no page load)
- [ ] Clicking "Back to Projects" in mobile drawer toggles to global nav (no page close)
- [ ] Global nav view shows "Back to [Project Name]" button that toggles back
- [ ] Transition between views is smooth (slide animation)
- [ ] Clicking a global nav item navigates to that page
- [ ] Toggle state resets when navigating to a new page
- [ ] Works correctly on mobile (375px) and desktop (1280px)
- [ ] Long project names are properly truncated
- [ ] Accessibility: keyboard navigation works, proper aria labels
- [ ] `prefers-reduced-motion` is respected
