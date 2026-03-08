# Simplify Project Chat Navbar & Session Header

## Problem

When viewing a single chat session in the project view, the UI displays too much information simultaneously, creating visual clutter. The session header area alone contains 14+ distinct UI elements before the user even reaches the chat messages:

**Session header:** title, state dot + label, loading spinner, idle countdown timer, branch name badge, "View PR" link, "Open Workspace" button

**Status banners:** task error message, task completion summary, connection status banner, agent offline warning

**Agent status area:** "Agent is working..." + Cancel button, "Connecting to agent..." indicator

**Input area:** follow-up textarea, voice button, send button

All of these compete for attention and vertical space, pushing the actual chat content — the most important element — further down the viewport.

## Key Files

| File | Component | What it renders |
|------|-----------|-----------------|
| `apps/web/src/pages/ProjectChat.tsx` | `ProjectChat` | Sidebar, session list, layout |
| `apps/web/src/components/chat/ProjectMessageView.tsx` | `ProjectMessageView` | Session header (L624-697), status banners (L699-719), agent indicators (L779-801), input (L804-830) |
| `apps/web/src/components/project/ProjectInfoPanel.tsx` | `ProjectInfoPanel` | Workspace/task overlay panel |
| `apps/web/src/components/project/SettingsDrawer.tsx` | `SettingsDrawer` | Settings overlay panel |

## Proposed Approaches

### Option A: Collapsible Session Header

Collapse the session header into a single compact bar showing only the most critical info (title + state dot). The full details (branch, PR, workspace link, idle timer) expand on click or hover.

**Pros:** Minimal change, preserves all info, maximizes chat space
**Cons:** Hides potentially important info behind an interaction

**Implementation:**
- Wrap branch/PR/workspace elements in a collapsible section
- Show a chevron toggle to expand/collapse
- Default to collapsed once messages start flowing, expanded when idle/stopped

### Option B: Move Session Metadata to Sidebar or Drawer

Move branch name, PR link, workspace link, and task status into the existing `ProjectInfoPanel` drawer. The session header becomes just: title + state dot + cancel button.

**Pros:** Cleanest chat view, reuses existing drawer pattern
**Cons:** More clicks to access branch/PR info that developers check frequently

**Implementation:**
- Add a "Current Session" section to `ProjectInfoPanel`
- Strip `ProjectMessageView` header to title + state indicator only
- Keep error/summary banners inline (they're actionable)

### Option C: Contextual Status Bar

Replace the multiple banners and indicators with a single, slim status bar below the title. The bar shows one status at a time with priority ordering: error > agent working > idle countdown > connection issue > branch/PR.

**Pros:** Predictable single-line status, reduces vertical space dramatically
**Cons:** Can only show one status at a time (may miss concurrent states)

**Implementation:**
- Create a `SessionStatusBar` component with priority-based rendering
- Consolidate error banner, agent status, connection status, idle timer into one bar
- Use color/icon to distinguish status types (red=error, green=active, amber=idle)
- Show branch/PR as secondary info in the bar when no active status

### Option D: Floating/Sticky Compact Header + Bottom Input Redesign

Make the header ultra-compact (title only, single line) and sticky. Move the agent status indicator inline with the input area at the bottom. Cancel button moves next to the send button.

**Pros:** Maximum chat space, agent status near where user interacts
**Cons:** More structural change, need to handle mobile carefully

**Implementation:**
- Shrink session header to single-line: title (truncated) + state dot
- Move "Agent is working..." / "Connecting..." to the input area (replace/augment send button)
- Cancel button becomes part of the input controls
- Branch/PR info accessible via click on title or info icon

### Option E: Hybrid — Compact Header + Contextual Status Bar (Recommended)

Combine Options C and D. Ultra-compact sticky header with title + state dot + info icon. Single-line contextual status bar for active statuses. Agent working/cancel integrated into input area.

**Pros:** Best balance of information density and clarity
**Cons:** Most implementation effort

**Implementation:**
- Header: title + state dot + expand icon (opens drawer with branch/PR/workspace)
- Status bar: shows only when there's an active status (error, connection issue, idle countdown)
- Input area: integrates agent working state + cancel into the input controls
- Branch/PR: visible in info drawer or on hover/click of title area

## Acceptance Criteria

- [ ] One approach selected and approved
- [ ] Session header reduced to essential info only
- [ ] Full session metadata still accessible (not removed, just reorganized)
- [ ] Chat messages get more vertical space
- [ ] Mobile view is not degraded
- [ ] No information is permanently hidden — everything remains reachable

## References

- `apps/web/src/components/chat/ProjectMessageView.tsx` — primary file to refactor
- `apps/web/src/pages/ProjectChat.tsx` — layout container
- `tasks/backlog/2026-03-03-simplify-web-app-components.md` — related simplification effort
- `tasks/backlog/2026-02-28-mobile-nav-dropdown-menus.md` — related mobile UX work
