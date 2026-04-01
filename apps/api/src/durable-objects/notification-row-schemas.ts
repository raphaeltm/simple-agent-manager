/**
 * Valibot schemas and validated mappers for Notification DO SQLite row parsing.
 */
import type { NotificationResponse, NotificationType, NotificationUrgency } from '@simple-agent-manager/shared';
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

const NotificationPreferenceRowSchema = v.object({
  notification_type: v.string(),
  project_id: v.nullable(v.string()),
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
    projectId: r.project_id || null,
    channel: r.channel,
    enabled: r.enabled === 1,
  };
}

/** ID-only row for dedup lookups */
const IdRowSchema = v.object({ id: v.string() });

export function parseIdRow(row: unknown, context: string): string {
  return parseRow(IdRowSchema, row, context).id;
}
