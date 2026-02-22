# Component Contracts: Navigation

**Feature**: 019-ui-overhaul
**Package**: `apps/web`
**Location**: `apps/web/src/components/`

## AppShell

### Import

```typescript
import { AppShell } from '../components/AppShell';
```

### Props

```typescript
interface AppShellProps {
  children: React.ReactNode;
}
```

### Layout

**Desktop (>= 768px)**:
```
┌──────────┬──────────────────────────────────┐
│ Sidebar  │                                  │
│ (220px)  │  Content Area                    │
│          │  (scrollable)                    │
│ [Home]   │                                  │
│ [Proj]   │  {children}                      │
│ [Nodes]  │                                  │
│ [Config] │                                  │
│          │                                  │
│ ──────── │                                  │
│ [Avatar] │                                  │
│ [Name]   │                                  │
│ [Logout] │                                  │
└──────────┴──────────────────────────────────┘
```

**Mobile (< 768px)**:
```
┌──────────────────────────────────────────────┐
│ [☰]  SAM                            [Avatar] │
├──────────────────────────────────────────────┤
│                                              │
│  Content Area                                │
│  (scrollable)                                │
│                                              │
│  {children}                                  │
│                                              │
└──────────────────────────────────────────────┘
```

### Sidebar Nav Items

| Label | Icon | Path | Match Pattern |
|-------|------|------|---------------|
| Dashboard | `Home` (lucide) | `/dashboard` | `startsWith('/dashboard')` |
| Projects | `FolderKanban` (lucide) | `/projects` | `startsWith('/projects')` |
| Nodes | `Server` (lucide) | `/nodes` | `startsWith('/nodes')` |
| Settings | `Settings` (lucide) | `/settings` | `startsWith('/settings')` |

### Behavior

- Desktop sidebar is always visible (not collapsible in v1)
- Mobile hamburger toggles MobileNavDrawer (already exists, integrate)
- Sidebar closes on route change (mobile only)
- Active nav item determined by `useLocation().pathname`
- User avatar + name shown at sidebar bottom (desktop) or in drawer (mobile)
- Sign out action in user section

### Integration with Routes

```typescript
// In App.tsx route config
<Route element={<AppShell><Outlet /></AppShell>}>
  <Route path="/dashboard" element={<Dashboard />} />
  <Route path="/projects" element={<Projects />} />
  <Route path="/projects/new" element={<ProjectCreate />} />
  <Route path="/projects/:id" element={<Project />}>
    <Route index element={<Navigate to="overview" replace />} />
    <Route path="overview" element={<ProjectOverview />} />
    <Route path="tasks" element={<ProjectTasks />} />
    <Route path="tasks/:taskId" element={<TaskDetail />} />
    <Route path="sessions" element={<ProjectSessions />} />
    <Route path="sessions/:sessionId" element={<ChatSessionView />} />
    <Route path="settings" element={<ProjectSettings />} />
    <Route path="activity" element={<ProjectActivity />} />
  </Route>
  <Route path="/nodes" element={<Nodes />} />
  <Route path="/nodes/:id" element={<Node />} />
  <Route path="/workspaces/new" element={<CreateWorkspace />} />
  <Route path="/settings" element={<SettingsShell />}>
    <Route index element={<Navigate to="cloud-provider" replace />} />
    <Route path="cloud-provider" element={<SettingsCloudProvider />} />
    <Route path="github" element={<SettingsGitHub />} />
    <Route path="agent-keys" element={<SettingsAgentKeys />} />
    <Route path="agent-config" element={<SettingsAgentConfig />} />
  </Route>
</Route>

{/* Workspace — NO AppShell */}
<Route path="/workspaces/:id" element={<Workspace />} />
```

### Exclusions

The Workspace detail page (`/workspaces/:id`) renders WITHOUT AppShell. It uses the full viewport for the terminal/IDE experience. A breadcrumb-style back link is provided to return to the project.
