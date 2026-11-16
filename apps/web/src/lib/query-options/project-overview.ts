/**
 * Query key and options for the Project Overview's aggregated read.
 *
 * Keyed `['auth', queryScope, 'project-overview', projectId]` like every authenticated query.
 * Not persisted: it carries chat topics and idea titles. `refetchInterval` is a backstop that
 * stops on a hidden tab (`poll-intervals.ts`); Running now is refreshed by the project socket.
 */
import { queryOptions } from '@tanstack/react-query';

import { getProjectOverview } from '../api';
import { PROJECT_OVERVIEW_POLL_MS } from '../poll-intervals';

export const projectOverviewQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'project-overview'] as const,
  detail: (queryScope: string, projectId: string) =>
    [...projectOverviewQueryKeys.all(queryScope), projectId] as const,
};

export function projectOverviewQueryOptions(queryScope: string, projectId: string) {
  return queryOptions({
    queryKey: projectOverviewQueryKeys.detail(queryScope, projectId),
    queryFn: () => getProjectOverview(projectId),
    refetchInterval: PROJECT_OVERVIEW_POLL_MS,
  });
}
