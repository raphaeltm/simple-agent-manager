import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationResponse, NotificationWsMessage } from '@simple-agent-manager/shared';
import {
  getNotificationWsUrl,
  listNotifications,
  getNotificationUnreadCount,
  markNotificationRead as apiMarkRead,
  markAllNotificationsRead as apiMarkAllRead,
  dismissNotification as apiDismiss,
} from '../lib/api';

const RECONNECT_BASE_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_RETRIES = 10;
const PING_INTERVAL_MS = 30000;

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
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const pingTimerRef = useRef<ReturnType<typeof setInterval>>();
  const mountedRef = useRef(true);
  const connectRef = useRef<() => void>(() => {});

  // Initial fetch of notifications
  const fetchNotifications = useCallback(async () => {
    try {
      setLoading(true);
      const result = await listNotifications({ limit: 50 });
      if (!mountedRef.current) return;
      setNotifications(result.notifications);
      setUnreadCount(result.unreadCount);
      setNextCursor(result.nextCursor);
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
      setNotifications((prev) => [...prev, ...result.notifications]);
      setNextCursor(result.nextCursor);
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
      // If dismissed notification was unread, decrement count
      setNotifications((prev) => {
        // We already filtered, so just update unread count
        return prev;
      });
      // Re-fetch unread count
      const { count } = await getNotificationUnreadCount();
      if (mountedRef.current) setUnreadCount(count);
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
          if (!mountedRef.current) { ws.close(); return; }
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
          try {
            const msg = JSON.parse(event.data) as NotificationWsMessage;

            switch (msg.type) {
              case 'notification.new':
                setNotifications((prev) => [msg.notification, ...prev]);
                setUnreadCount((prev) => prev + 1);
                break;

              case 'notification.read':
                setNotifications((prev) =>
                  prev.map((n) =>
                    n.id === msg.notificationId
                      ? { ...n, readAt: new Date().toISOString() }
                      : n
                  )
                );
                break;

              case 'notification.dismissed':
                setNotifications((prev) =>
                  prev.filter((n) => n.id !== msg.notificationId)
                );
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
          } catch {
            // Ignore non-JSON messages
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
