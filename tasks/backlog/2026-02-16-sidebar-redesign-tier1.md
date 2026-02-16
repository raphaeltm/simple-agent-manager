# Sidebar Redesign — Tier 1: High-Value Info Sections

**Created**: 2026-02-16
**Status**: Backlog
**Priority**: High
**Estimated Effort**: Medium

## Context

The desktop right sidebar (320px, always visible) in the workspace page currently contains only three things:

1. Workspace rename input + "Rename" button
2. Lifecycle buttons (Rebuild/Stop/Restart)
3. A scrollable workspace events log (infrastructure events like heartbeats — low user value)

On mobile, this same content is accessed via the kebab (3-dot) menu as a slide-out overlay.

The sidebar is underutilized. All the data needed for much more useful content **already exists in memory or on the workspace response object** — no new API calls required.

## Problem Statement

Users have no at-a-glance view of:
- VM details (size, location, uptime, shutdown countdown) — buried or never shown
- Session health across tabs — must click through each tab to discover disconnects/errors
- Git change counts — requires opening the full-screen overlay just to check "did the agent commit?"
- Token usage across parallel agent sessions — `UsageIndicator` exists per-tab but is buried at the bottom of each chat

## Proposed Solution

Replace the current sidebar content with **collapsible accordion sections** (VS Code sidebar pattern). Each section has a chevron toggle header with an optional count badge. Lifecycle controls move to a compact header.

### Section 1: Workspace Info

Shows structured workspace metadata that's currently scattered or hidden.

| Field | Source | Notes |
|-------|--------|-------|
| Repository | `workspace.repository` | Clickable link to GitHub |
| Branch | `workspace.branch` | — |
| VM Size | `workspace.vmSize` | e.g., "cx22" |
| VM Location | `workspace.vmLocation` | e.g., "nbg1" |
| Uptime | Derived from `workspace.createdAt` or last restart | Live updating |
| Shutdown countdown | `workspace.shutdownDeadline` | Live countdown timer via `setInterval` |
| Node | `workspace.nodeId` | Link to node if relevant |

**Data source**: All fields already on `WorkspaceResponse`. Zero new API calls.

### Section 2: Sessions Status

Compact rows showing each tab's connection/agent state. Clicking a row activates that tab.

| Column | Terminal Tabs | Chat Tabs |
|--------|--------------|-----------|
| Status dot | green/yellow/red (connected/connecting/error) | green/yellow/red (running/prompting/error) |
| Name | Session name | Session label |
| State text | "connected", "reconnecting", "error" | "ready", "prompting", "replaying", "error" |

**Data source**: `workspaceTabs` already computed in `Workspace.tsx`. Terminal status from `MultiTerminalSessionSnapshot`. Agent status from `agentSessions` state.

### Section 3: Git Summary

Staged/unstaged/untracked counts with a "View Changes" button that opens the existing full-screen git overlay.

```
Staged: 2    Unstaged: 1    Untracked: 2
[View Changes]
```

**Data source**: `getGitStatus()` is already called and `gitChangeCount` is already computed. Store the full `GitStatusData` object (staged/unstaged/untracked arrays) instead of just the total count, then render the three counts.

**Change required**: In `Workspace.tsx`, store the full `GitStatusData` in state instead of (or in addition to) the derived count.

### Section 4: Token Usage

Per-session and aggregate token usage across all active chat sessions.

```
Claude Code 1:  12.4k in / 3.2k out
Claude Code 2:   8.1k in / 1.8k out
────────────────────────────────────
Total:          20.5k in / 5.0k out
```

**Data source**: `useAcpMessages()` already tracks `TokenUsage { inputTokens, outputTokens, totalTokens }` per session. The `formatTokens` function already exists in `UsageIndicator.tsx` inside `acp-client`.

**Change required**: Lift token usage from each `ChatSession` via an `onUsageChange` callback prop. Aggregate in `Workspace.tsx` state. Render in sidebar.

### Sidebar Header (Lifecycle Controls)

Replace the current rename input + lifecycle buttons with a compact header:

```
+-------------------------------------------+
| [workspace-icon] workspace-name    [Stop] |
+-------------------------------------------+
```

- Workspace name: double-click to rename inline (reuse pattern from tab rename)
- Primary lifecycle action as a single button (Stop when running, Restart when stopped)
- Secondary actions (Rebuild) available via a small dropdown or the workspace info section

### Workspace Events (Demoted)

The existing infrastructure events log moves to the bottom of the sidebar as a collapsed-by-default section. It's still accessible but no longer dominates the space.

## Implementation Checklist

### Infrastructure
- [ ] Create a `WorkspaceSidebar` component (extract from inline JSX in `Workspace.tsx`)
- [ ] Create a `CollapsibleSection` component for accordion sections (chevron + title + optional badge + collapse/expand)
- [ ] Persist collapse state in `localStorage` per section
- [ ] Wire `WorkspaceSidebar` into the desktop layout and mobile slide-out overlay

### Section: Workspace Info
- [ ] Render repository (as link), branch, VM size, VM location
- [ ] Add live uptime counter (derived from `createdAt` or last restart)
- [ ] Add live shutdown countdown timer (from `shutdownDeadline`, `setInterval`)
- [ ] Show node reference if applicable

### Section: Sessions Status
- [ ] Map over `workspaceTabs` to render compact status rows
- [ ] Color-coded status dots matching the tab strip dots
- [ ] Click row to activate that tab (reuse `handleSelectWorkspaceTab`)
- [ ] Show "(active)" indicator on the currently selected tab

### Section: Git Summary
- [ ] Store full `GitStatusData` in state (not just the count)
- [ ] Render staged/unstaged/untracked counts
- [ ] "View Changes" button opens the existing git changes overlay

### Section: Token Usage
- [ ] Add `onUsageChange` callback prop to `ChatSession`
- [ ] Aggregate token usage across all active sessions in `Workspace.tsx`
- [ ] Render per-session and total token counts
- [ ] Reuse `formatTokens` from `UsageIndicator.tsx` (may need to export it)

### Sidebar Header
- [ ] Compact workspace name with inline rename (double-click)
- [ ] Primary lifecycle button (Stop/Restart based on state)
- [ ] Secondary actions in dropdown or info section

### Events (Demoted)
- [ ] Move existing events rendering into a CollapsibleSection
- [ ] Default to collapsed

### Mobile
- [ ] Ensure the mobile slide-out overlay uses the same `WorkspaceSidebar` component
- [ ] Verify all sections have min 44px touch targets
- [ ] Verify collapsible sections work with touch
- [ ] Visually verify on mobile viewport via Playwright

### Testing
- [ ] Unit tests for `CollapsibleSection` (expand/collapse, persist state, render children)
- [ ] Unit tests for `WorkspaceSidebar` (renders all sections, handles missing data gracefully)
- [ ] Unit tests for token usage aggregation logic
- [ ] Unit tests for shutdown countdown timer
- [ ] Verify no regressions in existing sidebar behavior (rename, lifecycle actions)

## Technical Notes

- The sidebar is rendered inline in `Workspace.tsx` at lines ~935-1008 (desktop) and ~1605-1668 (mobile overlay). Extract to a dedicated component.
- `WorkspaceResponse` already contains: `repository`, `branch`, `vmSize`, `vmLocation`, `createdAt`, `lastActivityAt`, `shutdownDeadline`, `idleTimeoutSeconds`, `nodeId`
- `GitStatusData` type is in the git changes components — may need to be lifted to a shared location
- `formatTokens` in `UsageIndicator.tsx` formats numbers as "1.2k", "12.4k", etc. — export this utility
- `CollapsibleSection` should use `<details>`/`<summary>` HTML elements for built-in accessibility, or manual ARIA attributes if custom styling is needed
- Constitution check: no hardcoded values — all timeouts and limits should use env vars or configurable defaults

## Related Files

- `apps/web/src/pages/Workspace.tsx` — Main workspace page (sidebar at lines ~935-1008, mobile overlay at ~1605-1668)
- `apps/web/src/components/ChatSession.tsx` — Wrapper for agent panel (needs `onUsageChange` callback)
- `packages/acp-client/src/components/AgentPanel.tsx` — Contains `UsageIndicator` with token tracking
- `packages/acp-client/src/components/UsageIndicator.tsx` — Token formatting utilities
- `apps/web/src/components/GitChangesPanel.tsx` — Git status data types
- `apps/web/src/hooks/useIsMobile.ts` — Mobile breakpoint detection
- `packages/shared/src/types.ts` — `WorkspaceResponse`, `AgentSession` types

## Success Criteria

- [ ] Sidebar shows structured workspace info (repo, branch, VM, uptime, shutdown countdown)
- [ ] Session status visible at a glance without clicking through tabs
- [ ] Git change counts visible without opening full-screen overlay
- [ ] Token usage aggregated across all active chat sessions
- [ ] All sections collapsible with persisted state
- [ ] Lifecycle controls remain accessible in compact form
- [ ] Events log still accessible but demoted
- [ ] Mobile overlay uses the same component
- [ ] Unit tests pass for all new components
- [ ] Mobile visual verification passes
