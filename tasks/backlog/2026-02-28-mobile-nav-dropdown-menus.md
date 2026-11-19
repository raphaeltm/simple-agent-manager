# Mobile Nav Bar: Use Dropdown Menus in Workspace View

> **Reconciliation 2026-10-12:** Pointer correction only; nothing this week touched the scope.
> `apps/web/src/pages/Workspace.tsx` and `apps/web/src/components/workspace/` no longer exist.
> #592 (`512510d87`) moved the workspace nav bar to
> `apps/web/src/pages/workspace/WorkspaceHeader.tsx`. On mobile it still shows separate icon
> buttons for worktrees, files, git changes and the command palette, plus a button that opens the
> "Workspace menu" drawer (`WorkspaceHeader.tsx:178-264`; drawer at `workspace/index.tsx:579`).
> Still open: group the secondary actions into one dropdown.

**Created**: 2026-02-28
**Status**: Backlog
**Priority**: Medium
**Estimated Effort**: Small

## Problem

The navigation bar on mobile has too many elements in the workspace view, making it crowded and hard to use. The current layout tries to show all actions inline, which doesn't scale on small screens.

## Proposed Solution

Make better use of dropdown menus to consolidate workspace-specific actions. Group related actions (e.g., workspace controls, settings) into dropdown menus triggered by a single icon button, reducing the number of top-level nav bar items on mobile.

## Context

This is a follow-up to the mobile chat UX overhaul (`tasks/archive/2026-02-28-mobile-chat-ux-overhaul.md`). That task addresses the project/chat views; this task specifically targets the workspace view's nav bar density.

## Files Likely Involved

- `apps/web/src/pages/Workspace.tsx`
- `apps/web/src/components/AppShell.tsx`
- Possibly `apps/web/src/components/workspace/` components

## Implementation Notes

- Gate all changes behind `useIsMobile()` — desktop layout unchanged
- Reuse existing dropdown/popover patterns from the codebase
- Consider which actions are primary (always visible) vs. secondary (in dropdown)
