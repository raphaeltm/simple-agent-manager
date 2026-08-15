/**
 * Valibot schemas and validated mappers for Notification DO SQLite row parsing.
 */
import type {
  NotificationResponse,
  NotificationType,
  NotificationUrgency,
  WebPushSubscriptionResponse,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { parseRow } from './project-data/row-schemas';

// =============================================================================
// Notification row schemas
// =============================================================================

const NotificationTypeSchema = v.picklist([
  'task_complete',
  'needs_input',
  'error',
  'progress',
  'session_ended',
  'pr_created',
  'cron_failure',
]);

const NotificationUrgencySchema = v.picklist(['high', 'medium', 'low']);

/** Full notification row from SELECT * */
const NotificationRowSchema = v.object({
  id: v.string(),
  user_id: v.string(),
  project_id: v.nullable(v.string()),
  task_id: v.nullable(v.string()),
  session_id: v.nullable(v.string()),
  type: NotificationTypeSchema,
  urgency: NotificationUrgencySchema,
  title: v.string(),
  body: v.nullable(v.string()),
  action_url: v.nullable(v.string()),
  metadata: v.nullable(v.string()),
  read_at: v.nullable(v.number()),
  dismissed_at: v.nullable(v.number()),
  created_at: v.number(),
});

export function parseNotificationRow(row: unknown): NotificationResponse {
  const r = parseRow(NotificationRowSchema, row, 'notification');
  return {
    id: r.id,
    projectId: r.project_id || null,
    taskId: r.task_id,
    sessionId: r.session_id,
    type: r.type as NotificationType,
    urgency: r.urgency as NotificationUrgency,
    title: r.title,
    body: r.body,
    actionUrl: r.action_url,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
    readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
    dismissedAt: r.dismissed_at ? new Date(r.dismissed_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

// =============================================================================
// Notification preference row
// =============================================================================

/**
 * Storage sentinel for "no project" / global preferences.
 *
 * SQLite's UNIQUE constraint does NOT treat NULLs as equal, so a nullable
 * `project_id` column would allow duplicate global preference rows for the same
 * (user, type, channel). We store an empty string instead so the UNIQUE
 * constraint dedupes global rows. This sentinel is an internal storage detail
 * of the Notification DO and MUST NOT leak across the API boundary — callers
 * use `null` for global scope. Convert at the storage edge with the helpers
 * below.
 */
const STORED_PREFERENCE_GLOBAL_SENTINEL = '';

/** Convert an API project scope (`null`/`undefined` = global) to its stored form. */
export function toStoredPreferenceProjectId(projectId?: string | null): string {
  return projectId ?? STORED_PREFERENCE_GLOBAL_SENTINEL;
}

/** Convert a stored `project_id` back to its API form (`''` sentinel → `null`). */
export function fromStoredPreferenceProjectId(projectId: string): string | null {
  return projectId === STORED_PREFERENCE_GLOBAL_SENTINEL ? null : projectId;
}

const NotificationPreferenceRowSchema = v.object({
  notification_type: v.string(),
  project_id: v.string(),
  channel: v.string(),
  enabled: v.number(),
});

export function parseNotificationPreferenceRow(row: unknown): {
  notificationType: string;
  projectId: string | null;
  channel: string;
  enabled: boolean;
} {
  const r = parseRow(NotificationPreferenceRowSchema, row, 'notification_preference');
  return {
    notificationType: r.notification_type,
    projectId: fromStoredPreferenceProjectId(r.project_id),
    channel: r.channel,
    enabled: r.enabled === 1,
  };
}

/** ID-only row for dedup lookups */
const IdRowSchema = v.object({ id: v.string() });

export function parseIdRow(row: unknown, context: string): string {
  return parseRow(IdRowSchema, row, context).id;
}

// =============================================================================
// Web Push subscription rows
// =============================================================================

const PushSubscriptionRowSchema = v.object({
  endpoint: v.string(),
  user_id: v.string(),
  p256dh: v.string(),
  auth: v.string(),
  user_agent: v.nullable(v.string()),
  disabled_at: v.nullable(v.number()),
  failure_count: v.number(),
  last_success_at: v.nullable(v.number()),
  created_at: v.number(),
  updated_at: v.number(),
});

export interface StoredPushSubscription {
  endpoint: string;
  userId: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  disabledAt: number | null;
  failureCount: number;
  lastSuccessAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export function parseStoredPushSubscriptionRow(row: unknown): StoredPushSubscription {
  const r = parseRow(PushSubscriptionRowSchema, row, 'push_subscription');
  return {
    endpoint: r.endpoint,
    userId: r.user_id,
    p256dh: r.p256dh,
    auth: r.auth,
    userAgent: r.user_agent,
    disabledAt: r.disabled_at,
    failureCount: r.failure_count,
    lastSuccessAt: r.last_success_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function parsePushSubscriptionRow(row: unknown): WebPushSubscriptionResponse {
  const subscription = parseStoredPushSubscriptionRow(row);
  return {
    endpoint: subscription.endpoint,
    userAgent: subscription.userAgent,
    disabledAt:
      subscription.disabledAt === null ? null : new Date(subscription.disabledAt).toISOString(),
    failureCount: subscription.failureCount,
    lastSuccessAt:
      subscription.lastSuccessAt === null
        ? null
        : new Date(subscription.lastSuccessAt).toISOString(),
    createdAt: new Date(subscription.createdAt).toISOString(),
    updatedAt: new Date(subscription.updatedAt).toISOString(),
  };
}

/** Parse independent list rows without letting one corrupt record hide healthy devices. */
export function parseStoredPushSubscriptionRows(
  rows: unknown[],
  onInvalid?: (index: number, error: unknown) => void
): StoredPushSubscription[] {
  const parsed: StoredPushSubscription[] = [];
  rows.forEach((row, index) => {
    try {
      parsed.push(parseStoredPushSubscriptionRow(row));
    } catch (error) {
      onInvalid?.(index, error);
    }
  });
  return parsed;
}

export function parsePushSubscriptionRows(
  rows: unknown[],
  onInvalid?: (index: number, error: unknown) => void
): WebPushSubscriptionResponse[] {
  const parsed: WebPushSubscriptionResponse[] = [];
  rows.forEach((row, index) => {
    try {
      parsed.push(parsePushSubscriptionRow(row));
    } catch (error) {
      onInvalid?.(index, error);
    }
  });
  return parsed;
}
