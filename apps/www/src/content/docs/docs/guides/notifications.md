---
title: Notifications
description: In-app notifications in SAM — idea completion, agent requests, progress updates, and real-time delivery.
---

SAM includes an in-app notification system that keeps you informed about agent progress and activity.

## Notification Types

| Type | Urgency | When It Fires |
|------|---------|---------------|
| **task_complete** | Medium | An idea finishes executing successfully (includes PR URL or branch name) |
| **needs_input** | High | An agent calls `request_human_input` — it's blocked and needs your decision |
| **error** | High | Execution fails with an error |
| **progress** | Low | An agent reports incremental progress via `update_task_status` |
| **session_ended** | Medium | An agent conversation turn completes |
| **pr_created** | Medium | An agent creates a pull request |

## Real-Time Delivery

Notifications are delivered via WebSocket for instant updates. The notification bell in the UI header shows the unread count and updates in real-time without page refresh.

## Agent-Initiated Notifications

### request_human_input

Agents can signal when they need your input using the `request_human_input` MCP tool. This creates a **high-urgency** notification that appears immediately.

The agent specifies:
- A **question** describing what input is needed
- A **category**: `decision`, `clarification`, `approval`, or `error_help`
- Optional **choices** the user can select from (up to 10 options)
- **Context** about the current state (up to 4,000 characters)

The agent blocks until you respond, so prompt responses keep work moving.

### Progress Updates

When agents call `update_task_status`, SAM creates progress notifications. To avoid notification fatigue, these are **batched**: only one progress notification per idea per 5-minute window (configurable via `NOTIFICATION_PROGRESS_BATCH_WINDOW_MS`).

## Notification Management

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/notifications` | GET | List notifications (paginated) |
| `/api/notifications/unread-count` | GET | Get unread count |
| `/api/notifications/:id/read` | POST | Mark as read |
| `/api/notifications/read-all` | POST | Mark all as read |
| `/api/notifications/:id/dismiss` | POST | Dismiss a notification |
| `/api/notifications/preferences` | GET | Get notification preferences |
| `/api/notifications/preferences` | PUT | Update preferences |
| `/api/notifications/ws` | GET | WebSocket for real-time delivery |

### Deduplication

SAM automatically deduplicates notifications:
- `task_complete` notifications are deduplicated within a 60-second window (configurable via `NOTIFICATION_DEDUP_WINDOW_MS`)
- Progress notifications are batched per idea per 5-minute window

### Retention

- Maximum notifications per user: 500 (configurable via `MAX_NOTIFICATIONS_PER_USER`)
- Auto-delete age: 90 days (configurable via `NOTIFICATION_AUTO_DELETE_AGE_MS`)
- When the limit is reached, the oldest notifications are automatically removed

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NOTIFICATION_PROGRESS_BATCH_WINDOW_MS` | `300000` (5 min) | Minimum interval between progress notifications per idea |
| `NOTIFICATION_DEDUP_WINDOW_MS` | `60000` (60s) | Dedup window for task_complete notifications |
| `NOTIFICATION_AUTO_DELETE_AGE_MS` | `7776000000` (90 days) | Auto-delete threshold |
| `MAX_NOTIFICATIONS_PER_USER` | `500` | Max stored notifications before oldest are removed |
| `NOTIFICATION_PAGE_SIZE` | `50` | Default page size for notification list |
