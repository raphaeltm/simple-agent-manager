/**
 * Notification Routes — REST endpoints + WebSocket upgrade for notifications.
 *
 * Routes:
 *   GET    /api/notifications           — list notifications (paginated)
 *   GET    /api/notifications/unread-count — get unread count
 *   POST   /api/notifications/:id/read  — mark single notification as read
 *   POST   /api/notifications/read-all  — mark all as read
 *   POST   /api/notifications/:id/dismiss — dismiss a notification
 *   GET    /api/notifications/preferences — get notification preferences
 *   PUT    /api/notifications/preferences — update a preference
 *   GET    /api/notifications/ws         — WebSocket upgrade for real-time delivery
 *
 * Auth: All endpoints require authenticated user (per-route middleware).
 */

import type {
  NotificationType,
} from '@simple-agent-manager/shared';
import { NOTIFICATION_TYPES } from '@simple-agent-manager/shared';
import { Hono } from 'hono';

import type { NotificationService } from '../durable-objects/notification';
import type { Env } from '../index';
import { getUserId, requireApproved,requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { jsonValidator, UpdateNotificationPreferenceSchema } from '../schemas';

const notificationRoutes = new Hono<{ Bindings: Env }>();

// Helper to get a typed Notification DO stub for the current user
function getNotificationStub(env: Env, userId: string): DurableObjectStub<NotificationService> {
  return env.NOTIFICATION.get(
    env.NOTIFICATION.idFromName(userId)
  ) as DurableObjectStub<NotificationService>;
}

// GET /api/notifications — list notifications
notificationRoutes.get('/', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const stub = getNotificationStub(c.env, userId);

  const cursor = c.req.query('cursor');
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw errors.badRequest('limit must be a positive integer');
  }
  const VALID_FILTERS = ['all', 'unread'] as const;
  const filterRaw = c.req.query('filter');
  const filter: 'all' | 'unread' | undefined =
    filterRaw && (VALID_FILTERS as readonly string[]).includes(filterRaw)
      ? (filterRaw as 'all' | 'unread')
      : undefined;
  if (filterRaw && !filter) {
    throw errors.badRequest(`Invalid filter value: ${filterRaw}`);
  }
  const typeRaw = c.req.query('type');
  const type: NotificationType | undefined =
    typeRaw && NOTIFICATION_TYPES.includes(typeRaw as NotificationType)
      ? (typeRaw as NotificationType)
      : undefined;
  const projectId = c.req.query('projectId');

  if (typeRaw && !type) {
    throw errors.badRequest(`Invalid notification type: ${typeRaw}`);
  }

  const result = await stub.listNotifications(userId, { cursor, limit, filter, type, projectId });
  return c.json(result);
});

// GET /api/notifications/unread-count
notificationRoutes.get('/unread-count', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const stub = getNotificationStub(c.env, userId);
  const count = await stub.getUnreadCountRpc(userId);
  return c.json({ count });
});

// POST /api/notifications/read-all — must be before /:id/read to avoid being shadowed
notificationRoutes.post('/read-all', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const stub = getNotificationStub(c.env, userId);
  await stub.markAllRead(userId);
  return c.json({ success: true });
});

// POST /api/notifications/:id/read
notificationRoutes.post('/:id/read', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const notificationId = c.req.param('id');
  if (!notificationId) throw errors.badRequest('Notification ID is required');

  const stub = getNotificationStub(c.env, userId);
  await stub.markRead(userId, notificationId);
  return c.json({ success: true });
});

// POST /api/notifications/:id/dismiss
notificationRoutes.post('/:id/dismiss', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const notificationId = c.req.param('id');
  if (!notificationId) throw errors.badRequest('Notification ID is required');

  const stub = getNotificationStub(c.env, userId);
  await stub.dismissNotification(userId, notificationId);
  return c.json({ success: true });
});

// GET /api/notifications/preferences
notificationRoutes.get('/preferences', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const stub = getNotificationStub(c.env, userId);
  const preferences = await stub.getPreferences(userId);
  return c.json({ preferences });
});

// PUT /api/notifications/preferences
notificationRoutes.put('/preferences', requireAuth(), requireApproved(), jsonValidator(UpdateNotificationPreferenceSchema), async (c) => {
  const userId = getUserId(c);
  const body = c.req.valid('json');

  const stub = getNotificationStub(c.env, userId);
  await stub.updatePreference(
    userId,
    body.notificationType,
    body.channel,
    body.enabled,
    body.projectId
  );
  return c.json({ success: true });
});

// GET /api/notifications/ws — WebSocket upgrade
notificationRoutes.get('/ws', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    throw errors.badRequest('Expected WebSocket upgrade');
  }

  const stub = getNotificationStub(c.env, userId);
  // Forward the WebSocket upgrade request to the DO
  const url = new URL(c.req.url);
  url.pathname = '/ws';
  const doRequest = new Request(url.toString(), {
    headers: c.req.raw.headers,
  });
  return stub.fetch(doRequest);
});

export { notificationRoutes };
