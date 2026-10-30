import type { HealthSummary } from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';

import { fetchAdminHealth } from '../lib/api';
import { useQueryScope } from './useQueryScope';

export interface UseAdminHealthOptions {
  refreshIntervalMs?: number;
}

export interface UseAdminHealthReturn {
  health: HealthSummary | null;
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
}

const DEFAULT_REFRESH_INTERVAL = 30_000; // 30 seconds

export function useAdminHealth(options?: UseAdminHealthOptions): UseAdminHealthReturn {
  const { refreshIntervalMs = DEFAULT_REFRESH_INTERVAL } = options ?? {};

  const scope = useQueryScope();
  const query = useQuery({
    queryKey: ['auth', scope, 'admin', 'health'],
    queryFn: ({ signal }) => fetchAdminHealth(signal),
    enabled: Boolean(scope),
    refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    refetchIntervalInBackground: false,
  });
  return {
    health: query.data ?? null,
    loading: query.isPending,
    isRefreshing: query.isFetching && query.data !== undefined,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : 'Failed to load health data'
      : null,
    refresh: () => {
      void query.refetch();
    },
  };
}
