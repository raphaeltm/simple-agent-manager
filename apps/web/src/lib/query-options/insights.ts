/**
 * Query key and options for Insights · Flow. One key per project and range, shared by the
 * Insights page and the Project Overview's "This week" pane (7 days), so opening one warms the
 * other. Not persisted (idea titles). Ranges are days long, so the read stays fresh for
 * `INSIGHTS_STALE_TIME_MS` and refetches in the background after that (stale-while-revalidate).
 */
import type { InsightsRange } from '@simple-agent-manager/shared';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';

import { getProjectFlow } from '../api';
import { INSIGHTS_STALE_TIME_MS } from '../query-stale-times';

export const insightsQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'insights'] as const,
  flow: (queryScope: string, projectId: string, range: InsightsRange) =>
    [...insightsQueryKeys.all(queryScope), 'flow', projectId, range] as const,
};

export function projectFlowQueryOptions(
  queryScope: string,
  projectId: string,
  range: InsightsRange
) {
  return queryOptions({
    queryKey: insightsQueryKeys.flow(queryScope, projectId, range),
    queryFn: () => getProjectFlow(projectId, range),
    staleTime: INSIGHTS_STALE_TIME_MS,
    // Switching range keeps the last range on screen until the new one arrives.
    placeholderData: keepPreviousData,
  });
}
