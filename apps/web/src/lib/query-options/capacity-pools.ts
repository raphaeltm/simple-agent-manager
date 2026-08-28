import { queryOptions } from '@tanstack/react-query';

import { fetchProjectDefaultCapacityPools } from '../api/capacity-pools';

/**
 * Default capacity pool summaries expose credential-derived metadata and are
 * intentionally not persisted. Keep the key scoped to the authenticated user so
 * admin-only installation summaries cannot bleed between sessions.
 */
export const capacityPoolQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'capacity-pools'] as const,
  projectDefaults: (queryScope: string, projectId: string) =>
    [...capacityPoolQueryKeys.all(queryScope), 'project-defaults', projectId] as const,
};

export function projectDefaultCapacityPoolsQueryOptions(queryScope: string, projectId: string) {
  return queryOptions({
    queryKey: capacityPoolQueryKeys.projectDefaults(queryScope, projectId),
    queryFn: () => fetchProjectDefaultCapacityPools(projectId),
    enabled: Boolean(queryScope && projectId),
  });
}
