# Sidebar Redesign — Tier 2: Contextual Panels and Agent Activity

**Created**: 2026-02-16
**Status**: Backlog
**Priority**: Medium
**Estimated Effort**: Medium-Large
**Depends On**: `2026-02-16-sidebar-redesign-tier1.md` (CollapsibleSection component, WorkspaceSidebar extraction)

## Context

Tier 1 of the sidebar redesign adds structured, always-useful information sections (workspace info, session status, git summary, token usage). Tier 2 builds on that foundation with **contextual** panels that change based on what the user is doing, and richer agent activity tracking.

These features require slightly more wiring but still mostly use data already in memory — the ACP message stream already contains tool call details, file locations, and status information.

## Proposed Sections

### Section: Contextual Panel (Changes Per Active Tab)

When a **chat tab** is active, show:
- Agent type and model in use
- Permission mode (e.g., "plan", "dontAsk")
- Session duration (time since session started)
- **Files touched by agent** — extracted from `ToolCallItem.locations` across all messages in the session. Shows a unique list of file paths the agent has read, written, or searched. Clicking a file opens it in the file viewer overlay.

When a **terminal tab** is active, show:
- Terminal session name and connection status
- Server session ID (for debugging)
- Working directory (from `MultiTerminalSessionSnapshot.workingDirectory`)

**Data source**: `ToolCallItem` already contains `locations: Array<{ path: string; line?: number | null }>` and `toolKind`. `useAcpMessages` parses all of this. Extracting unique files is a simple `.filter().flatMap()` over items. Agent settings (model, permission mode) are already tracked per session.

### Section: Agent Activity Log

A compact, chronological list of what agents have been doing **across all sessions** — file edits, terminal commands, search operations — with timestamps and success/failure indicators. This replaces the infrastructure events log as the primary "what's happening" view.

Each entry shows:
- Icon for tool kind (file edit, terminal command, search, read, etc.)
- Truncated title/description
- Relative timestamp ("2m ago", "just now")
- Success/failure indicator (green check / red x)
- Session label (which agent did this)

Clicking an entry navigates to the relevant context (file in file viewer, or switches to that agent tab).

**Data source**: `ToolCallItem` has `title`, `toolKind`, `status`, `timestamp`, and `locations`. Data is already in memory via each `ChatSession`'s `useAcpMessages` store. Needs to be lifted via callback to the workspace level and merged across sessions.

### Section: Port Forwarding (Stretch)

Shows active ports detected on the VM with clickable URLs to access forwarded services (dev servers, databases, etc.).

**Data source**: The VM agent already has a ports proxy (`packages/vm-agent/internal/server/ports_proxy.go`). A new lightweight `GET /ports` endpoint would list detected listening ports via `ss -tlnp` or `/proc/net/tcp`.

This is a stretch goal — included here for tracking but may warrant its own task if the VM agent changes are significant.

## Implementation Checklist

### Contextual Panel
- [ ] Add a `ContextualPanel` component that renders different content based on `viewMode` and active tab type
- [ ] Chat context: extract unique files from `ToolCallItem.locations` across session messages
- [ ] Chat context: show agent type, model, permission mode, session duration
- [ ] Chat context: file list entries are clickable (open file viewer overlay)
- [ ] Terminal context: show session name, status, working directory, server session ID
- [ ] Wire as a `CollapsibleSection` in `WorkspaceSidebar`
- [ ] Add `onToolCallsChange` or similar callback from `ChatSession` to lift tool call data

### Agent Activity Log
- [ ] Add `onActivityChange` callback to `ChatSession` to lift tool call items
- [ ] Aggregate tool calls across all active sessions in `Workspace.tsx`
- [ ] Sort by timestamp descending (most recent first)
- [ ] Create `AgentActivityLog` component with compact entry rendering
- [ ] Icon mapping for tool kinds (file edit -> pencil, terminal -> terminal, search -> magnifier, read -> eye)
- [ ] Relative timestamp formatting ("just now", "2m ago", "1h ago")
- [ ] Click entry to navigate to context (switch tab, open file)
- [ ] Wire as a `CollapsibleSection` in `WorkspaceSidebar`
- [ ] Cap visible entries (e.g., last 50) with "Show more" expansion

### Port Forwarding (Stretch)
- [ ] Add `GET /ports` endpoint to VM agent (parse `ss -tlnp` output or `/proc/net/tcp`)
- [ ] Add port listing API call in the web app
- [ ] Create `PortForwardingPanel` component
- [ ] Render port number, process name (if available), and clickable proxy URL
- [ ] Poll for port changes every 10-15 seconds
- [ ] Wire as a `CollapsibleSection` in `WorkspaceSidebar`

### Testing
- [ ] Unit tests for `ContextualPanel` (renders correct content per tab type)
- [ ] Unit tests for file extraction logic (dedup, sort, handle empty)
- [ ] Unit tests for `AgentActivityLog` (renders entries, handles empty state, caps entries)
- [ ] Unit tests for relative timestamp formatting
- [ ] Integration test for port forwarding endpoint (if implemented)
- [ ] Mobile visual verification via Playwright

## Technical Notes

- `ToolCallItem` type is defined in `packages/acp-client/src/types/`. It has: `kind: 'tool_call'`, `title: string`, `toolKind: string`, `status: 'running' | 'completed' | 'error'`, `locations: Array<{ path: string; line?: number | null }>`.
- The contextual panel pattern (different content per active tab) is used by VS Code's Outline view, Cursor's AI context panel, and JetBrains' Structure view.
- For the activity log, consider a ring buffer approach (keep last N entries) to prevent unbounded memory growth in long sessions.
- Port forwarding proxy already exists at `packages/vm-agent/internal/server/ports_proxy.go` — the missing piece is a listing endpoint and UI.
- Constitution check: any polling intervals or entry limits must be configurable via env vars.

## Related Files

- `apps/web/src/pages/Workspace.tsx` — Workspace page, sidebar integration point
- `apps/web/src/components/ChatSession.tsx` — Needs callback props for tool calls / activity
- `packages/acp-client/src/components/AgentPanel.tsx` — Contains message rendering with tool call data
- `packages/acp-client/src/hooks/useAcpMessages.ts` — Parses ACP messages including tool calls
- `packages/acp-client/src/types/` — `ToolCallItem`, `MessageItem` types
- `packages/vm-agent/internal/server/ports_proxy.go` — Existing port proxy infrastructure
- `packages/terminal/src/types/multi-terminal.ts` — `MultiTerminalSessionSnapshot` type

## Success Criteria

- [ ] Sidebar shows contextual info that changes based on active tab type
- [ ] Chat tabs show files touched, model, permission mode, session duration
- [ ] Terminal tabs show connection details and working directory
- [ ] Agent activity log shows structured tool call history across sessions
- [ ] Activity entries are clickable and navigate to relevant context
- [ ] All new sections use `CollapsibleSection` with persisted state
- [ ] Mobile visual verification passes
- [ ] Unit tests pass for all new components
