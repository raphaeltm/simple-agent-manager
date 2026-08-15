import {
  NOTIFICATION_TYPES,
  NOTIFICATION_URGENCIES,
  type NotificationResponse,
} from '@simple-agent-manager/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as v from 'valibot';

import {
  dismissNotification as apiDismiss,
  getNotificationUnreadCount,
  getNotificationWsUrl,
  listNotifications,
  markAllNotificationsRead as apiMarkAllRead,
  markNotificationRead as apiMarkRead,
} from '../lib/api';

const RECONNECT_BASE_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_RETRIES = 10;
const PING_INTERVAL_MS = 30000;

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

/**
 * Validates an incoming WebSocket frame against the full NotificationWsMessage
 * contract (kept in sync with packages/shared/src/types/notification.ts).
 * Replaces a prior partial guard that only checked `notification?.id` was a
 * string — any other malformed field (or a missing notification object) used
 * to silently reach state. A frame that fails validation is dropped entirely.
 */
const notificationWsMessageSchema = v.variant('type', [
  v.object({ type: v.literal('notification.new'), notification: notificationResponseSchema }),
  v.object({ type: v.literal('notification.updated'), notification: notificationResponseSchema }),
  v.object({ type: v.literal('notification.read'), notificationId: v.string() }),
  v.object({ type: v.literal('notification.dismissed'), notificationId: v.string() }),
  v.object({ type: v.literal('notification.all_read') }),
  v.object({ type: v.literal('notification.unread_count'), count: v.number() }),
  v.object({ type: v.literal('pong') }),
]);

/**
 * Validates a REST `listNotifications()` response's `notifications` array
 * against the SAME `notificationResponseSchema` the WebSocket path validates
 * `notification.new` / `notification.updated` frames against (see
 * `notificationWsMessageSchema` above), so the REST and WS entry points into
 * `notifications` state agree on what "valid" means — an urgency/type/shape
 * the WS path would reject can no longer sneak in via the initial fetch,
 * refresh, or pagination.
 *
 * A non-array input degrades to an empty list (NotificationCenter renders in
 * the app shell on every page and calls `.filter` on this state). Each item
 * is validated individually: a malformed item is dropped and logged, but
 * valid items around it are kept — one bad item must not blank the list.
 */
function parseNotificationListItems(items: unknown, context: string): NotificationResponse[] {
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

export interface UseNotificationsReturn {
  notifications: NotificationResponse[];
  unreadCount: number;
  loading: boolean;
  connectionState: 'connecting' | 'connected' | 'disconnected';
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  loadMore: () => Promise<void>;
  hasMore: boolean;
  refresh: () => Promise<void>;
}

export function useNotifications(): UseNotificationsReturn {
  const [notifications, setNotifications] = useState<NotificationResponse[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [connectionState, setConnectionState] = useState<
    'connecting' | 'connected' | 'disconnected'
  >('disconnected');
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pingTimerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const mountedRef = useRef(true);
  const connectRef = useRef<() => void>(() => {});

  // Initial fetch of notifications
  const fetchNotifications = useCallback(async () => {
    try {
      setLoading(true);
      const result = await listNotifications({ limit: 50 });
      if (!mountedRef.current) return;
      // Guard the shape: NotificationCenter renders in the app shell on every
      // page, so a malformed payload here must degrade to an empty list — not
      // crash the whole app through the ErrorBoundary (undefined.filter). Each
      // item is also schema-validated (parseNotificationListItems), so one
      // malformed notification cannot poison the rest.
      setNotifications(parseNotificationListItems(result.notifications, 'fetchNotifications'));
      setUnreadCount(typeof result.unreadCount === 'number' ? result.unreadCount : 0);
      setNextCursor(result.nextCursor ?? null);
    } catch (err) {
      console.error('Failed to fetch notifications:', err);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // Load more (pagination)
  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    try {
      const result = await listNotifications({ cursor: nextCursor, limit: 50 });
      if (!mountedRef.current) return;
      const more = parseNotificationListItems(result.notifications, 'loadMore');
      setNotifications((prev) => [...prev, ...more]);
      setNextCursor(result.nextCursor ?? null);
    } catch (err) {
      console.error('Failed to load more notifications:', err);
    }
  }, [nextCursor]);

  // Mark single notification as read
  const markRead = useCallback(async (id: string) => {
    try {
      await apiMarkRead(id);
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch (err) {
      console.error('Failed to mark notification read:', err);
    }
  }, []);

  // Mark all as read
  const markAllRead = useCallback(async () => {
    try {
      await apiMarkAllRead();
      setNotifications((prev) =>
        prev.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() }))
      );
      setUnreadCount(0);
    } catch (err) {
      console.error('Failed to mark all notifications read:', err);
    }
  }, []);

  // Dismiss notification
  const dismiss = useCallback(async (id: string) => {
    try {
      await apiDismiss(id);
      setNotifications((prev) => prev.filter((n) => n.id !== id));
      // Re-fetch unread count
      const { count } = await getNotificationUnreadCount();
      if (mountedRef.current) setUnreadCount(typeof count === 'number' ? count : 0);
    } catch (err) {
      console.error('Failed to dismiss notification:', err);
    }
  }, []);

  // WebSocket connection
  useEffect(() => {
    mountedRef.current = true;

    const connect = () => {
      if (!mountedRef.current) return;

      try {
        const ws = new WebSocket(getNotificationWsUrl());
        wsRef.current = ws;
        setConnectionState('connecting');

        ws.onopen = () => {
          if (!mountedRef.current) {
            ws.close();
            return;
          }
          setConnectionState('connected');
          retriesRef.current = 0;

          // Start ping keep-alive
          pingTimerRef.current = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ping' }));
            }
          }, PING_INTERVAL_MS);
        };

        ws.onmessage = (event) => {
          if (!mountedRef.current) return;

          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data) as unknown;
          } catch {
            // Ignore non-JSON messages
            return;
          }

          const result = v.safeParse(notificationWsMessageSchema, parsed);
          if (!result.success) {
            console.warn('Dropping malformed notification WebSocket frame', result.issues);
            return;
          }
          const msg = result.output;

          switch (msg.type) {
            case 'notification.new':
              setNotifications((prev) => [msg.notification, ...prev]);
              setUnreadCount((prev) => prev + 1);
              break;

            case 'notification.updated': {
              // Reconcile unreadCount if readAt status changed
              setNotifications((prev) => {
                const existing = prev.find((n) => n.id === msg.notification.id);
                if (existing) {
                  if (!existing.readAt && msg.notification.readAt) {
                    setUnreadCount((c) => Math.max(0, c - 1));
                  } else if (existing.readAt && !msg.notification.readAt) {
                    setUnreadCount((c) => c + 1);
                  }
                }
                return prev.map((n) => (n.id === msg.notification.id ? msg.notification : n));
              });
              break;
            }

            case 'notification.read':
              setNotifications((prev) =>
                prev.map((n) =>
                  n.id === msg.notificationId ? { ...n, readAt: new Date().toISOString() } : n
                )
              );
              break;

            case 'notification.dismissed':
              setNotifications((prev) => prev.filter((n) => n.id !== msg.notificationId));
              break;

            case 'notification.all_read':
              setNotifications((prev) =>
                prev.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() }))
              );
              break;

            case 'notification.unread_count':
              setUnreadCount(msg.count);
              break;

            case 'pong':
              break;
          }
        };

        ws.onclose = () => {
          if (pingTimerRef.current) clearInterval(pingTimerRef.current);
          if (!mountedRef.current) return;

          setConnectionState('disconnected');
          scheduleReconnect();
        };

        ws.onerror = () => {
          // onclose will fire after this
        };
      } catch {
        scheduleReconnect();
      }
    };

    const scheduleReconnect = () => {
      if (!mountedRef.current) return;
      if (retriesRef.current >= MAX_RETRIES) {
        setConnectionState('disconnected');
        return;
      }

      const delay = Math.min(
        RECONNECT_BASE_DELAY * Math.pow(2, retriesRef.current),
        MAX_RECONNECT_DELAY
      );
      retriesRef.current++;
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    connectRef.current = connect;

    // Initial fetch + connect
    fetchNotifications();
    connect();

    return () => {
      mountedRef.current = false;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
    };
  }, [fetchNotifications]);

  return {
    notifications,
    unreadCount,
    loading,
    connectionState,
    markRead,
    markAllRead,
    dismiss,
    loadMore,
    hasMore: nextCursor !== null,
    refresh: fetchNotifications,
  };
}
