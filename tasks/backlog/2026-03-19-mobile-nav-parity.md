# Mobile Navigation Parity with Desktop

## Problem

The desktop navigation (NavSidebar.tsx) was updated to be project-centric with Lucide icons on every nav item, but the mobile navigation (MobileNavDrawer.tsx) was not updated to match. The mobile drawer shows text-only labels without icons, and the AppShell.tsx `mobileNavItems` memo explicitly strips icons when building the mobile nav item list.

## Research Findings

### Key Files
- `apps/web/src/components/NavSidebar.tsx` — Desktop nav with `NavItem` type including `icon: React.ReactNode`
- `apps/web/src/components/MobileNavDrawer.tsx` — Mobile drawer with its own `NavItem` type (label + path only, no icon)
- `apps/web/src/components/AppShell.tsx` — Layout that switches between desktop/mobile; builds `mobileNavItems` without icons (lines 29-44)
- `apps/web/tests/unit/AppShell.test.tsx` — Existing tests for both desktop and mobile nav
- `.claude/rules/04-ui-standards.md` — UI rules, no mention of desktop/mobile nav parity

### Root Cause
- `MobileNavDrawer.tsx` defines its own `NavItem` interface without an `icon` field (line 3-6)
- `AppShell.tsx` maps `GLOBAL_NAV_ITEMS` and `PROJECT_NAV_ITEMS` to plain `{label, path}` objects for mobile (lines 29-44)
- The desktop `NavItem` type from NavSidebar.tsx is exported but not used by the mobile drawer

### What Desktop Has That Mobile Lacks
1. Icons on every nav item (Lucide React icons at 18px)
2. "Back to Projects" has an ArrowLeft icon
3. Project name header when in project context
4. Admin item has Shield icon
5. Infrastructure section (Nodes, Workspaces) for superadmins — collapsible

## Implementation Checklist

- [ ] Update `MobileNavDrawer.tsx` NavItem interface to include optional `icon` field
- [ ] Render icons alongside labels in mobile drawer nav items
- [ ] Update `AppShell.tsx` `mobileNavItems` memo to pass icons through from the shared nav item arrays
- [ ] Add ArrowLeft icon for "Back to Projects" item in mobile
- [ ] Add Shield icon for Admin item in mobile (superadmin)
- [ ] Add project name header in mobile drawer when in project context
- [ ] Add Infrastructure section for superadmins in mobile drawer (Nodes, Workspaces with Server/Monitor icons)
- [ ] Update existing tests to verify icons render in mobile drawer
- [ ] Add new rule `.claude/rules/15-nav-parity.md` requiring desktop/mobile nav changes to be reviewed together
- [ ] Run lint, typecheck, tests

## Acceptance Criteria

- [ ] Mobile drawer nav items display the same Lucide icons as desktop sidebar
- [ ] Mobile drawer shows project name when in project context
- [ ] Mobile drawer shows "Back to Projects" with ArrowLeft icon when in project context
- [ ] Mobile drawer shows Admin with Shield icon for superadmins
- [ ] Mobile drawer shows Infrastructure (Nodes, Workspaces) for superadmins
- [ ] All existing AppShell tests pass
- [ ] New tests verify icon presence in mobile drawer
- [ ] New rule added requiring desktop/mobile nav parity review
