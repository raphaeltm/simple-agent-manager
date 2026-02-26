import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchAdminHealth } from '../lib/api';
import type { HealthSummary } from '@simple-agent-manager/shared';

export interface UseAdminHealthOptions {
  refreshIntervalMs?: number;
}

export interface UseAdminHealthReturn {
  health: HealthSummary | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const DEFAULT_REFRESH_INTERVAL = 30_000; // 30 seconds

export function useAdminHealth(options?: UseAdminHealthOptions): UseAdminHealthReturn {
  const { refreshIntervalMs = DEFAULT_REFRESH_INTERVAL } = options ?? {};

  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const result = await fetchAdminHealth();

      if (!mountedRef.current) return;

      setHealth(result);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load health data');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  // Auto-refresh interval
  useEffect(() => {
    if (!refreshIntervalMs || refreshIntervalMs <= 0) return;

    const intervalId = setInterval(() => {
      fetchHealth();
    }, refreshIntervalMs);

    return () => clearInterval(intervalId);
  }, [refreshIntervalMs, fetchHealth]);

  const refresh = useCallback(() => {
    fetchHealth();
  }, [fetchHealth]);

  return {
    health,
    loading,
    error,
    refresh,
  };
}
