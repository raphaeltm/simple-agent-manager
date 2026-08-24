import type { NotificationResponse } from '@simple-agent-manager/shared';
import { queryOptions } from '@tanstack/react-query';

import {
  getNotificationPreferences,
  getNotificationUnreadCount,
  listNotifications,
} from '../api';
import { parseNotificationListItems } from '../notification-validation';

export type NotificationListParams = Parameters<typeof listNotifications>[0];

export interface NotificationsListQueryData {
  notifications: NotificationResponse[];
  unreadCount: number;
  nextCursor: string | null;
}

/**
 * Per-user notification preferences (`GET /api/notifications/preferences`).
 *
 * Already on TanStack Query, but under the unscoped literal key
 * `['notification-preferences']`. Scoped here for the same defence-in-depth reason
 * described in `infrastructure.ts`.
 *
 * `retry: false` is preserved from the original call site: a failed preferences read
 * should surface immediately rather than delay the settings page behind a retry.
 */
export const notificationQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'notifications'] as const,
  preferences: (queryScope: string) =>
    [...notificationQueryKeys.all(queryScope), 'preferences'] as const,
  list: (queryScope: string, params?: NotificationListParams) =>
    [...notificationQueryKeys.all(queryScope), 'list', params ?? {}] as const,
  unreadCount: (queryScope: string) =>
    [...notificationQueryKeys.all(queryScope), 'unread-count'] as const,
  timelineProgress: (
    queryScope: string,
    projectId: string,
    sessionId: string,
    maxPages: number
  ) =>
    [
      ...notificationQueryKeys.all(queryScope),
      'timeline-progress',
      projectId,
      sessionId,
      { maxPages },
    ] as const,
};

export function notificationPreferencesQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: notificationQueryKeys.preferences(queryScope),
    queryFn: getNotificationPreferences,
    retry: false,
  });
}

export function notificationsListQueryOptions(
  queryScope: string,
  params: NotificationListParams = {}
) {
  return queryOptions({
    queryKey: notificationQueryKeys.list(queryScope, params),
    queryFn: async (): Promise<NotificationsListQueryData> => {
      const response = await listNotifications(params);
      return {
        notifications: parseNotificationListItems(response.notifications, 'listNotifications'),
        unreadCount: typeof response.unreadCount === 'number' ? response.unreadCount : 0,
        nextCursor: response.nextCursor ?? null,
      };
    },
  });
}

export function notificationUnreadCountQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: notificationQueryKeys.unreadCount(queryScope),
    queryFn: async () => {
      const response = await getNotificationUnreadCount();
      return typeof response.count === 'number' ? response.count : 0;
    },
  });
}

export async function fetchTimelineProgressNotifications(
  projectId: string,
  sessionId: string,
  maxPages: number
) {
  const notificationPages: NotificationResponse[][] = [];
  let cursor: string | undefined;
  let pages = 0;

  while (pages++ < maxPages) {
    const response = await listNotifications({
      projectId,
      sessionId,
      type: 'progress',
      cursor,
    });
    const notifications = parseNotificationListItems(
      response.notifications,
      'timelineProgressNotifications'
    );
    notificationPages.push(notifications);

    if (!response.nextCursor || notifications.length === 0) break;
    if (response.nextCursor === cursor) break;
    cursor = response.nextCursor;
  }

  return notificationPages.flat();
}

export function timelineProgressNotificationsQueryOptions(
  queryScope: string,
  projectId: string,
  sessionId: string,
  maxPages: number
) {
  return queryOptions({
    queryKey: notificationQueryKeys.timelineProgress(queryScope, projectId, sessionId, maxPages),
    queryFn: () => fetchTimelineProgressNotifications(projectId, sessionId, maxPages),
  });
}
