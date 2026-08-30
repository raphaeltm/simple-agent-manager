import { queryOptions } from '@tanstack/react-query';

import { fetchAdminProjectEventInspector } from '../api';

export const adminProjectEventQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'admin', 'project-events'] as const,
  inspector: (queryScope: string, projectId: string, limit?: number) =>
    [
      ...adminProjectEventQueryKeys.all(queryScope),
      'inspector',
      { projectId, limit: limit ?? null },
    ] as const,
};

export function adminProjectEventInspectorQueryOptions(
  queryScope: string,
  projectId: string,
  limit?: number
) {
  return queryOptions({
    queryKey: adminProjectEventQueryKeys.inspector(queryScope, projectId, limit),
    queryFn: () => fetchAdminProjectEventInspector(projectId, limit),
  });
}
