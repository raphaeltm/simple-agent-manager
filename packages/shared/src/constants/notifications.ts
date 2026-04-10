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
};

/** Batch window for progress notifications — only one per task within this window. Default: 5 minutes.
 * Override via NOTIFICATION_PROGRESS_BATCH_WINDOW_MS env var. */
export const DEFAULT_NOTIFICATION_PROGRESS_BATCH_WINDOW_MS = 5 * 60 * 1000;

/** Deduplication window for task_complete notifications. Default: 60 seconds.
 * Override via NOTIFICATION_DEDUP_WINDOW_MS env var. */
export const DEFAULT_NOTIFICATION_DEDUP_WINDOW_MS = 60_000;

/** Maximum length for request_human_input context field */
export const MAX_HUMAN_INPUT_CONTEXT_LENGTH = 4000;

/** Maximum number of options in request_human_input */
export const MAX_HUMAN_INPUT_OPTIONS_COUNT = 10;

/** Maximum length of each option string in request_human_input */
export const MAX_HUMAN_INPUT_OPTION_LENGTH = 200;

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
export const HUMAN_INPUT_CATEGORIES = ['decision', 'clarification', 'approval', 'error_help'] as const;
export type HumanInputCategory = (typeof HUMAN_INPUT_CATEGORIES)[number];
