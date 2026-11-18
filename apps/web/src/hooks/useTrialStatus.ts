import { useQuery } from '@tanstack/react-query';

// NOTE: deliberately the client-side `TrialStatusResponse` from `lib/api`, NOT the
// same-named interface in `@simple-agent-manager/shared`. They are different shapes
// (`{available, agentType, hasInfraCredential, …}` vs `{enabled, remaining, resetsAt}`)
// and only this one describes what `GET /api/trial-status` returns to the browser.
import type { TrialStatusResponse } from '../lib/api';
import { trialStatusQueryOptions } from '../lib/query-options';

interface UseTrialStatusResult {
  trial: TrialStatusResponse | null;
  /**
   * Whether the installation provides machines: an enabled platform cloud credential exists, so
   * SAM can provision for a user who has no cloud account of their own. This is independent of
   * the SAM-managed AI proxy (`hasAgentCredential`); an install with the proxy off still has
   * installation compute, and agents then use the user's own agent credential.
   */
  platformCompute: boolean;
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Installation platform compute availability (`GET /api/trial-status`; the path name predates
 * the retired anonymous-trial product).
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
    platformCompute: query.data?.hasInfraCredential === true,
    loading: Boolean(queryScope) && query.isPending && query.data === undefined,
    isRefreshing: query.isFetching && query.data !== undefined,
    error:
      query.data === undefined && query.error
        ? query.error instanceof Error
          ? query.error.message
          : 'Failed to load platform compute status'
        : null,
    refresh: () => {
      void query.refetch();
    },
  };
}
