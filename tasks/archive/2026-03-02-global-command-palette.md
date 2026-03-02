# Global Command Palette (Cmd+K)

**Created**: 2026-03-02
**Priority**: Medium
**Classification**: `ui-change`, `cross-component-change`
**Supersedes**: `tasks/backlog/2026-02-23-global-command-palette.md` (prior sketch)

## Problem

The command palette (Cmd+K) only works inside workspace pages. Users need app-wide quick navigation — jumping to projects, nodes, settings, and performing common actions from anywhere in the app. The palette should look and feel like the workspace one but without workspace-specific items (files, terminal tabs).

## Research Findings

### Existing Architecture
- **CommandPalette.tsx**: Custom fuzzy-search palette (no cmdk dependency). Searches tabs, files, commands. Uses `fuzzy-match.ts` for scoring.
- **Mounted only in** `Workspace.tsx` — keyboard listener (`useKeyboardShortcuts`) only active when workspace is running.
- **AppShell.tsx**: Wraps all protected routes except workspace pages. Has no command palette or Cmd+K listener.
- **keyboard-shortcuts.ts**: Registry of workspace-specific shortcuts. No global/navigation shortcuts defined.
- **NavSidebar.tsx**: Static nav items — Dashboard, Projects, Nodes, Settings, Admin (superadmin).

### Key Patterns
- Tokyo Night colors (`tn-*`) for workspace palette; SAM palette (`sam-*`) for app shell
- `fuzzyMatch()` from `lib/fuzzy-match.ts` — camelCase + word boundary aware
- `useKeyboardShortcuts` hook registers on window keydown (capture phase)
- API functions: `listProjects()`, `listNodes()` available in `lib/api.ts`

### Design Decisions
- New `GlobalCommandPalette.tsx` component (keep workspace palette separate — different concerns)
- Mount in `AppShell` with its own Cmd+K listener
- Use SAM palette colors (not Tokyo Night) since it lives in the app shell context
- Dynamic search: fetch projects/nodes on palette open, fuzzy-filter client-side
- Categories: Navigation, Projects, Nodes, Actions
- In workspace context, workspace palette takes priority (already captures Cmd+K)

## Checklist

- [ ] Create `GlobalCommandPalette.tsx` with same UX patterns as workspace palette
- [ ] Define global command categories: Navigation (pages), Projects (dynamic), Nodes (dynamic), Actions (new project, settings)
- [ ] Add Cmd+K listener in AppShell (only when no workspace palette active)
- [ ] Fetch projects and nodes on palette open for dynamic search
- [ ] Apply SAM design tokens (not Tokyo Night) for app shell context
- [ ] Add visual keyboard hint (Cmd+K badge) in sidebar or header
- [ ] Write behavioral tests (render, search, keyboard nav, execute navigation)
- [ ] Ensure workspace palette still takes priority on workspace pages
- [ ] Run typecheck, lint, build

## Acceptance Criteria

- [ ] Cmd+K opens command palette on any AppShell page (dashboard, projects, nodes, settings)
- [ ] Palette shows navigation items, projects, and nodes with fuzzy search
- [ ] Selecting a result navigates to the correct page
- [ ] Keyboard navigation (arrows, Enter, Escape) works identically to workspace palette
- [ ] Workspace pages still use the workspace-specific palette
- [ ] Behavioral tests cover: rendering, fuzzy search, keyboard nav, result execution, close behaviors
