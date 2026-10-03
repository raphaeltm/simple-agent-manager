---
title: Notifications
description: In-app and Web Push notifications in SAM — task completion, agent requests, progress updates, and out-of-band delivery.
---

SAM combines an in-app notification center with optional Web Push delivery for agent progress and activity.

## Notification Types

| Type              | Urgency | When It Fires                                                                                                                 |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **task_complete** | Medium  | A task finishes executing successfully (includes PR URL or branch name)                                                       |
| **needs_input**   | High    | An agent calls `request_human_input` because it needs your decision                                                           |
| **error**         | High    | Execution fails with an error                                                                                                 |
| **progress**      | Low     | An agent reports incremental progress via `update_task_status`                                                                |
| **session_ended** | Medium  | A conversation-mode session turn completes                                                                                    |
| **pr_created**    | Medium  | An agent creates a pull request                                                                                               |
| **cron_failure**  | High    | A five-minute operational recovery sweep fails, or ProjectData storage needs an operator (active superadmins only; see below) |

## Delivery Channels

Notifications are delivered via WebSocket for instant updates. The notification bell in the UI header shows the unread count and updates in real-time without page refresh.

Web Push is available for medium- and high-urgency notifications. Enable it under
**Settings → Notifications** to receive agent questions and task results even when SAM is
closed. Push on means the browser receives every eligible notification; SAM does not
suppress phone delivery merely because another browser tab is connected. Low-urgency
progress updates remain in-app only.

SAM uses one standards-based Declarative Web Push payload for Safari, Chrome, and Firefox.
On iPhone and iPad, install SAM to the Home Screen before enabling push. Other supported
browsers can enable push directly. Browser permission is requested only after you select
**Enable push**, never on page load.

## Agent-Initiated Notifications

### request_human_input

Agents can signal when they need your input using the `request_human_input` MCP tool. This creates a **high-urgency** notification that appears immediately.

The agent specifies:

- A **question** describing what input is needed
- A **category**: `decision`, `clarification`, `approval`, or `error_help`
- Optional **choices** the user can select from (up to 10 options)
- **Context** about the current state (up to 4,000 characters)

The tool call is non-blocking: the agent records the request and can stop its turn while
SAM waits for your answer. Ordinary typed replies continue to resolve the request. When the
agent supplies choices, the notification also renders touch-sized answer buttons; choosing
one records the exact answer and forwards it to the agent.

SAM sends bounded reminders during the initial response window. At the original deadline,
the task is failed only when push delivery was confirmed. If no out-of-band channel
confirmed delivery, SAM extends the request instead. A hard maximum residence time still
guarantees eventual termination. The separate agent-liveness reconciliation watchdog keeps
its fixed deadline. Either way, a failed task's workspace is snapshotted and its
conversation put to sleep rather than deleted, so your reply wakes it with its files
restored (see [When a task fails](/docs/guides/session-troubleshooting/#when-a-task-fails)).
The exception is an agent still stuck mid-turn when the watchdog expires: its workspace is
released, and the chat says the work was not saved.

### Progress Updates

When agents call `update_task_status`, SAM creates progress notifications. To avoid notification fatigue, these are **batched**: only one progress notification per task per 5-minute window (configurable via `NOTIFICATION_PROGRESS_BATCH_WINDOW_MS`).

## Notification Management

### API Endpoints

| Endpoint                                                                   | Method | Description                                     |
| -------------------------------------------------------------------------- | ------ | ----------------------------------------------- |
| `/api/notifications`                                                       | GET    | List notifications (paginated)                  |
| `/api/notifications/unread-count`                                          | GET    | Get unread count                                |
| `/api/notifications/:id/read`                                              | POST   | Mark as read                                    |
| `/api/notifications/read-all`                                              | POST   | Mark all as read                                |
| `/api/notifications/:id/dismiss`                                           | POST   | Dismiss a notification                          |
| `/api/notifications/preferences`                                           | GET    | Get notification preferences                    |
| `/api/notifications/preferences`                                           | PUT    | Update preferences                              |
| `/api/notifications/push/subscriptions`                                    | POST   | Add or refresh this browser's push subscription |
| `/api/notifications/push/subscriptions`                                    | GET    | List the user's push subscriptions              |
| `/api/notifications/push/subscriptions`                                    | DELETE | Remove this browser's push subscription         |
| `/api/notifications/ws`                                                    | GET    | WebSocket for real-time delivery                |
| `/api/config/vapid-public-key`                                             | GET    | Read the deployment's public VAPID key          |
| `/api/projects/:projectId/sessions/:sessionId/attention/:markerId/resolve` | POST   | Record and forward a structured answer          |

### Deduplication

SAM automatically deduplicates notifications:

- `task_complete` notifications are deduplicated within a 60-second window (configurable via `NOTIFICATION_DEDUP_WINDOW_MS`)
- Progress notifications are batched per task per 5-minute window
- `cron_failure` notifications are throttled per alert and per recipient. A
  recipient's expiring KV marker is written only after their notification was
  created, so a failed delivery is retried on the next five-minute tick instead
  of being suppressed for the whole window. Overlapping ticks can occasionally
  send a duplicate.

Operational sweep failures are sent only to active superadmin accounts. System
and anonymous-trial sentinel users are excluded. The notification links to the
admin log viewer for investigation and respects the recipient's in-app
`cron_failure` preference.

ProjectData storage alerts use the same type and recipients and link to
**Admin → Storage**. They fire while a project's archive circuit breaker is open
(high urgency) or frozen (medium, or high once that project is near the cap),
when a project's last exported storage measurement reaches
`PROJECT_DATA_STORAGE_WALL_ALERT_RATIO` (95%) of Cloudflare's 10 GiB per-object
cap, and when automatic cleanup cannot reach its target. Each repeats at most
once per `PROJECT_DATA_STORAGE_ALERT_NOTIFICATION_THROTTLE_MS` (6 hours) while the
condition lasts. An alert can only be as fresh as the telemetry the object last
exported; it says when that was, and says "telemetry stale" when nothing newer
than `PROJECT_DATA_STORAGE_ALERT_STALE_AFTER_MS` (3 hours) has arrived.

Each tick attempts at most `PROJECT_DATA_STORAGE_ALERT_MAX_ALERTS_PER_TICK` (4)
alerts, most severe first, and only alerts that are due count toward that limit:
a condition already sent within its window is skipped without using a slot, and
a recipient whose delivery failed is retried after
`PROJECT_DATA_STORAGE_ALERT_FAILURE_BACKOFF_MS` (15 minutes). First deliveries go
before retries, but while any retry is due one slot per tick is kept for retries,
and retries go longest-waiting first, so a recipient whose delivery failed is
reached again even while new alerts keep arriving. When more conditions qualify than one scan reads
(`PROJECT_DATA_STORAGE_ALERT_SCAN_LIMIT`, 50), the most severe are still read on
every tick and a rotating window works through the rest, so every ongoing
condition is delivered in turn. If the tick cannot read the throttle markers, it
sends nothing rather than risk repeating every alert.

### Retention

- Maximum notifications per user: 500 (configurable via `MAX_NOTIFICATIONS_PER_USER`)
- Auto-delete age: 90 days (configurable via `NOTIFICATION_AUTO_DELETE_AGE_MS`)
- When the limit is reached, the oldest notifications are automatically removed

## Configuration

| Variable                                | Default                     | Description                                                               |
| --------------------------------------- | --------------------------- | ------------------------------------------------------------------------- |
| `NOTIFICATION_PROGRESS_BATCH_WINDOW_MS` | `300000` (5 min)            | Minimum interval between progress notifications per task                  |
| `NOTIFICATION_DEDUP_WINDOW_MS`          | `60000` (60s)               | Dedup window for task_complete notifications                              |
| `NOTIFICATION_AUTO_DELETE_AGE_MS`       | `7776000000` (90 days)      | Auto-delete threshold                                                     |
| `MAX_NOTIFICATIONS_PER_USER`            | `500`                       | Max stored notifications before oldest are removed                        |
| `NOTIFICATION_PAGE_SIZE`                | `50`                        | Default page size for notification list                                   |
| `CRON_FAILURE_NOTIFICATION_THROTTLE_MS` | `3600000` (1 hr)            | Per-sweep superadmin alert throttle                                       |
| `CRON_FAILURE_NOTIFICATION_KV_PREFIX`   | `cron-failure-notification` | KV prefix used for coarse throttle markers and atomic deduplication keys  |
| `HUMAN_INPUT_TIMEOUT_MS`                | `7200000` (2 hr)            | Initial needs-input response window                                       |
| `HUMAN_INPUT_ESCALATION_FRACTIONS`      | `0.25,0.75`                 | Fractions of the initial window at which reminders fire                   |
| `HUMAN_INPUT_UNDELIVERED_GRACE_MS`      | `7200000` (2 hr)            | Extension when no push delivery was confirmed                             |
| `HUMAN_INPUT_MAX_WAIT_MS`               | `86400000` (24 hr)          | Hard maximum needs-input marker lifetime                                  |
| `WEB_PUSH_TTL_SECONDS`                  | `86400`                     | Push-service message TTL                                                  |
| `WEB_PUSH_VAPID_TTL_SECONDS`            | `43200`                     | VAPID authorization-token lifetime                                        |
| `WEB_PUSH_DELIVERY_TIMEOUT_MS`          | `10000`                     | Per-attempt push-service timeout                                          |
| `WEB_PUSH_DELIVERY_BUDGET_MS`           | `25000`                     | Total fan-out budget, hard-capped at 25s below Worker background lifetime |
| `WEB_PUSH_FANOUT_CONCURRENCY`           | `8`                         | Maximum concurrent endpoint deliveries                                    |
| `WEB_PUSH_MAX_ATTEMPTS`                 | `3`                         | Bounded attempts for transient failures                                   |
| `WEB_PUSH_MAX_RETRY_AFTER_SECONDS`      | `30`                        | Maximum honored `Retry-After` delay                                       |
| `WEB_PUSH_MAX_PAYLOAD_BYTES`            | `3500`                      | Maximum unencrypted payload size                                          |
| `WEB_PUSH_FAILURE_THRESHOLD`            | `5`                         | Consecutive failures before disabling a subscription                      |
| `WEB_PUSH_MAX_SUBSCRIPTIONS_PER_USER`   | `8`                         | Maximum retained browser endpoints per user                               |
| `WEB_PUSH_USER_AGENT_MAX_LENGTH`        | `512`                       | Maximum stored browser description length                                 |
| `RATE_LIMIT_PUSH_SUBSCRIPTION`          | `30`                        | Subscription mutations per user per hour                                  |
