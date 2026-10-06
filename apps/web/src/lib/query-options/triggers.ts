import { queryOptions } from '@tanstack/react-query';

import { listTriggers } from '../api';

export const triggerQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'triggers'] as const,
  list: (queryScope: string, projectId: string) =>
    [...triggerQueryKeys.all(queryScope), 'list', projectId] as const,
};

export function triggersQueryOptions(queryScope: string, projectId: string) {
  return queryOptions({
    queryKey: triggerQueryKeys.list(queryScope, projectId),
    queryFn: async () => (await listTriggers(projectId)).triggers,
  });
}
