import { queryOptions } from '@tanstack/react-query';

import { getTrialStatus } from '../api';
import { TRIAL_STATUS_STALE_TIME_MS } from '../query-stale-times';

/**
 * Installation platform compute availability (`GET /api/trial-status`).
 *
 * Read to decide whether a user without their own cloud credential can still
 * provision. Project chat routes through this key.
 */
export const trialQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'trial'] as const,
  status: (queryScope: string) => [...trialQueryKeys.all(queryScope), 'status'] as const,
};

export function trialStatusQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: trialQueryKeys.status(queryScope),
    queryFn: getTrialStatus,
    staleTime: TRIAL_STATUS_STALE_TIME_MS,
  });
}
