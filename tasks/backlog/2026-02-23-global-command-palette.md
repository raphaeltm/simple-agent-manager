# Add Global Command Palette Navigation

**Created**: 2026-02-23
**Priority**: Low
**Classification**: `ui-change`, `cross-component-change`

## Context

The command palette (Cmd+K / Ctrl+K) currently only works inside workspace context. The user wants it to be usable throughout the app for global navigation — navigating to projects, settings, nodes, etc. From outside a workspace, it shouldn't load workspace-specific items (files, terminal tabs) but should provide navigation to all app pages and entities.

## Current Implementation

### Component
- **File**: `apps/web/src/components/CommandPalette.tsx` (1-500+ lines)
- Searches: tabs (workspace sessions), files (workspace file index), commands (keyboard shortcuts)

### Mounting
- **Only in**: `apps/web/src/pages/Workspace.tsx` (lines 2100-2110)
- Receives workspace-specific props: `handlers`, `tabs`, `fileIndex`, `onSelectTab`, `onSelectFile`
- Keyboard shortcut listener (`useKeyboardShortcuts`) only active when `isRunning === true`

### Router Structure
- `AppShell` wraps protected routes (Dashboard, Projects, Nodes, Settings)
- Workspace pages are separate (full-width, no AppShell sidebar)
- **No global command palette** exists in AppShell

### Keyboard Shortcuts
- Defined in `apps/web/src/lib/keyboard-shortcuts.ts` (lines 80-125)
- All shortcuts are workspace-centric (toggle file browser, focus chat, etc.)

## Plan

1. Create a global command palette that works in AppShell context
2. Add app-level navigation commands (Go to Dashboard, Projects, Settings, Nodes, specific projects)
3. Mount global keyboard listener (Cmd+K) in AppShell
4. In workspace context, overlay workspace-specific commands on top of global ones
5. Keep the existing workspace command palette functionality intact

## Detailed Tasklist

- [ ] Read `apps/web/src/components/CommandPalette.tsx` to understand current structure
- [ ] Read `apps/web/src/components/AppShell.tsx` to understand the app layout
- [ ] Create a `GlobalCommandPalette.tsx` component (or refactor existing to support both modes)
- [ ] Define global navigation commands: Go to Dashboard, Projects, Nodes, Settings, Admin
- [ ] Add dynamic project/node search results (fetch from API on query)
- [ ] Mount the global command palette in `AppShell` with Cmd+K listener
- [ ] In workspace context, extend the existing palette with global commands as a fallback section
- [ ] Add React Router navigation (`useNavigate`) for executing navigation commands
- [ ] Ensure no workspace-specific items (files, terminal tabs) load outside workspace context
- [ ] Add keyboard shortcut hint to the navigation sidebar or header
- [ ] Run build: `pnpm --filter @simple-agent-manager/web build`
- [ ] Run typecheck: `pnpm typecheck`

## Files to Modify

| File | Change |
|------|--------|
| `apps/web/src/components/AppShell.tsx` | Mount global command palette + Cmd+K listener |
| `apps/web/src/components/CommandPalette.tsx` | Refactor to support global mode |
| `apps/web/src/components/GlobalCommandPalette.tsx` | New component (or merged into existing) |
| `apps/web/src/lib/keyboard-shortcuts.ts` | Add global navigation commands |
| `apps/web/src/pages/Workspace.tsx` | Integrate global commands with workspace palette |
