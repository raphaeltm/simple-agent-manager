/**
 * Query key and options for Admin Health & cost (Insights slice H).
 *
 * Keyed `['auth', queryScope, 'admin-health-cost', range]` like every authenticated query. No
 * polling: the numbers move over hours and days, and the page refetches on focus and on a range
 * change while keeping the previous range on screen (stale-while-revalidate).
 */
import type { InstallationHealthRange } from '@simple-agent-manager/shared';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';

import { getInstallationHealth } from '../api';

export const adminHealthCostQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'admin-health-cost'] as const,
  range: (queryScope: string, range: InstallationHealthRange) =>
    [...adminHealthCostQueryKeys.all(queryScope), range] as const,
};

export function adminHealthCostQueryOptions(queryScope: string, range: InstallationHealthRange) {
  return queryOptions({
    queryKey: adminHealthCostQueryKeys.range(queryScope, range),
    queryFn: ({ signal }) => getInstallationHealth(range, signal),
    placeholderData: keepPreviousData,
  });
}
