import type { NotificationResponse } from '@simple-agent-manager/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as v from 'valibot';

import {
  dismissNotification as apiDismiss,
  getNotificationUnreadCount,
  getNotificationWsUrl,
  listNotifications,
  markAllNotificationsRead as apiMarkAllRead,
  markNotificationRead as apiMarkRead,
} from '../lib/api';
import {
  notificationWsMessageSchema,
  parseNotificationListItems,
} from '../lib/notification-validation';
import {
  notificationQueryKeys,
  type NotificationsListQueryData,
  notificationsListQueryOptions,
} from '../lib/query-options';
import { useQueryScope } from './useQueryScope';

const RECONNECT_BASE_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_RETRIES = 10;
const PING_INTERVAL_MS = 30000;
const INITIAL_NOTIFICATION_PARAMS = { limit: 50 } as const;

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
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const [connectionState, setConnectionState] = useState<
    'connecting' | 'connected' | 'disconnected'
  >('disconnected');

  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pingTimerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const mountedRef = useRef(true);
  const connectRef = useRef<() => void>(() => {});

  const listKey = useMemo(
    () => notificationQueryKeys.list(queryScope, INITIAL_NOTIFICATION_PARAMS),
    [queryScope]
  );

  const notificationsQuery = useQuery({
    ...notificationsListQueryOptions(queryScope, INITIAL_NOTIFICATION_PARAMS),
    enabled: Boolean(queryScope),
  });

  const updateNotificationCache = useCallback(
    (updater: (current: NotificationsListQueryData) => NotificationsListQueryData) => {
      queryClient.setQueryData<NotificationsListQueryData>(listKey, (previous) =>
        updater(previous ?? { notifications: [], unreadCount: 0, nextCursor: null })
      );
    },
    [listKey, queryClient]
  );

  // Load more (pagination)
  const loadMore = useCallback(async () => {
    const nextCursor = notificationsQuery.data?.nextCursor ?? null;
    if (!nextCursor) return;
    try {
      const result = await listNotifications({ cursor: nextCursor, limit: 50 });
      if (!mountedRef.current) return;
      const more = parseNotificationListItems(result.notifications, 'loadMore');
      updateNotificationCache((current) => ({
        notifications: [...current.notifications, ...more],
        unreadCount:
          typeof result.unreadCount === 'number' ? result.unreadCount : current.unreadCount,
        nextCursor: result.nextCursor ?? null,
      }));
    } catch (err) {
      console.error('Failed to load more notifications:', err);
    }
  }, [notificationsQuery.data?.nextCursor, updateNotificationCache]);

  const markReadMutation = useMutation({
    mutationFn: apiMarkRead,
    onSuccess: (_result, id) => {
      updateNotificationCache((current) => ({
        ...current,
        notifications: current.notifications.map((notification) =>
          notification.id === id
            ? { ...notification, readAt: new Date().toISOString() }
            : notification
        ),
        unreadCount: Math.max(0, current.unreadCount - 1),
      }));
    },
  });

  // Mark single notification as read
  const markRead = useCallback(async (id: string) => {
    try {
      await markReadMutation.mutateAsync(id);
    } catch (err) {
      console.error('Failed to mark notification read:', err);
    }
  }, [markReadMutation]);

  const markAllReadMutation = useMutation({
    mutationFn: apiMarkAllRead,
    onSuccess: () => {
      updateNotificationCache((current) => ({
        ...current,
        notifications: current.notifications.map((notification) =>
          notification.readAt ? notification : { ...notification, readAt: new Date().toISOString() }
        ),
        unreadCount: 0,
      }));
    },
  });

  // Mark all as read
  const markAllRead = useCallback(async () => {
    try {
      await markAllReadMutation.mutateAsync();
    } catch (err) {
      console.error('Failed to mark all notifications read:', err);
    }
  }, [markAllReadMutation]);

  const dismissMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiDismiss(id);
      const { count } = await getNotificationUnreadCount();
      return { id, unreadCount: typeof count === 'number' ? count : 0 };
    },
    onSuccess: ({ id, unreadCount }) => {
      updateNotificationCache((current) => ({
        ...current,
        notifications: current.notifications.filter((notification) => notification.id !== id),
        unreadCount,
      }));
    },
  });

  // Dismiss notification
  const dismiss = useCallback(async (id: string) => {
    try {
      await dismissMutation.mutateAsync(id);
    } catch (err) {
      console.error('Failed to dismiss notification:', err);
    }
  }, [dismissMutation]);

  const refresh = useCallback(async () => {
    await notificationsQuery.refetch();
  }, [notificationsQuery]);

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
              updateNotificationCache((current) => ({
                ...current,
                notifications: [msg.notification, ...current.notifications],
                unreadCount: current.unreadCount + 1,
              }));
              break;

            case 'notification.updated': {
              // Reconcile unreadCount if readAt status changed
              updateNotificationCache((current) => {
                const existing = current.notifications.find((n) => n.id === msg.notification.id);
                let unreadCount = current.unreadCount;
                if (existing) {
                  if (!existing.readAt && msg.notification.readAt) {
                    unreadCount = Math.max(0, unreadCount - 1);
                  } else if (existing.readAt && !msg.notification.readAt) {
                    unreadCount += 1;
                  }
                }
                return {
                  ...current,
                  unreadCount,
                  notifications: current.notifications.map((n) =>
                    n.id === msg.notification.id ? msg.notification : n
                  ),
                };
              });
              break;
            }

            case 'notification.read':
              updateNotificationCache((current) => ({
                ...current,
                notifications: current.notifications.map((n) =>
                  n.id === msg.notificationId ? { ...n, readAt: new Date().toISOString() } : n
                ),
              }));
              break;

            case 'notification.dismissed':
              updateNotificationCache((current) => ({
                ...current,
                notifications: current.notifications.filter((n) => n.id !== msg.notificationId),
              }));
              break;

            case 'notification.all_read':
              updateNotificationCache((current) => ({
                ...current,
                notifications: current.notifications.map((n) =>
                  n.readAt ? n : { ...n, readAt: new Date().toISOString() }
                ),
              }));
              break;

            case 'notification.unread_count':
              updateNotificationCache((current) => ({ ...current, unreadCount: msg.count }));
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

    // Query handles the initial REST fetch; this effect owns the WebSocket only.
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
  }, [updateNotificationCache]);

  return {
    notifications: notificationsQuery.data?.notifications ?? [],
    unreadCount: notificationsQuery.data?.unreadCount ?? 0,
    loading:
      Boolean(queryScope) && notificationsQuery.isPending && notificationsQuery.data === undefined,
    connectionState,
    markRead,
    markAllRead,
    dismiss,
    loadMore,
    hasMore: (notificationsQuery.data?.nextCursor ?? null) !== null,
    refresh,
  };
}
