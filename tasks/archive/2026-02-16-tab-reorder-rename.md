# Tab Reorder and Rename

**Created**: 2026-02-16
**Status**: Active
**Priority**: High
**Estimated Effort**: Medium

## Context

The workspace UI has a unified tab strip that combines terminal tabs and agent/chat session tabs. Currently, users cannot rename tabs, reorder tabs via drag-and-drop, and new tabs are inserted with unintuitive ordering — terminal tabs are always grouped to the left and chat tabs to the right, regardless of creation order. This makes the tab bar rigid and hard to organize for users with many sessions.

## Problems

### 1. No Tab Rename at Workspace Level

The terminal package's `TabItem` component already supports double-click-to-rename, but the workspace page hides the terminal package's `TabBar` (`hideTabBar={true}`) and renders its own custom tab strip that has **no rename affordance** for either terminal or chat tabs. Chat session labels are set at creation time ("Claude Code 1") and cannot be changed afterward.

### 2. No Drag-and-Drop Reordering

The infrastructure for reordering exists in the codebase:
- `TerminalSession.order` field tracks position
- `useTerminalSessions.reorderSessions(fromIndex, toIndex)` implements array-based reordering
- `TabItemProps.isDraggable` type is defined
- CSS classes `.terminal-tab.dragging` and `.terminal-tab.drag-over` exist in `terminal-tabs.css`
- VM agent SQLite store has `UpdateTabOrder()` for server-side persistence

However, **no drag event handlers are wired up** anywhere. The workspace-level tab strip has no drag-and-drop logic at all.

### 3. New Tabs Appear in Wrong Position

New chat tabs are appended after all terminal tabs (due to `[...terminalSessionTabs, ...chatSessionTabs]` in the `workspaceTabs` `useMemo`). If a user creates Terminal 1, Claude Code 1, Terminal 2, the order displayed is: Terminal 1, Terminal 2, Claude Code 1 — not the creation order. All new tabs should appear at the rightmost position regardless of type.

### 4. Terminal-First Ordering

The unified `workspaceTabs` array in `Workspace.tsx` (lines ~495-527) always places terminal tabs first, then chat tabs:

```typescript
return [...terminalSessionTabs, ...chatSessionTabs];
```

There is no interleaving. Users cannot organize tabs freely across types.

## Proposed Solution

### Library: `@dnd-kit`

Install `@dnd-kit/core`, `@dnd-kit/sortable`, and `@dnd-kit/utilities` in the web app. This is the best fit because:

- **Hooks-based API** aligns with the project's React 18 patterns
- **~10kb minified** for `@dnd-kit/core`, zero external dependencies
- **Built-in `horizontalListSortingStrategy`** designed for exactly this use case
- **Full accessibility**: keyboard sensors, screen reader announcements, ARIA live regions
- **No extra DOM wrappers** (unlike `@hello-pangea/dnd`'s render prop pattern)
- **Custom drag overlays** via `<DragOverlay>` for smooth ghost tab visuals
- **TypeScript-first** with full type definitions

### Architecture

#### Unified Tab Order Model

Replace the current terminal-first/chat-second split with a **single ordered list** of tabs. Each tab gets a `sortOrder` number that determines its position regardless of type.

The VM agent's SQLite `tabs` table already has a `sort_order` column and `UpdateTabOrder()` method. The shared types already have `WorkspaceTab.sortOrder`. The infrastructure is ready.

#### New Tab Insertion

All new tabs (terminal or chat) append at the rightmost position:
- `sortOrder = max(existing sort orders) + 1`
- Remove the `[...terminalTabs, ...chatTabs]` split in `workspaceTabs` useMemo
- Sort all tabs by `sortOrder` regardless of type

#### Rename Support

Port the double-click-to-rename pattern from `packages/terminal/src/components/TabItem.tsx` to the workspace-level tab strip:
- Double-click tab label enters inline edit mode
- Enter saves, Escape cancels, blur saves
- Max 50 characters
- Terminal renames call `multiTerminalRef.current?.renameSession()`
- Chat renames call a new `PATCH /api/workspaces/:id/agent-sessions/:sessionId` endpoint (or use the VM agent's `UpdateTabLabel`)

#### Drag-and-Drop

Wrap the workspace tab strip with `<DndContext>` + `<SortableContext>`:
- Each tab becomes a sortable item via `useSortable()`
- `onDragEnd` updates `sortOrder` for all tabs in the new order
- `<DragOverlay>` renders a ghost tab during drag
- `PointerSensor` with `distance: 5` activation constraint prevents accidental drags
- `KeyboardSensor` for accessible keyboard reordering

### UX Behavior

| Interaction | Behavior |
|-------------|----------|
| **Click tab** | Activate tab (existing) |
| **Double-click tab label** | Enter inline rename mode |
| **Drag tab** | Reorder within tab strip (5px dead zone) |
| **Drop tab** | Animate to new position, persist order |
| **Create new tab** | Appears at rightmost position |
| **Ctrl+Tab / Ctrl+Shift+Tab** | Cycle tabs in visual order (existing) |
| **Cmd/Ctrl+1-9** | Jump to tab by visual position (existing) |

### Accessibility

- `aria-roledescription="sortable"` on each tab
- `aria-describedby` pointing to drag instructions text
- ARIA live region for screen reader announcements ("Picked up Tab 1, position 1 of 5")
- `KeyboardSensor`: Space to pick up, Arrow keys to move, Space to drop, Escape to cancel
- Focus order updates after reorder

## Implementation Checklist

### Phase 1: Unified Tab Order (Fix Insertion + Ordering)
- [x] Refactor `workspaceTabs` useMemo to use a single sorted list by `sortOrder` instead of `[...terminal, ...chat]`
- [x] Assign `sortOrder` to all tabs (terminal and chat) based on creation time
- [x] Ensure new terminal tabs get `sortOrder = max + 1` (rightmost)
- [x] Ensure new chat tabs get `sortOrder = max + 1` (rightmost)
- [x] Persist unified tab order (coordinate between client-side sessionStorage and VM agent SQLite)
- [x] Update keyboard shortcuts (Ctrl+Tab, Cmd+1-9) to use the new unified order
- [x] Add unit tests for unified ordering logic

### Phase 2: Tab Rename
- [x] Add double-click-to-rename to workspace-level tab strip (port from `TabItem.tsx`)
- [x] Wire terminal tab rename to `multiTerminalRef.current?.renameSession()`
- [x] Add API endpoint or mechanism for renaming chat session labels
- [x] Wire chat tab rename to the API
- [x] Add unit tests for rename behavior (enter edit mode, save, cancel, max length)
- [x] Verify mobile usability (touch-friendly rename trigger — possibly long-press or context menu)

### Phase 3: Drag-and-Drop Reordering
- [x] Install `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`
- [x] Wrap workspace tab strip with `<DndContext>` + `<SortableContext>`
- [x] Make each tab a sortable item with `useSortable()`
- [x] Add `<DragOverlay>` for ghost tab visual
- [x] Configure `PointerSensor` with `distance: 5` activation constraint
- [x] Configure `KeyboardSensor` for accessible reordering
- [x] Add custom screen reader announcements via `DndContext.accessibility`
- [x] Wire `onDragEnd` to update `sortOrder` for all tabs and persist
- [x] Add CSS for drag states (opacity, cursor, drop indicator)
- [x] Add unit tests for reorder logic
- [ ] Verify mobile drag behavior (touch sensors)
- [ ] Visually verify on mobile viewport via Playwright

### Phase 4: Polish
- [ ] Add right-click context menu with "Rename", "Close", "Close Others" options
- [ ] Ensure tab overflow/scroll behavior works with drag-and-drop
- [ ] Test multi-viewer behavior (reorder/rename syncs across tabs/devices)
- [ ] Update keyboard shortcuts help overlay if any shortcuts change
- [x] Constitution compliance check (no hardcoded values)
- [x] Documentation sync (CLAUDE.md recent changes, keyboard shortcuts)

## Technical Notes

- The VM agent's SQLite `tabs` table already has `sort_order`, `label`, and CRUD methods — use this as the persistence layer
- The existing `reorderSessions(fromIndex, toIndex)` in `useTerminalSessions` can be adapted for the unified model
- Chat session label updates may need a new `PATCH /api/workspaces/:id/agent-sessions/:sessionId` endpoint with `{ label }` body
- The workspace-level tab strip is inline JSX in `Workspace.tsx` (~lines 1080-1210) — consider extracting it to a dedicated `WorkspaceTabBar` component for maintainability
- `@dnd-kit/core` is ~10kb minified, `@dnd-kit/sortable` is ~3.5kb — minimal bundle impact

## Related Files

- `apps/web/src/pages/Workspace.tsx` — Main workspace page with unified tab strip (~lines 70-83 types, ~495-527 tab list, ~1080-1210 rendering)
- `packages/terminal/src/components/TabItem.tsx` — Existing double-click rename implementation (port from here)
- `packages/terminal/src/components/TabBar.tsx` — Terminal tab bar (hidden at workspace level)
- `packages/terminal/src/hooks/useTerminalSessions.ts` — Session state, `reorderSessions()`, `renameSession()`
- `packages/terminal/src/types/multi-terminal.ts` — `isDraggable`, `isReordering` types
- `apps/web/src/styles/terminal-tabs.css` — Existing `.dragging` and `.drag-over` CSS classes
- `packages/shared/src/types.ts` — `WorkspaceTab` shared type with `sortOrder`
- `packages/vm-agent/internal/persistence/store.go` — `UpdateTabOrder()`, `UpdateTabLabel()`, `InsertTab()`, `ListTabs()`
- `apps/web/src/lib/keyboard-shortcuts.ts` — Tab navigation shortcuts
- `apps/web/src/hooks/useKeyboardShortcuts.ts` — Shortcut hook

## Success Criteria

- [ ] New tabs (terminal or chat) always appear at the rightmost position
- [ ] Tabs can be freely reordered via drag-and-drop regardless of type (no terminal-first grouping)
- [ ] Tabs can be renamed via double-click (both terminal and chat tabs)
- [ ] Tab order and names persist across page refresh and reconnection
- [ ] Drag-and-drop is accessible via keyboard (space to grab, arrows to move, space to drop)
- [ ] Screen readers announce drag state changes
- [ ] Mobile: drag works via touch, rename is accessible (long-press or context menu fallback)
- [ ] All existing tab keyboard shortcuts (Ctrl+Tab, Cmd+1-9) use the new unified order
- [ ] Unit tests cover ordering, rename, and reorder logic
- [ ] Mobile visual verification via Playwright passes
