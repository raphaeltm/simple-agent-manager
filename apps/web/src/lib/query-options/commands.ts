import { queryOptions } from '@tanstack/react-query';

import { getCachedCommands } from '../api';
import { CACHED_COMMANDS_STALE_TIME_MS } from '../query-stale-times';

export const commandQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'commands'] as const,
  cached: (queryScope: string, projectId: string, refreshKey?: string | null) =>
    [
      ...commandQueryKeys.all(queryScope),
      'cached',
      projectId,
      { refreshKey: refreshKey ?? null },
    ] as const,
};

export function cachedCommandsQueryOptions(
  queryScope: string,
  projectId: string,
  refreshKey?: string | null
) {
  return queryOptions({
    queryKey: commandQueryKeys.cached(queryScope, projectId, refreshKey),
    queryFn: () => getCachedCommands(projectId),
    staleTime: CACHED_COMMANDS_STALE_TIME_MS,
  });
}
