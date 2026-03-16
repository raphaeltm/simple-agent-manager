# Notification System Phase 2: Agent-Initiated Notifications

## Problem

Phase 1 (PR #417) established the notification infrastructure — per-user Notification DO, real-time WebSocket delivery, bell icon UI, and task completion/failure notifications. But agents currently cannot proactively signal when they need human input, and session-ended notifications aren't wired into the chat lifecycle. This means users must manually poll projects to know when an agent finishes a chat turn or gets blocked.

## Research Findings

### Existing Infrastructure (Phase 1)
- **Notification DO** (`apps/api/src/durable-objects/notification.ts`) — per-user DO with SQLite, WebSocket broadcast, preference checking
- **Notification service** (`apps/api/src/services/notification.ts`) — `notifyTaskComplete()`, `notifyTaskFailed()`, `notifySessionEnded()`, `notifyPrCreated()` helpers
- **Notification routes** (`apps/api/src/routes/notifications.ts`) — REST + WebSocket endpoints
- **NotificationCenter UI** (`apps/web/src/components/NotificationCenter.tsx`) — bell icon, drawer, mark-read, dismiss
- **Shared types** (`packages/shared/src/types.ts`) — `needs_input` and `progress` already in `NOTIFICATION_TYPES`; `NOTIFICATION_TYPE_URGENCY` already maps them

### MCP Tool Infrastructure (`apps/api/src/routes/mcp.ts`)
- Tools registered in `MCP_TOOLS` array with name, description, inputSchema
- Context comes from task-scoped opaque tokens (taskId, projectId, workspaceId)
- User ID fetched from task record when needed for notifications
- Fire-and-forget pattern: notification failures don't block MCP tool responses

### Session Lifecycle Gap
- `ProjectData.stopSession()` records `session.stopped` activity event but does NOT fire notifications
- `agentCompletedAt` field exists in chat_sessions schema but no code writes to it
- No distinction between "agent finished turn" and "user stopped session"
- `complete_task` in conversation mode remaps to `awaiting_followup` (line 647-699 in mcp.ts)

### Notification Grouping
- Current UI renders flat chronological list
- `projectId` field already stored on every notification record
- Grouping is a UI-only change — group by projectId, show project name as section header

## Implementation Checklist

### 1. `request_human_input` MCP Tool (Backend)
- [ ] Add `request_human_input` tool definition to `MCP_TOOLS` array in `apps/api/src/routes/mcp.ts`
  - Parameters: `context` (string, required), `category` (enum: decision/clarification/approval/error_help), `options` (array of strings, optional)
- [ ] Add `handleRequestHumanInput()` handler in mcp.ts
  - Fetch task record for user_id and title
  - Call `notificationService.notifyNeedsInput()` with context, category, options
  - Return success immediately (non-blocking for the agent)
- [ ] Add `notifyNeedsInput()` helper in `apps/api/src/services/notification.ts`
  - Type: `needs_input`, Urgency: `high`
  - Title: "Input needed: {taskTitle}"
  - Body: the context string from the agent
  - Action URL: `/projects/{projectId}?task={taskId}` to navigate to the relevant chat
  - Metadata: `{ category, options }`
- [ ] Add unit tests for `handleRequestHumanInput()` in `apps/api/tests/unit/routes/mcp.test.ts`
- [ ] Add unit test for `notifyNeedsInput()` in `apps/api/tests/unit/services/notification.test.ts`

### 2. Progress Update Notifications (Backend)
- [ ] Wire `update_task_status` MCP tool to emit `progress` notification
  - In `handleUpdateTaskStatus()`, after recording the status update, call `notificationService.notifyProgress()`
  - Type: `progress`, Urgency: `low`
  - Title: "Progress: {taskTitle}"
  - Body: the status message
- [ ] Add `notifyProgress()` helper in notification service
- [ ] Add unit test for progress notification

### 3. Session-Ended Notification Wiring (Backend)
- [ ] Wire `notifySessionEnded()` into `ProjectData.stopSession()` — but only when stopped by agent (not user)
  - Add `stoppedBy` parameter to `stopSession()`: 'agent' | 'user' | 'system'
  - Only fire notification when `stoppedBy === 'agent'`
  - Need to trace callers of `stopSession()` to pass the correct actor
- [ ] Wire notification in task completion flow for conversation-mode sessions
  - When `complete_task` remaps to `awaiting_followup`, fire `session_ended` notification
- [ ] Add unit tests for session-ended notification wiring

### 4. Suppression Logic (Backend)
- [ ] Add configurable env vars for suppression:
  - `NOTIFICATION_PROGRESS_BATCH_WINDOW_MS` (default: 300000 / 5 min) — batch progress notifications
  - `NOTIFICATION_MIN_SESSION_DURATION_MS` (default: 5000 / 5 sec) — suppress session_ended for very short sessions
- [ ] Implement progress notification batching in Notification DO
  - When receiving a `progress` notification, check if one exists for the same task within the batch window
  - If yes, update the existing notification body instead of creating a new one
- [ ] Implement minimum session duration check in `notifySessionEnded()`
  - Skip notification if session duration < `NOTIFICATION_MIN_SESSION_DURATION_MS`
- [ ] Add duplicate task_complete suppression — don't fire if one already exists for the same taskId within 60s
- [ ] Add unit tests for suppression logic

### 5. Notification Grouping (Frontend)
- [ ] Update `NotificationCenter.tsx` to group notifications by project
  - When notifications span multiple projects, show project name as section header
  - Single-project notifications render flat (no grouping overhead)
  - Each group is collapsible with notification count badge
- [ ] Fetch project names for grouping — use project data already available in notification metadata or add projectName to notification response
- [ ] Add `projectName` field to notification creation in service helpers (stored in metadata)
- [ ] Add UI behavioral tests for grouping in NotificationCenter

### 6. Documentation & Type Updates
- [ ] Update `CLAUDE.md` Recent Changes section with Phase 2 summary
- [ ] Verify all new env vars documented in `apps/api/.env.example`
- [ ] Add new constants to `packages/shared/src/constants.ts` if needed

## Acceptance Criteria

- [ ] `request_human_input` MCP tool registered and callable by agents
- [ ] Calling `request_human_input` creates a high-urgency notification with context and optional choices
- [ ] `update_task_status` MCP tool emits progress notifications (batched, not spammy)
- [ ] Session-ended notification fires when agent finishes turn (not when user stops)
- [ ] Suppression logic prevents duplicate/unnecessary notifications
- [ ] Notifications from same project grouped in the drawer
- [ ] All configurable values use env vars with defaults (Constitution Principle XI)
- [ ] Unit tests cover all new notification helpers and MCP tool handlers
- [ ] Capability test verifies request_human_input → notification delivery end-to-end

## Key Files

### Modify
- `apps/api/src/routes/mcp.ts` — add `request_human_input` tool, wire progress notifications
- `apps/api/src/services/notification.ts` — add `notifyNeedsInput()`, `notifyProgress()` helpers
- `apps/api/src/durable-objects/notification.ts` — add progress batching suppression
- `apps/api/src/durable-objects/project-data.ts` — add `stoppedBy` param to `stopSession()`
- `apps/web/src/components/NotificationCenter.tsx` — add project grouping
- `packages/shared/src/constants.ts` — add suppression window defaults
- `apps/api/.env.example` — document new env vars

### Test
- `apps/api/tests/unit/routes/mcp.test.ts` — request_human_input handler tests
- `apps/api/tests/unit/services/notification.test.ts` — new helper tests
- `apps/api/tests/unit/durable-objects/notification.test.ts` — suppression tests (new file or extend existing)
- `apps/web/tests/unit/components/NotificationCenter.test.tsx` — grouping behavioral tests (new file)

## Dependencies

- Phase 1 complete (PR #417) — confirmed
- No external blockers
