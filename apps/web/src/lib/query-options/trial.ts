import { queryOptions } from '@tanstack/react-query';

import { getTrialStatus } from '../api';
import { TRIAL_STATUS_STALE_TIME_MS } from '../query-stale-times';

/**
 * Platform-funded trial availability (`GET /api/trial-status`).
 *
 * Three surfaces read this to decide whether a user without their own cloud
 * credential can still provision — the onboarding checklist, workspace creation, and
 * project chat. Two of them fetched it in the same `Promise.all` as
 * `listCredentials`, so both requests duplicated across those surfaces.
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
