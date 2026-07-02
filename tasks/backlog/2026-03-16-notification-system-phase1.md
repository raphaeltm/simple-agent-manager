# Cross-Project Notification System

## Problem

SAM agents run autonomously across multiple projects. When an agent completes a task, hits a blocker, encounters an error, or finishes a chat turn, the user has no way to know without manually checking each project in the UI. This becomes increasingly painful as users run more concurrent agents.

## Context

Research completed in `docs/notes/2026-03-14-notification-system-research.md`. SAM already has the lifecycle signals needed to drive notifications — `OnPromptComplete` callback, `complete_task`/`update_task_status` MCP tools, task state transitions, activity events. What's missing is the notification delivery layer and a new `request_human_input` MCP tool for agent-initiated escalation.

## Research Summary

Prior art survey covered Claude Code hooks, GitHub Copilot, Devin, OpenAI Agents SDK, LangGraph, Cursor, and MCP-based notification tools (Pushary, ntfy, ask-user-questions-mcp). Key takeaway: agent-initiated signaling (agent tells you it's done/blocked) is more reliable than external monitoring. SAM's existing MCP tools already follow this pattern. The Cloudflare Agents SDK + Durable Objects architecture is a natural fit for per-user notification state with real-time WebSocket delivery.

## Notification Types

| Type | Urgency | SAM Trigger |
|------|---------|-------------|
| **Task Complete** | Medium | `complete_task` MCP tool / `awaiting_followup` state |
| **Needs Input** | High | New `request_human_input` MCP tool |
| **Error/Failed** | High | Task transitions to `failed` |
| **Progress Update** | Low | `update_task_status` MCP tool (batched) |
| **Session Ended** | Medium | `OnPromptComplete` with `end_turn` in chat mode |
| **PR Created** | Medium | Git push + PR creation in finalization |

## Implementation Phases

### Phase 1: In-App Notification Center (Foundation)

**New components:**
- **Notification DO** (per-user Durable Object with SQLite) — stores notifications, manages WebSocket connections to browser, handles read/dismiss
- **Notification service** (`apps/api/src/services/notification.ts`) — receives events from existing lifecycle hooks, resolves target user, creates notification records via DO
- **Notification routes** (`apps/api/src/routes/notifications.ts`) — REST endpoints for listing, marking read, preferences; WebSocket upgrade for real-time push
- **Notification Center UI** (`apps/web/src/components/NotificationCenter.tsx`) — bell icon with unread badge in top nav, slide-out drawer with chronological list, filter tabs (All/Unread/By Type), click-through to relevant project/task/chat

**Wire up existing signals:**
- Task state → `completed`: emit "Task Complete" notification (from `apps/api/src/routes/tasks/crud.ts` callback handler)
- Task state → `failed`: emit "Error/Failed" notification
- `complete_task` MCP tool: emit "Task Complete" notification (from `apps/api/src/routes/mcp.ts`)
- `OnPromptComplete` with `end_turn` in chat context: emit "Session Ended" notification (from status callback in `apps/api/src/routes/tasks/crud.ts`)

**Data model:**
- `notifications` table in per-user DO SQLite (id, project_id, task_id, session_id, type, urgency, title, body, action_url, metadata JSON, read_at, dismissed_at, created_at)
- `notification_preferences` table (user_id, notification_type, project_id, channel, enabled)

### Phase 2: Agent-Initiated Notifications

**New MCP tool — `request_human_input`:**
- Agent calls this when blocked, needs a decision, or needs clarification
- Parameters: `context` (what they need), `category` (decision/clarification/approval/error_help), optional `options` (choices)
- Non-blocking: fires notification and returns immediately; agent can continue or end turn
- Creates high-urgency "Needs Input" notification linking to the relevant chat session
- Registered in `apps/api/src/routes/mcp.ts` alongside existing tools

**Passive chat turn detection:**
- When `OnPromptComplete` fires with `end_turn` for a non-task chat session, generate "Session Ended / Your Turn" notification
- Suppression: skip if user is currently viewing that chat, if agent called `complete_task`, or if turn was very short (< 5 seconds)

**Notification grouping:**
- Collapse multiple notifications from same project into expandable groups in the UI

### Phase 3: External Channels

- **Browser Push** (Web Push API with VAPID keys) — works when tab is not active
- **Slack webhook** — user-configured channel in Settings
- **Email digest** — batched summary, configurable frequency (hourly/daily)
- Per-channel, per-project, per-type preference matrix in Settings UI

### Phase 4: Advanced Patterns

- Smart batching (combine multiple progress updates into one digest notification)
- Escalation chains (in-app → push after 5 min → Slack after 15 min if unacknowledged)
- Cross-agent coordination ("Agent A is waiting for Agent B's PR")

## Key Design Decisions

1. **Per-user Notification DO** (not D1) — matches ProjectData DO pattern, enables real-time WebSocket, avoids write contention
2. **WebSocket for real-time** (not polling/SSE) — matches existing DO WebSocket patterns in SAM
3. **Agent-initiated > external monitoring** — `request_human_input` MCP tool lets agents declare their own state rather than parsing output
4. **Non-blocking `request_human_input`** — tool returns immediately, doesn't pause the agent
5. **All limits configurable** — notification lifetime, max stored, batching windows via env vars (Constitution Principle XI)

## Acceptance Criteria

### Phase 1
- [ ] Per-user Notification DO created with SQLite schema for notifications and preferences
- [ ] Notification service emits notifications for task completion, task failure, and session end
- [ ] WebSocket connection from browser to Notification DO delivers real-time notifications
- [ ] Bell icon in top nav shows unread count badge
- [ ] Notification drawer lists notifications chronologically with type icons
- [ ] Clicking a notification navigates to the relevant project/task/chat
- [ ] Mark-as-read and dismiss actions work; state syncs across browser tabs
- [ ] Notification preferences UI allows enable/disable per notification type
- [ ] All configurable values (max notifications, auto-delete age, etc.) use env vars with defaults

### Phase 2
- [ ] `request_human_input` MCP tool registered and callable by agents
- [ ] Calling `request_human_input` creates a high-urgency notification with context and optional choices
- [ ] Passive chat turn detection emits "Session Ended" notification when agent finishes turn
- [ ] Suppression logic prevents duplicate/unnecessary notifications (user already viewing, task already completed, very short turn)
- [ ] Notifications from same project grouped in the drawer

### Phase 3
- [ ] Browser Push Notifications delivered when browser tab is not active
- [ ] Slack webhook integration configurable in Settings
- [ ] Email digest sent at user-configured frequency
- [ ] Per-channel preferences respected for each notification type and project

## Key Files (Existing, to Wire Into)

- `apps/api/src/routes/mcp.ts` — MCP server; add `request_human_input` tool here
- `apps/api/src/routes/tasks/crud.ts` — task status callback handler; emit notifications on state transitions
- `apps/api/src/durable-objects/project-data.ts` — activity events; source for some notifications
- `apps/api/src/durable-objects/task-runner.ts` — task orchestration; emit on failure
- `packages/vm-agent/internal/acp/session_host.go` — `OnPromptComplete` callback; source for session-end signals
- `packages/vm-agent/internal/server/server.go` — status callback to control plane; carries stop reason
- `apps/web/src/components/layout/` — top nav where bell icon goes

## Key Files (New)

- `apps/api/src/durable-objects/notification.ts` — per-user Notification DO
- `apps/api/src/services/notification.ts` — notification creation/routing service
- `apps/api/src/routes/notifications.ts` — REST + WebSocket routes
- `apps/web/src/components/NotificationCenter.tsx` — bell icon + drawer
- `apps/web/src/hooks/useNotifications.ts` — WebSocket subscription hook

## Dependencies

- Depends on: stable task lifecycle (see `tasks/backlog/2026-03-14-unified-session-task-workspace-state-machine.md` — cleaner state cascading makes notification triggers more reliable)
- Blocked by: nothing (Phase 1 can start with current lifecycle signals)

## Research Reference

Full prior art analysis, architecture diagrams, and design tradeoffs: `docs/notes/2026-03-14-notification-system-research.md`
