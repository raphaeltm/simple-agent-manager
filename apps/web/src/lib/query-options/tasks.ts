import { queryOptions } from '@tanstack/react-query';

import { listActiveTasks } from '../api';

/**
 * The dashboard's cross-project active-task list (`GET /api/dashboard/active-tasks`).
 *
 * Polled every 15 s. Before this migration the poll was a bare `setInterval` with no
 * visibility check, so it kept issuing requests in background tabs indefinitely.
 * Driven through `refetchInterval` it stops on a hidden tab automatically — see the
 * note in `lib/poll-intervals.ts`.
 *
 * NOT persistable: `DashboardTask` carries user-authored task titles.
 */
export const taskQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'tasks'] as const,
  active: (queryScope: string) => [...taskQueryKeys.all(queryScope), 'active'] as const,
};

export function activeTasksQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: taskQueryKeys.active(queryScope),
    queryFn: async () => (await listActiveTasks()).tasks,
  });
}
