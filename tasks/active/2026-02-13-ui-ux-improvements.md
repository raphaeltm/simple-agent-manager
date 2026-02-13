# UI/UX Improvements: Dashboard Nav, Node Page, Workspace Sessions

**Created**: 2026-02-13
**Status**: active

## Summary

A collection of UI/UX improvements spanning three areas:
1. Dashboard/Node page fixes (padding, navigation, conditional form fields)
2. Workspace session tab unification (same experience desktop + mobile, remove agents bar)
3. VM Agent session persistence (SQLite for cross-device "pick up where you left off")

## Requirements

### Phase 1: Dashboard & Node Page Fixes
1. **Node detail card padding** — The card with node details on the individual node page has no padding/is squished
2. **Back navigation** — No clear way to get back from node page to dashboard (currently have to click profile/UserMenu which is unintuitive)
3. **Hide size/location in workspace creation** — When an existing node is selected, the VM size and location fields should be hidden (they only apply to auto-created nodes)

### Phase 2: Workspace Session UX Overhaul
1. **Remove standalone "agents" bar** — Agent selection should happen when starting a new chat, not as a separate bar
2. **Unified tab experience** — Desktop and mobile should have the same tab strip at the top of the workspace content area. Mobile currently has a different bottom-bar UX with Terminal/Chat/Agent tabs — this should be replaced with the same tab system as desktop
3. **Fix multi-chat sessions** — Opening more than one chat gets "wacky". Each chat session should be fully independent, both client-side (separate ACP WebSocket connections) and server-side (separate gateway instances)

### Phase 3: VM Agent SQLite Persistence
1. **Add SQLite to VM Agent** — Persist session/tab state so users can close browser and resume
2. **Cross-device continuity** — User should be able to go from computer to phone and "pick up where they left off"
3. **Persist**: active tabs (terminal + chat), tab order, agent preferences, session metadata

## Plan

### Phase 1: Dashboard & Node Page Fixes (Simple)

**File: `apps/web/src/pages/Node.tsx`**
- The node detail `<section>` at line 156-175 already has `padding: 'var(--sam-space-5)'` — need to check if there's additional info being cut off or if it needs more padding. Looking at the code, the card is quite minimal (name + status badges + heartbeat). The issue might be that the grid has `gap: 'var(--sam-space-2)'` which is tight. Also `h2` has minimal margins.
- Add proper padding and spacing to make the card breathe

**Navigation: Add "Back to Dashboard" and breadcrumb-style nav**
- Node page currently has "Back to Nodes" button but no way to get to Dashboard
- Add a "Dashboard" link/button or breadcrumb trail
- Consider adding a simple header nav across all pages: Dashboard | Nodes | Settings

**File: `apps/web/src/pages/CreateWorkspace.tsx`**
- Size/location fields (lines 255-305) should be conditionally rendered based on `selectedNodeId`
- When `selectedNodeId` is set (existing node), hide the VM size and location sections
- The labels already say "(for auto-create)" which is a hint they're irrelevant for existing nodes

### Phase 2: Workspace Session UX Overhaul (Complex)

**Current State Analysis:**
- **Desktop**: Has a tab strip (lines ~782-1034 in Workspace.tsx) with terminal + chat tabs, plus a dropdown to create new sessions. Also has an AgentSelector bar below the toolbar.
- **Mobile**: Has a MobileBottomBar (Terminal/Chat/Agent tabs) with no tab strip. Completely different UX.
- **Problem**: Mobile has no way to manage multiple sessions. Desktop has both tabs AND an agent bar (redundant).

**Target State:**
- Single unified tab experience for both desktop and mobile
- Tab strip at top of content area (both breakpoints)
- "+" dropdown creates terminal or chat session (chat asks which agent)
- No separate agent bar/agent bottom tab
- Each chat tab is independent (own ACP WebSocket)

**Implementation approach:**
1. Remove `AgentSelector` component usage from Workspace.tsx
2. Remove `MobileBottomBar` component usage from Workspace.tsx
3. Remove `MobileOverflowMenu` component and move its actions elsewhere (inline in header or tab actions)
4. Make the tab strip render on mobile too (responsive sizing, horizontal scroll)
5. Move workspace actions (stop/restart) to the header on both layouts
6. Keep mobile header simple (back button, name, actions)

**Multi-chat independence:**
- Current: Single `useAcpSession` hook manages one ACP WebSocket → shared across all chat tabs
- Target: Each chat tab gets its own `useAcpSession` hook instance → separate WebSocket per session
- This requires refactoring chat tabs into separate component instances that each own their ACP connection
- Server-side: Already supports per-session gateways (`acpGateways[workspaceID:sessionID]`)

**Component refactor plan:**
1. Extract `ChatTabContent` component — self-contained chat panel with its own ACP hook
2. Extract `TerminalTabContent` component — self-contained terminal (already mostly there)
3. Tab strip becomes the orchestrator — manages which tab is active, creates/closes tabs
4. Each `ChatTabContent` mounts/unmounts its own WebSocket connection

### Phase 3: VM Agent SQLite Persistence (Architectural)

**Current State:** All session state is in-memory Go maps. Lost on VM restart.
**Target:** SQLite database on the VM persists session metadata.

**What to persist:**
- Tab list (terminal + chat, with order)
- Session metadata (session ID, type, label, agent type, created timestamp)
- Agent preference per session
- Active tab selection

**What NOT to persist:**
- Terminal output (ring buffer stays in-memory — too much data)
- ACP WebSocket state (ephemeral by nature)
- Agent process state (must be respawned)

**Implementation:**
1. Add `mattn/go-sqlite3` or `modernc.org/sqlite` (pure Go, no CGO) to VM Agent
2. Create a `persistence` package with schema + CRUD
3. On terminal/chat create: write to DB
4. On terminal/chat close: update DB
5. On startup: load tabs from DB, present to connecting clients
6. New API endpoint: `GET /api/workspaces/:id/tabs` — returns persisted tab state
7. Client loads tab state from API on connect instead of only from localStorage

## Checklist

### Phase 1: Dashboard & Node Page Fixes
- [x] Fix node detail card padding/spacing — added proper padding, grid layout for node metadata (size, location, IP, heartbeat, created), error message display
- [x] Add navigation from node page back to dashboard — added breadcrumb nav (Dashboard / Nodes / NodeName)
- [x] Conditionally hide VM size/location when existing node selected in CreateWorkspace — wrapped in `{!selectedNodeId && (...)}`, also cleaned up labels (removed "(for auto-create)" suffix)
- [ ] Verify on mobile viewport

### Phase 2: Workspace Session UX Overhaul
- [x] Audit current desktop tab strip code
- [x] Remove AgentSelector bar from workspace view
- [x] Remove MobileBottomBar from workspace view
- [x] Make tab strip responsive for mobile (horizontal scroll, appropriate sizing)
- [x] Move workspace actions from mobile overflow menu to unified header — stop/restart buttons now in unified header, error banner on mobile
- [x] Extract ChatTabContent component with independent ACP WebSocket — `ChatSession.tsx` component, each instance owns its own `useAcpSession` + `useAcpMessages`
- [x] Extract TerminalTabContent component — terminal content stays in Workspace.tsx (always mounted, shown/hidden), not extracted to separate component since it shares MultiTerminal ref
- [x] Update "+" dropdown: agent selection happens when creating a new chat — dropdown lists Terminal + configured agents
- [x] Test multiple chat sessions are fully independent — each ChatSession has own WebSocket via useAcpSession hook
- [ ] Verify mobile layout works with tab strip (manual/Playwright)
- [ ] Verify desktop layout still works (manual/Playwright)
- [x] Clean up unused mobile components (MobileBottomBar, MobileOverflowMenu, AgentSelector, AgentSessionList, workspace-mobile.css) — deleted files + removed dead mocks from tests

### Phase 3: VM Agent SQLite Persistence
- [ ] Choose SQLite library (pure Go preferred)
- [ ] Design persistence schema
- [ ] Implement persistence package
- [ ] Integrate with terminal session create/close
- [ ] Integrate with agent session create/close
- [ ] Add API endpoint for tab state
- [ ] Client-side: load tab state from API on connect
- [ ] Test cross-device continuity
- [ ] Handle schema migrations

## Implementation Notes

### Phase 1 (Completed)
- **Node.tsx**: Added breadcrumb nav (Dashboard / Nodes / NodeName), enhanced node detail card with metadata grid (Size, Location, IP, Heartbeat, Created), error message display. Increased padding from `--sam-space-5` to `--sam-space-6`.
- **CreateWorkspace.tsx**: Wrapped VM size/location in `{!selectedNodeId && (...)}`. Simplified labels.
- Tests updated: `getAllByText('Node 1')` for breadcrumb+heading duplication, `getByText('Last Heartbeat')` for new grid label.

### Phase 2 (Completed)
- **ChatSession.tsx** (new): Self-contained chat component. Each instance owns its own `useAcpSession` + `useAcpMessages` hooks = independent WebSocket per chat tab. Auto-selects preferred agent on connect.
- **Workspace.tsx** (rewrite): Unified responsive layout replaces separate desktop/mobile branches. Single header with responsive sizing (44px mobile / 40px desktop). Tab strip renders on both viewports with touch-friendly sizing. Mobile error banner. Sidebar hidden on mobile.
- **Deleted files**: AgentSelector.tsx, MobileBottomBar.tsx, MobileOverflowMenu.tsx, AgentSessionList.tsx, workspace-mobile.css
- **Test fixes**: Updated `useAcpMessages` mock to include `items: []`, removed dead component mocks, provided running session for takeover URL test.
- All 41 tests passing across 12 test files.

## Issues & Failures

_Issues will be recorded here as they occur._
