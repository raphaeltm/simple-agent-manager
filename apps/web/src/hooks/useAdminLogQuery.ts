import { useState, useEffect, useCallback, useRef } from 'react';
import { queryAdminLogs } from '../lib/api';
import type { AdminLogEntry } from '@simple-agent-manager/shared';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'log';
export type LogTimeRange = '1h' | '6h' | '24h' | '7d';

export interface LogFilterState {
  levels: LogLevel[];
  search: string;
  timeRange: LogTimeRange;
}

export interface UseAdminLogQueryReturn {
  logs: AdminLogEntry[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  filter: LogFilterState;
  setLevels: (levels: LogLevel[]) => void;
  setSearch: (search: string) => void;
  setTimeRange: (range: LogTimeRange) => void;
  loadMore: () => void;
  refresh: () => void;
}

const TIME_RANGE_MS: Record<LogTimeRange, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

export function useAdminLogQuery(): UseAdminLogQueryReturn {
  const [logs, setLogs] = useState<AdminLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState<LogFilterState>({
    levels: [],
    search: '',
    timeRange: '1h',
  });

  const cursorRef = useRef<string | null>(null);
  const queryIdRef = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const buildTimeRange = useCallback(() => {
    const now = new Date();
    const start = new Date(now.getTime() - TIME_RANGE_MS[filter.timeRange]);
    return {
      start: start.toISOString(),
      end: now.toISOString(),
    };
  }, [filter.timeRange]);

  const fetchLogs = useCallback(async (append = false) => {
    try {
      setLoading(true);
      setError(null);

      const result = await queryAdminLogs({
        timeRange: buildTimeRange(),
        levels: filter.levels.length > 0 ? filter.levels : undefined,
        search: filter.search || undefined,
        limit: 100,
        cursor: append ? cursorRef.current : undefined,
        queryId: append ? queryIdRef.current : undefined,
      });

      if (!mountedRef.current) return;

      if (append) {
        setLogs(prev => [...prev, ...result.logs]);
      } else {
        setLogs(result.logs);
      }

      cursorRef.current = result.cursor;
      queryIdRef.current = result.queryId;
      setHasMore(result.hasMore);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to query logs');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [buildTimeRange, filter.levels, filter.search]);

  // Don't auto-fetch on mount — user triggers query manually or we fetch once
  useEffect(() => {
    cursorRef.current = null;
    queryIdRef.current = undefined;
    fetchLogs(false);
  }, [fetchLogs]);

  const setLevels = useCallback((levels: LogLevel[]) => {
    setFilter(prev => ({ ...prev, levels }));
  }, []);

  const setSearch = useCallback((search: string) => {
    setFilter(prev => ({ ...prev, search }));
  }, []);

  const setTimeRange = useCallback((timeRange: LogTimeRange) => {
    setFilter(prev => ({ ...prev, timeRange }));
  }, []);

  const loadMore = useCallback(() => {
    if (hasMore && !loading) {
      fetchLogs(true);
    }
  }, [hasMore, loading, fetchLogs]);

  const refresh = useCallback(() => {
    cursorRef.current = null;
    queryIdRef.current = undefined;
    fetchLogs(false);
  }, [fetchLogs]);

  return {
    logs,
    loading,
    error,
    hasMore,
    filter,
    setLevels,
    setSearch,
    setTimeRange,
    loadMore,
    refresh,
  };
}
