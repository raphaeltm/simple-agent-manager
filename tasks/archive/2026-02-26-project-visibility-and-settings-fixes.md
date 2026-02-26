# Project Visibility & Settings Drawer Fixes

**Created**: 2026-02-26
**Priority**: High
**Scope**: apps/web, packages/ui

## Problem Statement

Three related UX issues degrade the project page experience:

### 1. No way to see workspace/task status after page refresh

After submitting a task from the project chat page, the user sees a provisioning indicator inline. But if they refresh the page or navigate away and come back, there's no visible way to check on active workspaces, running tasks, or node infrastructure for that project. The old tabbed UI (Overview, Tasks, Kanban, Activity) had this information but was removed in the chat-first simplification (spec 022). The routes still exist but are completely hidden from navigation.

### 2. Missing "power user" access to project management views

The simplified chat-first UI hides workspace management, task lists, kanban boards, and activity feeds. Power users who need visibility into infrastructure (which node is running, workspace status, task execution steps) have no way to access these views without manually typing URLs.

### 3. Settings drawer has transparent background

The SettingsDrawer component uses `var(--sam-color-bg-page)` for its background, but this CSS variable is **not defined** in the theme tokens (`packages/ui/src/tokens/theme.css`). Undefined CSS variables resolve to `transparent`, making the drawer content unreadable as the page content shows through. Additionally, the backdrop uses hardcoded `rgba(0, 0, 0, 0.3)` instead of the theme variable `var(--sam-color-bg-overlay)`, and z-index values are hardcoded instead of using theme tokens.

## Solution

### Fix 1: Add project info panel to project page

Add a collapsible/expandable info panel to the project page that shows:
- Active workspaces with status indicators
- Recent tasks with status (queued/in_progress/completed/failed)  
- Quick links to workspace terminal (for running workspaces)
- Node info (which node, VM size)

This panel should be accessible via a dedicated button in the project header (e.g., an "info" or "activity" icon next to the settings gear). It should be non-intrusive and not interfere with the chat-first workflow.

### Fix 2: Add project management links to settings drawer

Add a "Project Views" or "Advanced" section to the SettingsDrawer with links to:
- Overview (`/projects/:id/overview`) — workspace list, launch workspace
- Tasks (`/projects/:id/tasks`) — task filtering and management
- Activity (`/projects/:id/activity`) — event feed

These are power-user views that already exist as routes but have no navigation path.

### Fix 3: Fix settings drawer background

1. Define `--sam-color-bg-page` in theme.css (map to `--sam-color-bg-surface` or define as appropriate solid color)
2. Replace hardcoded backdrop color with `var(--sam-color-bg-overlay)`
3. Replace hardcoded z-index values with theme z-index variables
4. Audit and fix all other components using `--sam-color-bg-page` (TaskSubmitForm, ProjectMessageView, ProjectChat, TaskDetail)

## Implementation Checklist

### Theme & Styling
- [ ] Define `--sam-color-bg-page` in `packages/ui/src/tokens/theme.css`
- [ ] Verify all components using `--sam-color-bg-page` render correctly after fix
- [ ] Fix SettingsDrawer backdrop to use `var(--sam-color-bg-overlay)`
- [ ] Fix SettingsDrawer z-index values to use theme tokens

### Settings Drawer Enhancement
- [ ] Add "Project Views" section to SettingsDrawer with links to hidden routes
- [ ] Links: Overview, Tasks, Activity (open in same tab, close drawer)
- [ ] Style links consistently with drawer design

### Project Info Panel
- [ ] Create ProjectInfoPanel component showing active workspaces and recent tasks
- [ ] Add toggle button to project header (info/activity icon)
- [ ] Show workspace status with indicators (running, stopped, creating)
- [ ] Show recent tasks with status badges
- [ ] Show workspace "Open Terminal" links for running workspaces
- [ ] Make panel collapsible/dismissable

### Testing
- [ ] Add/update unit tests for SettingsDrawer changes
- [ ] Add/update unit tests for ProjectInfoPanel
- [ ] Verify theme variable consistency across all affected components
- [ ] Manual verification of drawer background fix
- [ ] Manual verification of info panel with real project data

### Documentation
- [ ] Update CLAUDE.md if any new patterns introduced

## Files to Modify

- `packages/ui/src/tokens/theme.css` — Add missing CSS variable
- `apps/web/src/components/project/SettingsDrawer.tsx` — Fix backgrounds, z-index, add links
- `apps/web/src/pages/Project.tsx` — Add info panel toggle
- `apps/web/src/components/chat/ProjectMessageView.tsx` — Fix bg-page usage
- `apps/web/src/pages/ProjectChat.tsx` — Fix bg-page usage
- `apps/web/src/components/task/TaskSubmitForm.tsx` — Fix bg-page usage
- New: `apps/web/src/components/project/ProjectInfoPanel.tsx` — New info panel component

## Acceptance Criteria

1. After submitting a task and refreshing the page, user can see workspace/task status via the info panel
2. Power users can navigate to Overview/Tasks/Activity from the settings drawer
3. Settings drawer has solid background with proper overlay
4. All existing functionality continues to work (chat submission, session sidebar, etc.)
5. No hardcoded colors or z-index values in modified components
