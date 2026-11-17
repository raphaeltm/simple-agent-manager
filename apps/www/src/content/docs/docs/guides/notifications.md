---
title: Notifications
description: In-app and Web Push notifications in SAM — task completion, questions agents send with the request_human_input tool, comments, mentions and shared chats, progress updates, and out-of-band delivery.
---

SAM combines in-app notifications (listed under the [Inbox](/docs/guides/inbox/)'s **Updates** chip) with optional Web Push delivery for agent progress and activity.

## Notification Types

| Type                    | Urgency | When It Fires                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **task_complete**       | Medium  | An agent reports its task complete (selecting **Complete** yourself sends none). It reads **PR ready for review** with the pull request the agent reported, or else **Output on branch** with the task's branch name, which doesn't mean anything was pushed, or **Task finished successfully** when there's neither                                                                                                             |
| **needs_input**         | High    | An agent calls `request_human_input` because it needs your decision, or asks for permission, a form or a link while it works (once per request; opens the request in your inbox)                                                                                                                                                                                                                                                 |
| **error**               | High    | A task couldn't start or stopped before it finished, a chat could not be woken for a waiting message, a chat slept with possible loss of unsaved work, or your answer never reached the agent. Opens the [inbox error item](/docs/reference/api/#system-error-items)                                                                                                                                                             |
| **progress**            | Low     | An agent reports incremental progress via `update_task_status`                                                                                                                                                                                                                                                                                                                                                                   |
| **session_ended**       | Medium  | A conversation-mode session turn completes                                                                                                                                                                                                                                                                                                                                                                                       |
| **cron_failure**        | High    | A five-minute operational recovery sweep fails, SAM stops archiving a project's stored data (**Archiving stopped for** the project; select **Close breaker** in **Admin → Storage** to let archiving resume), or SAM gives up on a GitHub trigger delivery or an email sent to an email automation (active superadmins only); also sent to an automation's owner when it starts failing repeatedly, opening its inbox error item |
| **mention**             | Medium  | A teammate @mentions you in a chat comment or reply                                                                                                                                                                                                                                                                                                                                                                              |
| **comment**             | Low     | A teammate comments on a chat you own, or replies in a comment thread you are part of                                                                                                                                                                                                                                                                                                                                            |
| **session_access**      | Medium  | A teammate shares a chat with you (saying for how long), extends or removes your access, or shares a chat you own with someone else                                                                                                                                                                                                                                                                                              |
| **operations_approval** | High    | An agent in the Operations project asks to run an operational action, such as restarting something on a machine. Shown as **Approval Needed**, to superadmins only; approve or deny it on the card in that chat or in **Admin → Approvals** ([Operations debugger tools](/docs/guides/admin-settings/#operations-debugger-tools))                                                                                                |
| **secret_request**      | High    | An agent asks you to supply a secret value through the card in its chat ([details](/docs/guides/secret-execution/#let-the-agent-ask-you-for-a-secret))                                                                                                                                                                                                                                                                           |

A permission request, form, or link card that an agent puts in the chat while it waits sends one
**needs_input** notification per request, to the person who started the chat; it opens the request
in your [Inbox](/docs/guides/inbox/). The chat also shows **Needs input** beside it in the project's
session list — see
[When the Agent Needs You](/docs/guides/chat-features/#when-the-agent-needs-you).

**Settings → Notifications** still lists a **PR Created** switch, but SAM no longer sends that
notification: SAM doesn't open pull requests itself, so a pull request link arrives in the agent's
**Task Complete** notification when the agent reports one.

### Inbox and Updates

The [Inbox](/docs/guides/inbox/) replaced the notification bell panel and the project
**Notifications** page. An agent's question, a secret request and an Operations approval are inbox
items: you answer them in the Inbox, and the inbox icon's number counts what you can act on. Every
other notification, including finished tasks, failures, mentions, comments on your chats and
shared chats, is listed under the Inbox's **Updates** chip.

Selecting a **Mention** or **Comment** update opens the comment in its conversation, with the
words it's about highlighted and the thread beside them; **Open in chat** goes on to the chat itself
(see [Read a comment in its conversation](/docs/guides/collaboration/#read-a-comment-in-its-conversation)). A
**Shared Session** update says how long you can use the chat; nothing tells you when that time
runs out (see [What your teammate sees](/docs/guides/collaboration/#what-your-teammate-sees)).

To stop a kind of notification, switch it off in **Settings → Notifications**; the newer ones are
**Mentions**, **Comments on your sessions**, and **Shared sessions**.

### Answer an agent's question

When an agent asks you something with `request_human_input`, the question is an item in your
[Inbox](/docs/guides/inbox/#answer-an-item): open it to read the whole question, its earlier context
and what the agent did since, and answer with the buttons pinned at the bottom, or **Type a
different answer**. On a desktop, a question with three or fewer short options can be answered from
the inbox icon's quick view in one tap. You can also just reply in the chat: a typed reply answers
the question too.

The question goes to the person who started the chat. A teammate the chat is
[shared with](/docs/guides/collaboration/#work-together-in-a-chat) can answer by replying in the chat.

## Delivery Channels

Notifications are delivered via WebSocket for instant updates. A new notification also refreshes the [Inbox](/docs/guides/inbox/) and the number on the inbox icon, without a page refresh.

Web Push is available for medium- and high-urgency notifications. Enable it under
**Settings → Notifications** to receive the questions agents send with `request_human_input`, and
task results, even when SAM is closed. Push on means the browser receives every eligible notification; SAM does not
suppress phone delivery merely because another browser tab is connected. Low-urgency
progress updates remain in-app only.

SAM uses one standards-based Declarative Web Push payload for Safari, Chrome, and Firefox.
On iPhone and iPad, install SAM to the Home Screen before enabling push. Other supported
browsers can enable push directly. Browser permission is requested only after you select
**Enable push**, never on page load.

The question also appears in the conversation itself, as a card where the agent asked it. The card
shows the full question (a long one starts collapsed behind **Show full question**) and the same
answer buttons, or **Your answer** when the agent offered no choices. An answer given in the card or
the Inbox is the same answer: the card then shows **Answered** and what was chosen, and the Inbox
catches up. A question that expired, or that someone else answered, shows that instead
of buttons. Teammates who can read the chat but not answer it see the question without buttons.

Comment notifications are low urgency, so they stay in the app and are never pushed. Mentions and
shared-chat notifications are pushed when push is on.

## Agent-Initiated Notifications

### request_human_input

Agents can signal when they need your input using the `request_human_input` MCP tool, or by filing an
ask or a review in your [Inbox](/docs/guides/inbox/#what-agents-file) with `inbox_write`. Each creates a
**high-urgency** notification that appears immediately (a review is titled **Review needed**).

The agent specifies:

- **Context**: what it needs from you (required, up to 4,000 characters). Its first sentence
  becomes the item's title.
- A **category**: `decision`, `clarification`, `approval`, or `error_help`
- Optional **options** you can pick from (up to 10)

The tool call is non-blocking: the agent records the request and can stop its turn while
SAM waits for your answer. Ordinary typed replies continue to resolve the request. When the
agent supplies choices, the Inbox item and the chat card render them as answer buttons; choosing
one records the exact answer and forwards it to the agent.

The tool's result tells the agent the request was recorded, and carries the request's ID, which the
chat uses to show the question as an answerable card (`HumanInputCard` in `apps/web`).

To read the whole question, see its earlier context, and answer it, open it in the
[Inbox](/docs/guides/inbox/#answer-an-item), which reads the saved question rather than the
notification text.

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

| Endpoint                                                                   | Method | Description                                                          |
| -------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------- |
| `/api/notifications`                                                       | GET    | List notifications (paginated)                                       |
| `/api/notifications/unread-count`                                          | GET    | Get unread count                                                     |
| `/api/notifications/:id/read`                                              | POST   | Mark as read                                                         |
| `/api/notifications/read-all`                                              | POST   | Mark all as read                                                     |
| `/api/notifications/:id/dismiss`                                           | POST   | Dismiss a notification                                               |
| `/api/notifications/preferences`                                           | GET    | Get notification preferences                                         |
| `/api/notifications/preferences`                                           | PUT    | Update preferences                                                   |
| `/api/notifications/push/subscriptions`                                    | POST   | Add or refresh this browser's push subscription                      |
| `/api/notifications/push/subscriptions`                                    | GET    | List the user's push subscriptions                                   |
| `/api/notifications/push/subscriptions`                                    | DELETE | Remove this browser's push subscription                              |
| `/api/notifications/ws`                                                    | GET    | WebSocket for real-time delivery                                     |
| `/api/config/vapid-public-key`                                             | GET    | Read the deployment's public VAPID key                               |
| `/api/projects/:projectId/sessions/:sessionId/attention/:markerId`         | GET    | Read the full saved question (`?context=true` adds earlier messages) |
| `/api/projects/:projectId/sessions/:sessionId/attention/:markerId/resolve` | POST   | Record and forward a structured answer                               |

A push subscription's endpoint must be an HTTPS URL on a public host (the push services browsers
use all are). SAM never follows a redirect from a push service, and a stored endpoint that is not on
a public host is skipped at delivery (`web_push.endpoint_refused`).

### Deduplication

SAM automatically deduplicates notifications:

- `task_complete` notifications are deduplicated within a 60-second window (configurable via `NOTIFICATION_DEDUP_WINDOW_MS`)
- Progress notifications are batched per task per 5-minute window
- `mention` notifications are sent once per mention. `comment` notifications are grouped per chat:
  each person gets at most one per chat in a 10-minute window (the
  `collaboration.commentNotificationWindowSeconds` [admin setting](/docs/guides/admin-settings/)).
  Nobody is notified about their own comment, and a person who is mentioned gets only the mention.
  Both open the comment [in its conversation](/docs/guides/collaboration/#read-a-comment-in-its-conversation).
- `cron_failure` notifications are throttled per sweep name. KV provides the
  expiring coarse marker, and an atomic per-user Notification Durable Object
  claim guarantees that overlapping cron invocations do not send duplicates.

Operational sweep failures are sent only to active superadmin accounts. System
users (status `system`) are excluded. The notification links to the
admin log viewer for investigation and respects the recipient's in-app
`cron_failure` preference.

When a sweep poisons a ProjectData archive migration and that opens the project's
archive circuit breaker, the same superadmins get one `cron_failure` notification
for that opening, titled "Archiving stopped for" the project and linking to
**Admin → Storage**, where the breaker is closed. Further poisonings while the
breaker stays open send nothing; a breaker that opens again after being closed
notifies again.

### Retention

- Maximum notifications per user: 500 (configurable via `MAX_NOTIFICATIONS_PER_USER`)
- Auto-delete age: 90 days (configurable via `NOTIFICATION_AUTO_DELETE_AGE_MS`)
- When the limit is reached, the oldest notifications are automatically removed

## Configuration

| Variable                                | Default                     | Description                                                                               |
| --------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| `NOTIFICATION_PROGRESS_BATCH_WINDOW_MS` | `300000` (5 min)            | Minimum interval between progress notifications per task                                  |
| `NOTIFICATION_DEDUP_WINDOW_MS`          | `60000` (60s)               | Dedup window for task_complete notifications                                              |
| `NOTIFICATION_AUTO_DELETE_AGE_MS`       | `7776000000` (90 days)      | Auto-delete threshold                                                                     |
| `MAX_NOTIFICATIONS_PER_USER`            | `500`                       | Max stored notifications before oldest are removed                                        |
| `NOTIFICATION_PAGE_SIZE`                | `50`                        | Default page size for notification list                                                   |
| `CRON_FAILURE_NOTIFICATION_THROTTLE_MS` | `3600000` (1 hr)            | Per-sweep superadmin alert throttle; also how long an archive-breaker alert claim is held |
| `CRON_FAILURE_NOTIFICATION_KV_PREFIX`   | `cron-failure-notification` | KV prefix used for coarse throttle markers and atomic deduplication keys                  |
| `HUMAN_INPUT_ESCALATION_FRACTIONS`      | `0.25,0.75`                 | Reminder points, questions asked before the inbox move only                               |
| `HUMAN_INPUT_UNDELIVERED_GRACE_MS`      | `7200000` (2 hr)            | Undelivered grace, questions asked before the inbox move only                             |
| `HUMAN_INPUT_MAX_WAIT_MS`               | `86400000` (24 hr)          | Hard limit, questions asked before the inbox move only                                    |
| `WEB_PUSH_TTL_SECONDS`                  | `86400`                     | Push-service message TTL                                                                  |
| `WEB_PUSH_VAPID_TTL_SECONDS`            | `43200`                     | VAPID authorization-token lifetime                                                        |
| `WEB_PUSH_DELIVERY_TIMEOUT_MS`          | `10000`                     | Per-attempt push-service timeout                                                          |
| `WEB_PUSH_DELIVERY_BUDGET_MS`           | `25000`                     | Total fan-out budget, hard-capped at 25s below Worker background lifetime                 |
| `WEB_PUSH_FANOUT_CONCURRENCY`           | `8`                         | Maximum concurrent endpoint deliveries                                                    |
| `WEB_PUSH_MAX_ATTEMPTS`                 | `3`                         | Bounded attempts for transient failures                                                   |
| `WEB_PUSH_MAX_RETRY_AFTER_SECONDS`      | `30`                        | Maximum honored `Retry-After` delay                                                       |
| `WEB_PUSH_MAX_PAYLOAD_BYTES`            | `3500`                      | Maximum unencrypted payload size                                                          |
| `WEB_PUSH_FAILURE_THRESHOLD`            | `5`                         | Consecutive failures before disabling a subscription                                      |
| `WEB_PUSH_MAX_SUBSCRIPTIONS_PER_USER`   | `8`                         | Maximum retained browser endpoints per user                                               |
| `WEB_PUSH_USER_AGENT_MAX_LENGTH`        | `512`                       | Maximum stored browser description length                                                 |
| `RATE_LIMIT_PUSH_SUBSCRIPTION`          | `30`                        | Subscription mutations per user per hour                                                  |

A question an agent asks with `request_human_input` follows the schedule in the admin settings
`inbox.questionTimeoutMinutes`, `inbox.questionFirstReminderPercent`,
`inbox.questionSecondReminderPercent`, `inbox.questionUndeliveredGraceMinutes` and
`inbox.questionMaxWaitMinutes` (see [Admin settings](/docs/guides/admin-settings/)). The three
`HUMAN_INPUT_*` variables above apply only to questions asked before that change, until they are
answered or expire.
