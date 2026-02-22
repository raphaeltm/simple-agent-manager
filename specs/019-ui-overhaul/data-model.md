# Data Model: UI/UX Overhaul

**Feature**: 019-ui-overhaul
**Date**: 2026-02-22

## Overview

This feature is frontend-only — no database schema changes, no new API endpoints. The "data model" covers: design token extensions, component prop interfaces, routing structure, and state management patterns.

## 1. Design Token Extensions

### 1.1 Typography Scale Tokens

Added to `packages/ui/src/tokens/theme.css`:

```css
:root {
  /* Typography Scale — 6 tiers */
  --sam-type-page-title-size: 1.5rem;
  --sam-type-page-title-weight: 700;
  --sam-type-page-title-line-height: 1.2;

  --sam-type-section-heading-size: 1.125rem;
  --sam-type-section-heading-weight: 600;
  --sam-type-section-heading-line-height: 1.3;

  --sam-type-card-title-size: 1rem;
  --sam-type-card-title-weight: 600;
  --sam-type-card-title-line-height: 1.4;

  --sam-type-body-size: 0.9375rem;
  --sam-type-body-weight: 400;
  --sam-type-body-line-height: 1.5;

  --sam-type-secondary-size: 0.875rem;
  --sam-type-secondary-weight: 400;
  --sam-type-secondary-line-height: 1.5;

  --sam-type-caption-size: 0.75rem;
  --sam-type-caption-weight: 400;
  --sam-type-caption-line-height: 1.4;

  /* Section spacing */
  --sam-space-section: 2rem;
}
```

### 1.2 Color Tint Tokens

Semantic tint tokens for tinted backgrounds (replace hardcoded `rgba()` values):

```css
:root {
  --sam-color-accent-primary-tint: rgba(22, 163, 74, 0.1);
  --sam-color-success-tint: rgba(34, 197, 94, 0.1);
  --sam-color-warning-tint: rgba(245, 158, 11, 0.1);
  --sam-color-danger-tint: rgba(239, 68, 68, 0.1);
  --sam-color-info-tint: rgba(122, 162, 247, 0.1);
}
```

### 1.3 Shadow Tokens

```css
:root {
  --sam-shadow-dropdown: 0 4px 16px rgba(0, 0, 0, 0.3);
  --sam-shadow-overlay: 0 8px 32px rgba(0, 0, 0, 0.4);
  --sam-shadow-tooltip: 0 2px 8px rgba(0, 0, 0, 0.3);
}
```

### 1.4 Z-Index Tokens

```css
:root {
  --sam-z-sticky: 10;
  --sam-z-dropdown: 20;
  --sam-z-drawer-backdrop: 40;
  --sam-z-drawer: 41;
  --sam-z-dialog-backdrop: 50;
  --sam-z-dialog: 51;
  --sam-z-panel: 60;
  --sam-z-command-palette: 61;
}
```

## 2. Component Prop Interfaces

### 2.1 DropdownMenu

```typescript
interface DropdownMenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  variant?: 'default' | 'danger';
  disabled?: boolean;
  disabledReason?: string;  // Shown as tooltip when disabled
  onClick: () => void;
}

interface DropdownMenuProps {
  items: DropdownMenuItem[];
  trigger?: React.ReactNode;       // Custom trigger element; defaults to three-dot icon
  align?: 'start' | 'end';        // Horizontal alignment relative to trigger
  'aria-label'?: string;
}
```

**State**: Internal `isOpen` boolean. Dismissed on click-outside, Escape key, or item click.

**Keyboard Navigation**: Arrow Up/Down to navigate items, Enter/Space to select, Escape to close, Tab to close and move focus.

### 2.2 ButtonGroup

```typescript
interface ButtonGroupProps {
  children: React.ReactNode;       // Must be Button components
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}
```

**Rendering**: First child gets `border-radius: var(--sam-radius-sm) 0 0 var(--sam-radius-sm)`, last child gets `0 var(--sam-radius-sm) var(--sam-radius-sm) 0`, middle children get `border-radius: 0`. No gap between buttons; shared borders collapse.

### 2.3 Tabs

```typescript
interface Tab {
  id: string;
  label: string;
  path: string;                    // Relative path for route matching
  icon?: React.ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  basePath: string;                // Parent route path for constructing full URLs
  className?: string;
}
```

**Route Integration**: Uses `useLocation()` to determine active tab. Renders `<NavLink>` elements. Does NOT render tab content — that comes from `<Outlet />` in the parent route.

**Keyboard Navigation**: Arrow Left/Right to move focus between tabs, Enter/Space to activate, Home/End to jump to first/last.

**Overflow**: When tabs exceed viewport width, horizontal scroll with CSS `overflow-x: auto` and `scroll-snap-type: x mandatory`.

### 2.4 Breadcrumb

```typescript
interface BreadcrumbSegment {
  label: string;
  path?: string;                   // If omitted, renders as plain text (current page)
}

interface BreadcrumbProps {
  segments: BreadcrumbSegment[];
  className?: string;
}
```

**Rendering**: Segments separated by `/` character. All segments except the last are clickable `<Link>` elements. Last segment is `<span aria-current="page">`.

### 2.5 Tooltip

```typescript
interface TooltipProps {
  content: string;
  children: React.ReactElement;    // Trigger element
  side?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;                  // Show delay in ms, default 400
}
```

**State**: Internal `isVisible` boolean. Shows after `delay` ms on `mouseenter`/`focus`, hides on `mouseleave`/`blur`/`Escape`. Positioned with `position: absolute` relative to trigger wrapper.

### 2.6 EmptyState

```typescript
interface EmptyStateProps {
  icon?: React.ReactNode;
  heading: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}
```

**Rendering**: Centered layout with vertical stack: icon (48x48, muted color), heading (section-heading tier), description (secondary tier, muted), primary action button.

## 3. Navigation Structure

### 3.1 AppShell Component

```typescript
interface AppShellProps {
  children: React.ReactNode;       // Rendered in content area (or <Outlet />)
}
```

**Layout**:
- Desktop (>= 768px): `display: grid; grid-template-columns: 220px 1fr;`
  - Left column: Fixed sidebar with nav links + user menu
  - Right column: Main content area with scroll
- Mobile (< 768px): Single column. Sidebar hidden. Hamburger button in header opens MobileNavDrawer.

**Nav Items** (hardcoded in AppShell, not configurable):
1. Dashboard (`/dashboard`, icon: Home)
2. Projects (`/projects`, icon: FolderKanban)
3. Nodes (`/nodes`, icon: Server)
4. Settings (`/settings`, icon: Settings)

**Active State**: Determined by `useLocation().pathname.startsWith(item.path)`. Active item gets `background: var(--sam-color-bg-surface-hover)` and `color: var(--sam-color-accent-primary)`.

### 3.2 Route Structure (Updated)

```
/                                    → Landing (public, no AppShell)
/dashboard                           → AppShell > Dashboard
/projects                            → AppShell > Projects list
/projects/new                        → AppShell > ProjectCreate (NEW)
/projects/:id                        → AppShell > Project shell (Tabs + Outlet)
/projects/:id/                       → Redirect to /projects/:id/overview
/projects/:id/overview               → ProjectOverview (child route)
/projects/:id/tasks                  → ProjectTasks (child route)
/projects/:id/tasks/:taskId          → TaskDetail (child route)
/projects/:id/sessions               → ProjectSessions (child route)
/projects/:id/sessions/:sessionId    → ChatSessionView (child route)
/projects/:id/settings               → ProjectSettings (child route)
/projects/:id/activity               → ProjectActivity (child route)
/nodes                               → AppShell > Nodes list
/nodes/:id                           → AppShell > Node detail
/workspaces/new                      → AppShell > CreateWorkspace
/workspaces/:id                      → Workspace (NO AppShell, full-width)
/settings                            → AppShell > Settings shell (Tabs + Outlet)
/settings/                           → Redirect to /settings/cloud-provider
/settings/cloud-provider             → SettingsCloudProvider (child route)
/settings/github                     → SettingsGitHub (child route)
/settings/agent-keys                 → SettingsAgentKeys (child route)
/settings/agent-config               → SettingsAgentConfig (child route)
```

## 4. State Management

### 4.1 Navigation State

- **Sidebar open/closed (mobile)**: Internal state in AppShell, managed via `useState<boolean>`. Closed on route change via `useEffect` on `location.pathname`.
- **Active nav item**: Derived from `useLocation()` — no stored state needed.
- **Active project tab**: Derived from route path — no stored state needed.

### 4.2 Dropdown/Overlay State

All overlay components (DropdownMenu, Tooltip, MobileNavDrawer) manage their own `isOpen` state internally. No global overlay state management.

**Cleanup on unmount**: All event listeners (`mousedown`, `keydown`) removed in `useEffect` cleanup functions.

### 4.3 Onboarding Checklist State

```typescript
interface OnboardingState {
  hasHetznerToken: boolean;    // Derived from settings API response
  hasGitHubApp: boolean;       // Derived from settings API response
  hasWorkspace: boolean;       // Derived from workspaces list length > 0
  dismissed: boolean;          // Stored in localStorage(`sam-onboarding-dismissed-${userId}`)
}
```

**Visibility rule**: Show checklist when `!dismissed && (!hasHetznerToken || !hasGitHubApp || !hasWorkspace)`.

### 4.4 Entity List Actions

Current: Actions are inline buttons with callbacks passed from parent.
New: Actions are `DropdownMenuItem[]` arrays constructed per-entity based on status.

```typescript
function getWorkspaceActions(workspace: WorkspaceResponse, handlers: WorkspaceHandlers): DropdownMenuItem[] {
  const items: DropdownMenuItem[] = [];
  
  if (workspace.status === 'running') {
    items.push({ id: 'stop', label: 'Stop', onClick: () => handlers.onStop(workspace.id) });
  }
  if (workspace.status === 'stopped') {
    items.push({ id: 'restart', label: 'Restart', onClick: () => handlers.onRestart(workspace.id) });
  }
  items.push({
    id: 'delete',
    label: 'Delete',
    variant: 'danger',
    onClick: () => handlers.onDelete(workspace.id),
    disabled: workspace.status === 'creating' || workspace.status === 'stopping',
    disabledReason: 'Cannot delete while workspace is transitioning',
  });
  
  return items;
}
```

## 5. Reusable Hooks (New)

### 5.1 useClickOutside

```typescript
function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  callback: () => void,
  enabled?: boolean
): void;
```

Attaches `mousedown` listener to `document`. Calls `callback` when click target is outside `ref.current`. Listener only active when `enabled !== false`.

### 5.2 useEscapeKey

```typescript
function useEscapeKey(callback: () => void, enabled?: boolean): void;
```

Attaches `keydown` listener to `document`. Calls `callback` when `e.key === 'Escape'`. Listener only active when `enabled !== false`.
