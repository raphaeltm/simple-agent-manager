import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchAdminErrors, type AdminErrorsFilter } from '../lib/api';
import type { PlatformError, PlatformErrorSource, PlatformErrorLevel } from '@simple-agent-manager/shared';

export type TimeRange = '1h' | '24h' | '7d' | '30d';

export interface AdminErrorsFilterState {
  source: PlatformErrorSource | 'all';
  level: PlatformErrorLevel | 'all';
  search: string;
  timeRange: TimeRange;
}

export interface UseAdminErrorsReturn {
  errors: PlatformError[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  total: number;
  filter: AdminErrorsFilterState;
  setSource: (source: PlatformErrorSource | 'all') => void;
  setLevel: (level: PlatformErrorLevel | 'all') => void;
  setSearch: (search: string) => void;
  setTimeRange: (range: TimeRange) => void;
  loadMore: () => void;
  refresh: () => void;
}

const TIME_RANGE_MS: Record<TimeRange, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export function useAdminErrors(): UseAdminErrorsReturn {
  const [errors, setErrors] = useState<PlatformError[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<AdminErrorsFilterState>({
    source: 'all',
    level: 'all',
    search: '',
    timeRange: '24h',
  });

  const cursorRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const buildFilter = useCallback((append: boolean): AdminErrorsFilter => {
    const now = Date.now();
    const startTime = new Date(now - TIME_RANGE_MS[filter.timeRange]).toISOString();

    return {
      source: filter.source !== 'all' ? filter.source : undefined,
      level: filter.level !== 'all' ? filter.level : undefined,
      search: filter.search || undefined,
      startTime,
      limit: 50,
      cursor: append ? cursorRef.current ?? undefined : undefined,
    };
  }, [filter]);

  const fetchErrors = useCallback(async (append = false) => {
    try {
      setLoading(true);
      setError(null);

      const result = await fetchAdminErrors(buildFilter(append));

      if (!mountedRef.current) return;

      if (append) {
        setErrors(prev => [...prev, ...result.errors]);
      } else {
        setErrors(result.errors);
      }

      cursorRef.current = result.cursor;
      setHasMore(result.hasMore);
      setTotal(result.total);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load errors');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [buildFilter]);

  // Re-fetch when filter changes (reset cursor)
  useEffect(() => {
    cursorRef.current = null;
    fetchErrors(false);
  }, [fetchErrors]);

  const setSource = useCallback((source: PlatformErrorSource | 'all') => {
    setFilter(prev => ({ ...prev, source }));
  }, []);

  const setLevel = useCallback((level: PlatformErrorLevel | 'all') => {
    setFilter(prev => ({ ...prev, level }));
  }, []);

  const setSearch = useCallback((search: string) => {
    setFilter(prev => ({ ...prev, search }));
  }, []);

  const setTimeRange = useCallback((timeRange: TimeRange) => {
    setFilter(prev => ({ ...prev, timeRange }));
  }, []);

  const loadMore = useCallback(() => {
    if (hasMore && !loading) {
      fetchErrors(true);
    }
  }, [hasMore, loading, fetchErrors]);

  const refresh = useCallback(() => {
    cursorRef.current = null;
    fetchErrors(false);
  }, [fetchErrors]);

  return {
    errors,
    loading,
    error,
    hasMore,
    total,
    filter,
    setSource,
    setLevel,
    setSearch,
    setTimeRange,
    loadMore,
    refresh,
  };
}
