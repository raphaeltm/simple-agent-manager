import type { HealthSummary } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchAdminHealth } from '../lib/api';

export interface UseAdminHealthOptions {
  refreshIntervalMs?: number;
}

export interface UseAdminHealthReturn {
  health: HealthSummary | null;
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
}

const DEFAULT_REFRESH_INTERVAL = 30_000; // 30 seconds

export function useAdminHealth(options?: UseAdminHealthOptions): UseAdminHealthReturn {
  const { refreshIntervalMs = DEFAULT_REFRESH_INTERVAL } = options ?? {};

  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasLoadedRef = useRef(false);

  const fetchHealth = useCallback(async (signal?: AbortSignal) => {
    if (hasLoadedRef.current) {
      setIsRefreshing(true);
    }
    try {
      setError(null);

      const result = await fetchAdminHealth();

      if (signal?.aborted) return;

      setHealth(result);
    } catch (err) {
      if (!signal?.aborted) {
        setError(err instanceof Error ? err.message : 'Failed to load health data');
      }
    } finally {
      if (!signal?.aborted) {
        hasLoadedRef.current = true;
        setLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal);
    return () => { controller.abort(); };
  }, [fetchHealth]);

  // Auto-refresh interval
  useEffect(() => {
    if (!refreshIntervalMs || refreshIntervalMs <= 0) return;

    let controller: AbortController;
    const intervalId = setInterval(() => {
      controller = new AbortController();
      fetchHealth(controller.signal);
    }, refreshIntervalMs);

    return () => {
      clearInterval(intervalId);
      controller?.abort();
    };
  }, [refreshIntervalMs, fetchHealth]);

  const refresh = useCallback(() => {
    fetchHealth();
  }, [fetchHealth]);

  return {
    health,
    loading,
    isRefreshing,
    error,
    refresh,
  };
}
