import type { CredentialResponse } from '@simple-agent-manager/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { credentialQueryKeys, credentialsQueryOptions } from '../lib/query-options';

interface UseCredentialsResult {
  credentials: CredentialResponse[];
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * The user's cloud-provider credentials.
 *
 * Concurrent consumers are deduplicated into a single request, and a consumer
 * mounting inside the `staleTime` window reads the cache without a network hop.
 *
 * Five of the seven surfaces that read `GET /api/credentials` use this hook; see
 * `lib/query-options/credentials.ts` for which two do not yet.
 */
export function useCredentials(queryScope: string): UseCredentialsResult {
  const query = useQuery({
    ...credentialsQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });

  return {
    credentials: query.data ?? [],
    loading: Boolean(queryScope) && query.isPending && query.data === undefined,
    isRefreshing: query.isFetching && query.data !== undefined,
    error:
      query.data === undefined && query.error
        ? query.error instanceof Error
          ? query.error.message
          : 'Failed to load credentials'
        : null,
    refresh: () => {
      void query.refetch();
    },
  };
}

/**
 * Invalidator for every credential-derived query.
 *
 * Mutations call this instead of chaining a manual reload, so all consumers refresh
 * from one cache update rather than each re-running its own loader
 * (`.claude/rules/16-no-page-reload-on-mutation.md`).
 */
export function useInvalidateCredentials(queryScope: string): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: credentialQueryKeys.all(queryScope) });
  }, [queryClient, queryScope]);
}
