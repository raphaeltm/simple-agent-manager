# Project-Centric Navigation

## Problem

SAM's navigation is infrastructure-centric: Nodes, Workspaces sit at the same level as Projects in the sidebar. Project sub-routes (Tasks, Overview, Activity, Sessions, Settings) are invisible — users can only reach them by editing URLs. The sidebar is static everywhere, showing the same items regardless of context.

## Research Findings

### Current Architecture
- **NavSidebar.tsx**: Static `NAV_ITEMS` array with Dashboard, Projects, Nodes, Workspaces, Settings. Admin added conditionally for superadmins.
- **AppShell.tsx**: Grid layout (220px sidebar + 1fr content). Mobile layout uses hamburger → MobileNavDrawer. Imports `NAV_ITEMS` for mobile drawer.
- **MobileNavDrawer.tsx**: Receives nav items as props, renders as list of buttons. No context-awareness.
- **Project.tsx**: Two layouts — chat routes get full-bleed (no PageLayout), non-chat routes get PageLayout with breadcrumb. No in-page navigation between project sub-routes.
- **App.tsx**: Project sub-routes nested under `/projects/:id` with `<Project />` as parent. Sub-routes: overview, chat, chat/:sessionId, kanban, tasks, tasks/:taskId, sessions, sessions/:sessionId, settings, activity.
- **Dashboard.tsx**: Shows Active Tasks + Projects grid. Largely duplicates Projects page.
- **Settings.tsx / Admin.tsx**: Use `<Tabs>` component from `@simple-agent-manager/ui` for sub-navigation — this is the pattern to follow for project sub-nav.

### Key Patterns
- `<Tabs>` component takes `tabs: Tab[]` and `basePath: string`, uses `NavLink` with active detection
- Admin page conditionally rendered based on `isSuperadmin`
- Workspace full-screen route (`/workspaces/:id`) is outside AppShell — must not be affected

## Implementation Checklist

- [ ] 1. **Create context-aware NavSidebar**: Detect when inside `/projects/:id/*` route. Show global nav (Home, Settings, Admin) for global pages; show project nav (Back, project name, Chat, Tasks, Overview, Activity, Sessions, Settings) when inside a project.
- [ ] 2. **Demote Nodes & Workspaces**: Remove from primary NAV_ITEMS. Add as "Infrastructure" collapsible section visible only to superadmins in the sidebar.
- [ ] 3. **Rename Dashboard to Home**: Change the Dashboard nav item label to "Home" and keep it as the entry point at `/dashboard`.
- [ ] 4. **Add project sub-nav to chat layout**: In Project.tsx, add a minimal horizontal nav bar for chat routes so users can navigate to other project sections without leaving.
- [ ] 5. **Update MobileNavDrawer**: Make mobile drawer context-aware — show project nav items when inside a project, global items otherwise.
- [ ] 6. **Update AppShell**: Pass project context information (project ID, whether inside project) to NavSidebar and MobileNavDrawer.
- [ ] 7. **Update existing tests**: Fix AppShell.test.tsx, app-routes.test.tsx, and mobile-nav-drawer.test.tsx for new nav structure.
- [ ] 8. **Add behavioral tests**: Test sidebar morphing, project nav visibility, back navigation, mobile drawer context switching.

## Acceptance Criteria

- [ ] Sidebar shows Home, Projects (replaced from Dashboard), Settings, and Admin (superadmin) on global pages
- [ ] Sidebar morphs to show project-specific nav when inside `/projects/:id/*`
- [ ] Project sidebar includes: ← Back to Projects, project name header, Chat, Tasks, Overview, Activity, Sessions, Settings
- [ ] Nodes & Workspaces are accessible under Infrastructure section (superadmin only)
- [ ] Chat layout includes minimal project navigation bar
- [ ] Mobile drawer adapts to show project nav when inside a project
- [ ] Workspace full-screen terminal layout is unaffected
- [ ] All existing tests pass or are updated
- [ ] New behavioral tests cover sidebar morphing and navigation
