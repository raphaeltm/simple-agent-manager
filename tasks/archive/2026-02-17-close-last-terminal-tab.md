# Close Last Terminal Tab Instead of Empty State

**Created**: 2026-02-17
**Size**: Small
**Area**: UI (`apps/web`)

## Problem

When the user closes the last terminal session, a synthetic "empty" terminal tab persists in the tab strip showing "No terminal sessions" with a "Create New Terminal" button. This feels broken — the user explicitly closed the tab but it won't go away. The `+` button in the tab strip already provides a way to create a new terminal, so the empty state is redundant.

## Current Behavior

1. User closes last real terminal session
2. `terminalTabs` becomes `[]`
3. `visibleTerminalTabs` memo creates a synthetic tab with ID `__default-terminal__`
4. Tab strip renders this unclosable phantom tab
5. Content area shows "No terminal sessions" + "Create New Terminal"

## Desired Behavior

1. User closes last terminal session
2. Terminal tab disappears from the tab strip entirely
3. Focus moves to the next available tab (chat session, or nothing if no tabs remain)
4. User can create a new terminal via the `+` dropdown in the tab strip

## Key Files

| File | Lines | What to Change |
|------|-------|---------------|
| `apps/web/src/pages/Workspace.tsx` | L692-713 | Remove the synthetic default tab fallback from `visibleTerminalTabs` |
| `apps/web/src/pages/Workspace.tsx` | L1204 | Remove `unclosableTabId` prop from `WorkspaceTabStrip` |
| `apps/web/src/pages/Workspace.tsx` | L676-687 | Remove the `DEFAULT_TERMINAL_TAB_ID` guard in `handleCloseWorkspaceTab` |
| `apps/web/src/pages/Workspace.tsx` | L76 | `DEFAULT_TERMINAL_TAB_ID` constant — can be removed if no longer needed |
| `apps/web/src/components/WorkspaceTabStrip.tsx` | L180-191 | Remove `unclosableTabId` prop and related close-button hiding logic |
| `packages/terminal/src/MultiTerminal.tsx` | L668-696 | Empty state UI — may no longer be reachable; remove or keep as defensive fallback |

## Implementation Plan

- [ ] Remove the synthetic default terminal tab from `visibleTerminalTabs` — when `terminalTabs.length === 0`, return `[]`
- [ ] Remove `unclosableTabId` prop from `WorkspaceTabStrip` and its internal logic
- [ ] Remove the `DEFAULT_TERMINAL_TAB_ID` guard in `handleCloseWorkspaceTab` so all terminal tabs are closable
- [ ] When the last terminal tab closes, auto-select the next available tab (nearest chat tab, or clear active tab)
- [ ] Handle the "no tabs at all" state gracefully — if both terminal and chat tabs are empty, show a clean workspace landing (or just the `+` button prompt)
- [ ] Clean up `DEFAULT_TERMINAL_TAB_ID` constant if no longer referenced
- [ ] Remove or simplify the empty state in `MultiTerminal.tsx` if it becomes unreachable
- [ ] Add tests for: closing last terminal removes tab, focus moves correctly, new terminal via `+` still works

## Edge Cases

- **Fresh workspace with no sessions yet**: On initial load before any terminal connects, there should still be a terminal tab showing connection progress — this is a different flow from "user closed all tabs" and needs to remain working
- **All tabs closed**: If user closes every terminal and chat tab, the workspace needs a sensible empty state (not a blank screen)

## Out of Scope

- Changing how chat tabs close
- Redesigning the tab strip or `+` dropdown
