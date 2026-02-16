# Workspace Keyboard Shortcuts

**Status:** backlog
**Priority:** medium
**Estimated Effort:** 1 week
**Created:** 2026-02-16

## Problem Statement

The workspace UI has ~65 interactive behaviors but almost none are keyboard-accessible. The only existing bindings are Enter to send chat, arrow keys for chat history, and Escape to close overlays. Terminal tab bar shortcuts exist in code but are unreachable because `hideTabBar={true}`.

Developers expect VS Code-style keyboard shortcuts for navigation and panel management. Without them, users must mouse-click to switch tabs, open the file browser, open git changes, and manage sessions — slowing down their workflow significantly.

## Proposed Solution

Add a comprehensive keyboard shortcut system to the workspace UI, following VS Code conventions where possible. Implement a centralized shortcut registry with a discoverable help overlay.

## Behavior Inventory

### Phase 1 — Global Navigation (Highest Impact)

| Behavior | Current Trigger | Shortcut | Type |
|----------|----------------|----------|------|
| Open/close File Browser | Click nav icon | `Cmd+Shift+E` | Toggle |
| Open/close Git Changes | Click nav icon | `Cmd+Shift+G` | Toggle |
| Focus chat input | Click input | `Cmd+/` | Focus |
| Focus terminal | Click terminal area | `` Cmd+` `` | Focus |

### Phase 2 — Session/Tab Management

| Behavior | Current Trigger | Shortcut | Type |
|----------|----------------|----------|------|
| Next session tab | Click tab | `Ctrl+Tab` | Navigation |
| Previous session tab | Click tab | `Ctrl+Shift+Tab` | Navigation |
| Switch to tab by number | Click tab | `Cmd+1` through `Cmd+9` | Navigation |
| New chat session | Click `+` dropdown | `Cmd+N` | Action |
| New terminal session | Click `+` dropdown | `Cmd+Shift+T` | Action |
| Close/stop current session | Click stop button | `Cmd+W` | Action |

### Phase 3 — In-Panel & Help

| Behavior | Current Trigger | Shortcut | Type |
|----------|----------------|----------|------|
| Show shortcut help | None | `Cmd+Shift+/` or `?` | Overlay |
| Navigate up directory (file browser) | Click breadcrumb | `Backspace` (when focused) | Navigation |
| Close overlay panel | Click close/outside | `Escape` | Dismiss (exists) |
| Toggle voice input | Click mic button | `Cmd+Shift+V` | Toggle |
| Return to dashboard | Click nav link | `Cmd+Shift+D` | Navigation |

## Implementation Plan

### 1. Shortcut Registry (`useKeyboardShortcuts` hook)
- Centralized shortcut registration and dispatch
- Platform-aware: `Cmd` on macOS, `Ctrl` on Windows/Linux
- Prevent conflicts with terminal/xterm key handling
- Shortcuts disabled when terminal is focused (except global ones)
- **File:** `apps/web/src/hooks/useKeyboardShortcuts.ts`

### 2. Shortcut Definitions
- Declarative shortcut map with key combo, handler, description, and category
- **File:** `apps/web/src/lib/keyboard-shortcuts.ts`

### 3. Help Overlay Component
- Modal showing all available shortcuts grouped by category
- Triggered by `Cmd+Shift+/` or `?` (when not in input)
- **File:** `apps/web/src/components/KeyboardShortcutsHelp.tsx`

### 4. Integration Points
- `WorkspacePage` — register global shortcuts, session tab switching
- `SessionTabs` / `AgentPanel` — session management shortcuts
- `FileBrowserOverlay` — file browser toggle
- `GitChangesOverlay` — git panel toggle
- `TerminalView` — focus management, bypass when terminal focused

## Testing Strategy

### Unit Tests
- [ ] Shortcut registry correctly maps key combos to handlers
- [ ] Platform detection (Cmd vs Ctrl)
- [ ] Shortcuts fire correct handlers
- [ ] Shortcuts suppressed when terminal is focused
- [ ] Shortcuts suppressed when typing in inputs (except global ones)
- [ ] Help overlay renders all registered shortcuts

### Integration Tests
- [ ] Panel toggles via keyboard
- [ ] Tab switching via keyboard
- [ ] Session creation via keyboard
- [ ] Focus management between chat and terminal

## Design Decisions

1. **VS Code conventions**: Developers already know these bindings — minimal learning curve
2. **Terminal passthrough**: When xterm is focused, most shortcuts must pass through to the terminal. Only explicitly global shortcuts (panel toggles with `Cmd+Shift` combos) should intercept
3. **No custom key binding**: MVP uses fixed shortcuts. User-configurable bindings are a future enhancement
4. **Platform-aware display**: Help overlay shows `⌘` on macOS, `Ctrl` on other platforms

## Dependencies
None — can be implemented independently.

## Success Criteria
- [ ] All Phase 1-3 shortcuts functional
- [ ] Help overlay discoverable and accurate
- [ ] No conflicts with terminal key handling
- [ ] No conflicts with browser default shortcuts
- [ ] Works on macOS and Windows/Linux
- [ ] Shortcuts display platform-appropriate modifier keys
