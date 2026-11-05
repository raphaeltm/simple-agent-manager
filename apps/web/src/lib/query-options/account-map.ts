import { queryOptions } from '@tanstack/react-query';

import { getAccountMap } from '../api';

/**
 * The map is an overview: refreshing once a minute keeps "Needs you" and "Live" honest while the
 * page stays open, without hammering the server (which caches the response for 30 s anyway).
 * The poll pauses while the tab is hidden (TanStack's default `refetchIntervalInBackground:
 * false`). Env-configurable per rule 60; read once at module load.
 */
const DEFAULT_ACCOUNT_MAP_REFETCH_INTERVAL_MS = 60_000;

function envInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const ACCOUNT_MAP_REFETCH_INTERVAL_MS = envInt(
  import.meta.env.VITE_ACCOUNT_MAP_REFETCH_INTERVAL_MS,
  DEFAULT_ACCOUNT_MAP_REFETCH_INTERVAL_MS
);

/**
 * The Account Map read (`GET /api/account-map`). One key per `activeOnly` value, matching the
 * server's two KV cache entries.
 *
 * NOT persistable: the response carries chat topics, task titles and node addresses.
 */
export const accountMapQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'account-map'] as const,
  map: (queryScope: string, activeOnly: boolean) =>
    [...accountMapQueryKeys.all(queryScope), 'map', activeOnly ? 'active' : 'all'] as const,
};

export function accountMapQueryOptions(queryScope: string, activeOnly: boolean) {
  return queryOptions({
    queryKey: accountMapQueryKeys.map(queryScope, activeOnly),
    queryFn: () => getAccountMap({ activeOnly }),
    refetchInterval: ACCOUNT_MAP_REFETCH_INTERVAL_MS,
  });
}
