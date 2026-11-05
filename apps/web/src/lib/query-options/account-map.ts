import { queryOptions } from '@tanstack/react-query';

import { getAccountMap } from '../api';

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
  });
}
