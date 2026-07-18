import type { ProviderCatalog } from '@simple-agent-manager/shared';
import { useEffect, useState } from 'react';

import { getProviderCatalog } from '../lib/api';

interface UseProviderCatalogResult {
  catalogs: ProviderCatalog[];
  /** First catalog (convenience for single-provider setups). */
  catalog: ProviderCatalog | null;
  loading: boolean;
}

/**
 * Shared hook for loading the provider catalog.
 * Returns all available catalogs and a convenience `catalog` for single-provider use.
 */
export function useProviderCatalog(): UseProviderCatalogResult {
  const [catalogs, setCatalogs] = useState<ProviderCatalog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getProviderCatalog()
      .then((resp) => setCatalogs(Array.isArray(resp.catalogs) ? resp.catalogs : []))
      .catch(() => { /* catalog unavailable — consumers use fallbacks */ })
      .finally(() => setLoading(false));
  }, []);

  return {
    catalogs,
    catalog: catalogs[0] ?? null,
    loading,
  };
}
