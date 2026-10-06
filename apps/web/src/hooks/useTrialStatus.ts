import { useQuery } from '@tanstack/react-query';

// NOTE: deliberately the client-side `TrialStatusResponse` from `lib/api`, NOT the
// same-named interface in `@simple-agent-manager/shared`. They are different shapes
// (`{available, agentType, hasInfraCredential, …}` vs `{enabled, remaining, resetsAt}`)
// and only this one describes what `GET /api/trial-status` returns to the browser.
import type { TrialStatusResponse } from '../lib/api';
import { trialStatusQueryOptions } from '../lib/query-options';

interface UseTrialStatusResult {
  trial: TrialStatusResponse | null;
  /** Whether a platform-funded trial is currently claimable. */
  available: boolean;
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Platform-funded trial availability.
 *
 * Read alongside `useCredentials` wherever the app decides whether a user can
 * provision compute: SAM falls back to a platform cloud credential when the user has
 * none, so "no user credential" alone never means "cannot provision".
 */
export function useTrialStatus(queryScope: string): UseTrialStatusResult {
  const query = useQuery({
    ...trialStatusQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });

  return {
    trial: query.data ?? null,
    available: query.data?.available ?? false,
    loading: Boolean(queryScope) && query.isPending && query.data === undefined,
    isRefreshing: query.isFetching && query.data !== undefined,
    error:
      query.data === undefined && query.error
        ? query.error instanceof Error
          ? query.error.message
          : 'Failed to load trial status'
        : null,
    refresh: () => {
      void query.refetch();
    },
  };
}
