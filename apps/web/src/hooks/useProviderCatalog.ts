import type { ProviderCatalog } from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';

import { providerCatalogQueryOptions } from '../lib/query-options';

interface UseProviderCatalogResult {
  catalogs: ProviderCatalog[];
  /** First catalog (convenience for single-provider setups). */
  catalog: ProviderCatalog | null;
  loading: boolean;
  isRefreshing: boolean;
}

/**
 * VM sizes, locations and prices per cloud provider.
 *
 * Effectively static between deploys, so it carries a long `staleTime`
 * (`lib/query-stale-times.ts`) — in practice a session fetches it once.
 *
 * Failures stay silent, preserving the previous behaviour: every consumer has its
 * own fallback size/location list, so an unavailable catalog degrades to those
 * defaults rather than blocking workspace creation behind an error.
 */
export function useProviderCatalog(queryScope: string): UseProviderCatalogResult {
  const query = useQuery({
    ...providerCatalogQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });

  const catalogs = query.data ?? [];

  return {
    catalogs,
    catalog: catalogs[0] ?? null,
    loading: Boolean(queryScope) && query.isPending && query.data === undefined,
    isRefreshing: query.isFetching && query.data !== undefined,
  };
}
