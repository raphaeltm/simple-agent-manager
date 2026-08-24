import {
  NOTIFICATION_TYPES,
  NOTIFICATION_URGENCIES,
  type NotificationResponse,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

const notificationResponseSchema = v.object({
  id: v.string(),
  projectId: v.nullable(v.string()),
  taskId: v.nullable(v.string()),
  sessionId: v.nullable(v.string()),
  type: v.picklist(NOTIFICATION_TYPES),
  urgency: v.picklist(NOTIFICATION_URGENCIES),
  title: v.string(),
  body: v.nullable(v.string()),
  actionUrl: v.nullable(v.string()),
  metadata: v.nullable(v.record(v.string(), v.unknown())),
  readAt: v.nullable(v.string()),
  dismissedAt: v.nullable(v.string()),
  createdAt: v.string(),
});

export const notificationWsMessageSchema = v.variant('type', [
  v.object({ type: v.literal('notification.new'), notification: notificationResponseSchema }),
  v.object({ type: v.literal('notification.updated'), notification: notificationResponseSchema }),
  v.object({ type: v.literal('notification.read'), notificationId: v.string() }),
  v.object({ type: v.literal('notification.dismissed'), notificationId: v.string() }),
  v.object({ type: v.literal('notification.all_read') }),
  v.object({ type: v.literal('notification.unread_count'), count: v.number() }),
  v.object({ type: v.literal('pong') }),
]);

export type NotificationWsMessage = v.InferOutput<typeof notificationWsMessageSchema>;

/**
 * Validates REST and WebSocket notification payloads before they reach shared UI
 * state. A malformed item is dropped, not allowed to crash the app shell later.
 */
export function parseNotificationListItems(
  items: unknown,
  context: string
): NotificationResponse[] {
  if (!Array.isArray(items)) return [];

  const valid: NotificationResponse[] = [];
  let droppedCount = 0;
  let firstIssue: v.BaseIssue<unknown> | undefined;

  for (const item of items) {
    const result = v.safeParse(notificationResponseSchema, item);
    if (result.success) {
      valid.push(result.output);
    } else {
      droppedCount++;
      firstIssue ??= result.issues[0];
    }
  }

  if (droppedCount > 0) {
    console.warn(
      `Dropped ${droppedCount} malformed notification item(s) from ${context}`,
      firstIssue
    );
  }

  return valid;
}
