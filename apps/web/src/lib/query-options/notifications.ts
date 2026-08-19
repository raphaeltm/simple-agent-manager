import { queryOptions } from '@tanstack/react-query';

import { getNotificationPreferences } from '../api';

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
};

export function notificationPreferencesQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: notificationQueryKeys.preferences(queryScope),
    queryFn: getNotificationPreferences,
    retry: false,
  });
}
