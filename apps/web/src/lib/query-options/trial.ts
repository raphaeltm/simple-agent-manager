import { queryOptions } from '@tanstack/react-query';

import { getTrialStatus } from '../api';
import { TRIAL_STATUS_STALE_TIME_MS } from '../query-stale-times';

/**
 * Platform-funded trial availability (`GET /api/trial-status`).
 *
 * Read to decide whether a user without their own cloud credential can still
 * provision. Project chat routes through this key; `CreateWorkspace.tsx` and the
 * (currently unreferenced) `OnboardingChecklist.tsx` still fetch it directly, so the
 * consolidation here is partial — see the follow-up note in the PR.
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
