import type { DashboardTask } from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';

import { ACTIVE_TASKS_POLL_MS } from '../lib/poll-intervals';
import { activeTasksQueryOptions } from '../lib/query-options';

interface UseActiveTasksOptions {
  /** Authenticated identity that scopes the cache entry (`user.id`). */
  queryScope: string;
  /** Polling cadence in ms. Zero disables polling. */
  pollInterval?: number;
}

interface UseActiveTasksResult {
  tasks: DashboardTask[];
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Cross-project active tasks for the dashboard.
 *
 * Replaces a hand-rolled `useState`/`useEffect`/`setInterval` triplet whose poll had
 * no visibility check, so it kept issuing requests in hidden background tabs.
 * `refetchInterval` stops on a hidden tab — see `lib/poll-intervals.ts`.
 */
export function useActiveTasks(options: UseActiveTasksOptions): UseActiveTasksResult {
  const { queryScope, pollInterval = ACTIVE_TASKS_POLL_MS } = options;

  const query = useQuery({
    ...activeTasksQueryOptions(queryScope),
    enabled: Boolean(queryScope),
    refetchInterval: pollInterval > 0 ? pollInterval : false,
  });

  return {
    tasks: query.data ?? [],
    loading: Boolean(queryScope) && query.isPending && query.data === undefined,
    isRefreshing: query.isFetching && query.data !== undefined,
    // A failed background refetch must not blank a list we can still show, so an
    // error is only surfaced when there is nothing cached to fall back to.
    error:
      query.data === undefined && query.error
        ? query.error instanceof Error
          ? query.error.message
          : 'Failed to load active tasks'
        : null,
    refresh: () => {
      void query.refetch();
    },
  };
}
