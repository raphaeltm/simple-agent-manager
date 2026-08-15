import type { NotificationType, NotificationUrgency } from '../types';

// =============================================================================
// Notification Defaults (Constitution Principle XI — all configurable)
// =============================================================================

/** Maximum notifications stored per user before oldest are auto-deleted */
export const DEFAULT_MAX_NOTIFICATIONS_PER_USER = 500;

/** Auto-delete notifications older than this (milliseconds). Default: 90 days */
export const DEFAULT_NOTIFICATION_AUTO_DELETE_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Maximum notifications returned in a single list request */
export const DEFAULT_NOTIFICATION_PAGE_SIZE = 50;

/** Maximum page size for notification list requests */
export const MAX_NOTIFICATION_PAGE_SIZE = 100;

/** Default urgency mapping for each notification type */
export const NOTIFICATION_TYPE_URGENCY: Record<NotificationType, NotificationUrgency> = {
  task_complete: 'medium',
  needs_input: 'high',
  error: 'high',
  progress: 'low',
  session_ended: 'medium',
  pr_created: 'medium',
  cron_failure: 'high',
};

/** Batch window for progress notifications — only one per task within this window. Default: 5 minutes.
 * Override via NOTIFICATION_PROGRESS_BATCH_WINDOW_MS env var. */
export const DEFAULT_NOTIFICATION_PROGRESS_BATCH_WINDOW_MS = 5 * 60 * 1000;

/** Deduplication window for task_complete notifications. Default: 60 seconds.
 * Override via NOTIFICATION_DEDUP_WINDOW_MS env var. */
export const DEFAULT_NOTIFICATION_DEDUP_WINDOW_MS = 60_000;

/** Web Push delivery TTL advertised to push services. Default: 1 day. */
export const DEFAULT_WEB_PUSH_TTL_SECONDS = 24 * 60 * 60;

/** Maximum time a VAPID authorization token remains valid. Default: 12 hours. */
export const DEFAULT_WEB_PUSH_VAPID_TTL_SECONDS = 12 * 60 * 60;

/** Per-attempt timeout for a push service request. Default: 10 seconds. */
export const DEFAULT_WEB_PUSH_DELIVERY_TIMEOUT_MS = 10_000;

/** Maximum delivery attempts for transient push-service responses. */
export const DEFAULT_WEB_PUSH_MAX_ATTEMPTS = 3;

/** Upper bound for a push service Retry-After delay. Default: 30 seconds. */
export const DEFAULT_WEB_PUSH_MAX_RETRY_AFTER_SECONDS = 30;

/** Consecutive failures before a subscription is disabled. */
export const DEFAULT_WEB_PUSH_FAILURE_THRESHOLD = 5;

/** Maximum active browser endpoints retained for one user. */
export const DEFAULT_WEB_PUSH_MAX_SUBSCRIPTIONS_PER_USER = 8;

/** Maximum endpoints encrypted and delivered concurrently. */
export const DEFAULT_WEB_PUSH_FANOUT_CONCURRENCY = 8;

/** Total background-delivery budget, kept below Workers waitUntil's 30s limit. */
export const DEFAULT_WEB_PUSH_DELIVERY_BUDGET_MS = 25_000;

/** Hard ceiling that preserves the Worker waitUntil background-lifetime invariant. */
export const MAX_WEB_PUSH_DELIVERY_BUDGET_MS = 25_000;

/** Maximum stored browser user-agent description length. */
export const DEFAULT_WEB_PUSH_USER_AGENT_MAX_LENGTH = 512;

/** Maximum unencrypted payload size accepted by the delivery layer. */
export const DEFAULT_WEB_PUSH_MAX_PAYLOAD_BYTES = 3_500;

/** Maximum accepted PushSubscription endpoint URL length. */
export const MAX_WEB_PUSH_ENDPOINT_LENGTH = 2_048;

/** Maximum accepted encoded browser subscription key length. */
export const MAX_WEB_PUSH_SUBSCRIPTION_KEY_LENGTH = 256;

/** Initial human-input response window. Default: 2 hours. */
export const DEFAULT_HUMAN_INPUT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Fractions of the initial response window at which push is re-notified. */
export const DEFAULT_HUMAN_INPUT_ESCALATION_FRACTIONS = '0.25,0.75';

/** Grace added when no out-of-band delivery was confirmed. Default: 2 hours. */
export const DEFAULT_HUMAN_INPUT_UNDELIVERED_GRACE_MS = 2 * 60 * 60 * 1000;

/** Hard maximum lifetime for an unanswered marker. Default: 24 hours. */
export const DEFAULT_HUMAN_INPUT_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

/** Maximum length for request_human_input context field */
export const MAX_HUMAN_INPUT_CONTEXT_LENGTH = 4000;

/** Maximum number of options in request_human_input */
export const MAX_HUMAN_INPUT_OPTIONS_COUNT = 10;

/** Maximum length of each option string in request_human_input */
export const MAX_HUMAN_INPUT_OPTION_LENGTH = 200;

/** Browser notification UIs consistently expose at most two custom actions. */
export const MAX_WEB_PUSH_NOTIFICATION_ACTIONS = 2;

/** Keep action labels compact enough for Android and desktop notification trays. */
export const MAX_WEB_PUSH_ACTION_TITLE_LENGTH = 40;

/** Maximum length for notification body text */
export const MAX_NOTIFICATION_BODY_LENGTH = 500;

/** Maximum length for full notification message stored in metadata. Override via NOTIFICATION_FULL_BODY_LENGTH env var. */
export const DEFAULT_NOTIFICATION_FULL_BODY_LENGTH = 5000;

/** Number of characters shown in notification detail view before collapsing with "Show more" */
export const NOTIFICATION_PREVIEW_LENGTH = 300;

/** Maximum length for notification title text (after prefix) */
export const MAX_NOTIFICATION_TITLE_LENGTH = 80;

/**
 * Maximum length for notification title text in needs_input notifications.
 * Shorter than the default because the category prefix (e.g., "Approval needed: ")
 * consumes more space.
 */
export const MAX_NOTIFICATION_TITLE_LENGTH_NEEDS_INPUT = 70;

/** Valid categories for request_human_input MCP tool */
export const HUMAN_INPUT_CATEGORIES = [
  'decision',
  'clarification',
  'approval',
  'error_help',
] as const;
export type HumanInputCategory = (typeof HUMAN_INPUT_CATEGORIES)[number];
