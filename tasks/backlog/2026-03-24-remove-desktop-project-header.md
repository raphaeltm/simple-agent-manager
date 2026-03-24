# Remove Redundant Desktop Header on Non-Chat Project Pages

## Problem

On non-chat project pages (Ideas, Activity, Settings), there's a large header bar at the top showing the project name and user menu (avatar + logout). This is redundant because:
- The sidebar already shows user info + logout at the bottom
- The project name can be shown in the sidebar where it currently says "Project"

The header wastes vertical space on desktop and duplicates information already present in the sidebar.

## Research Findings

### Current Architecture

1. **`PageLayout`** (`packages/ui/src/primitives/PageLayout.tsx`): Generic layout with a desktop-only `<header>` showing title + `headerRight` (UserMenu). Also applies max-width + padding to content.
2. **`Project.tsx`** (`apps/web/src/pages/Project.tsx`): Wraps non-chat routes in `<PageLayout title={project?.name} headerRight={<UserMenu />}>`. Chat routes use full-bleed layout without PageLayout.
3. **`NavSidebar`** (`apps/web/src/components/NavSidebar.tsx`): Accepts `projectName` prop, displays it as uppercase label (line 90-92). Falls back to "Project" when prop is undefined.
4. **`AppShell`** (`apps/web/src/components/AppShell.tsx`): Renders NavSidebar but does NOT pass `projectName` prop (line 155). Has access to `projectId` from URL but not the project data.

### Key Observations

- `NavSidebar` already supports `projectName` prop — it just never receives the actual name
- `AppShell` is a parent of `Project.tsx` in the component tree, so project data loaded in Project.tsx can't directly reach AppShell
- `PageLayout` is used by 10+ pages — we should NOT modify it, just stop using it for project sub-pages
- On mobile, the PageLayout header is already hidden (`hidden md:block`), so mobile is unaffected

## Implementation Checklist

- [ ] Create a shell-level context (`AppShellContext`) with `setProjectName` callback so Project.tsx can communicate the project name up to AppShell
- [ ] In `AppShell.tsx`: hold `projectName` state, provide it via context, pass it to `NavSidebar`
- [ ] In `Project.tsx`: consume context to set project name when project loads; clear on unmount
- [ ] In `Project.tsx`: replace `PageLayout` wrapper for non-chat routes with a simpler container that preserves max-width + padding but removes the desktop header bar
- [ ] Verify mobile behavior is unchanged (PageLayout header was already `hidden` on mobile)
- [ ] Run lint + typecheck

## Acceptance Criteria

- [ ] Non-chat project pages (Ideas, Activity, Settings) do NOT show the top header bar on desktop
- [ ] The sidebar shows the actual project name (not "Project") when inside a project
- [ ] User info + logout remain accessible in the sidebar bottom section
- [ ] Mobile layout is unchanged
- [ ] No regressions on other pages that use PageLayout (Dashboard, Nodes, Settings, etc.)

## References

- `packages/ui/src/primitives/PageLayout.tsx` — the header component being removed
- `apps/web/src/components/AppShell.tsx` — sidebar shell
- `apps/web/src/components/NavSidebar.tsx` — project nav with projectName prop
- `apps/web/src/pages/Project.tsx` — project route wrapper
