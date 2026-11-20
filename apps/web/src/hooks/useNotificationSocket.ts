import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import * as v from 'valibot';

import { isUpdateNotification } from '../components/notifications/notification-type-config';
import { getNotificationWsUrl } from '../lib/api';
import { notificationWsMessageSchema } from '../lib/notification-validation';
import { inboxQueryKeys, notificationQueryKeys } from '../lib/query-options';
import { useQueryScope } from './useQueryScope';

const RECONNECT_BASE_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_RETRIES = 10;
const PING_INTERVAL_MS = 30000;

/**
 * Coalesces a burst of socket events into one refetch. Override with
 * VITE_NOTIFICATION_REFRESH_DEBOUNCE_MS.
 */
const DEFAULT_NOTIFICATION_REFRESH_DEBOUNCE_MS = 750;
const configuredDebounceMs = Number.parseInt(
  import.meta.env.VITE_NOTIFICATION_REFRESH_DEBOUNCE_MS ?? '',
  10
);
export const NOTIFICATION_REFRESH_DEBOUNCE_MS =
  Number.isFinite(configuredDebounceMs) && configuredDebounceMs >= 0
    ? configuredDebounceMs
    : DEFAULT_NOTIFICATION_REFRESH_DEBOUNCE_MS;

/**
 * The app's one notification WebSocket, mounted by `AppShell`. It holds no state of its own: each
 * event marks the cached notification lists (the inbox's Updates) stale, and an event about an ask
 * (a notification whose type is an inbox item, `NOTIFICATION_INBOX_ROLE`) also marks the inbox
 * lists and counts stale. Bursts are coalesced, open items are left alone (the walk's stale check
 * and focus refetch cover them), and a reconnect refetches both, since events sent while the socket
 * was down are lost. This replaces polling (slice C, idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9).
 */
export function useNotificationSocket(): void {
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const pending = useRef({ notifications: false, inbox: false });
  const flushTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!queryScope) return undefined;
    let mounted = true;
    let ws: WebSocket | null = null;
    let retries = 0;
    let opened = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;

    const flush = () => {
      flushTimer.current = undefined;
      const { notifications, inbox } = pending.current;
      pending.current = { notifications: false, inbox: false };
      if (notifications)
        void queryClient.invalidateQueries({ queryKey: notificationQueryKeys.all(queryScope) });
      if (inbox) {
        void queryClient.invalidateQueries({ queryKey: inboxQueryKeys.lists(queryScope) });
        void queryClient.invalidateQueries({ queryKey: inboxQueryKeys.counts(queryScope) });
        // The open item too: an agent's response lands in its conversation. Only a mounted
        // item read refetches; cached ones are marked stale.
        void queryClient.invalidateQueries({ queryKey: inboxQueryKeys.items(queryScope) });
      }
    };
    const schedule = (inbox: boolean) => {
      pending.current.notifications = true;
      if (inbox) pending.current.inbox = true;
      if (flushTimer.current === undefined)
        flushTimer.current = setTimeout(flush, NOTIFICATION_REFRESH_DEBOUNCE_MS);
    };

    const scheduleReconnect = () => {
      if (!mounted || retries >= MAX_RETRIES) return;
      const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, retries), MAX_RECONNECT_DELAY);
      retries++;
      reconnectTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (!mounted) return;
      try {
        const socket = new WebSocket(getNotificationWsUrl());
        ws = socket;
        socket.onopen = () => {
          if (!mounted) {
            socket.close();
            return;
          }
          retries = 0;
          // Anything sent while the socket was down was missed: catch up once.
          if (opened) schedule(true);
          opened = true;
          pingTimer = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
          }, PING_INTERVAL_MS);
        };
        socket.onmessage = (event: MessageEvent) => {
          if (!mounted) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(String(event.data));
          } catch {
            return;
          }
          const result = v.safeParse(notificationWsMessageSchema, parsed);
          if (!result.success) {
            console.warn('Dropping malformed notification WebSocket frame', result.issues);
            return;
          }
          const msg = result.output;
          if (msg.type === 'pong') return;
          const aboutAnAsk =
            (msg.type === 'notification.new' || msg.type === 'notification.updated') &&
            !isUpdateNotification(msg.notification.type);
          schedule(aboutAnAsk);
        };
        socket.onclose = () => {
          if (pingTimer) clearInterval(pingTimer);
          scheduleReconnect();
        };
        socket.onerror = () => {
          // onclose follows.
        };
      } catch {
        scheduleReconnect();
      }
    };

    connect();
    return () => {
      mounted = false;
      ws?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = undefined;
      }
    };
  }, [queryClient, queryScope]);
}
