import type { PlatformError, PlatformErrorLevel, PlatformErrorSource } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { type AdminErrorsFilter, fetchAdminErrors } from '../lib/api';

export type TimeRange = '1h' | '24h' | '7d' | '30d';

const VALID_TIME_RANGES = new Set<TimeRange>(['1h', '24h', '7d', '30d']);
const VALID_SOURCES = new Set<PlatformErrorSource | 'all'>(['all', 'client', 'vm-agent', 'api']);
const VALID_LEVELS = new Set<PlatformErrorLevel | 'all'>(['all', 'error', 'warn', 'info']);

export interface AdminErrorsFilterState {
  source: PlatformErrorSource | 'all';
  level: PlatformErrorLevel | 'all';
  search: string;
  timeRange: TimeRange;
  nodeId: string;
  workspaceId: string;
  taskId: string;
  sessionId: string;
  userId: string;
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
  setNodeId: (nodeId: string) => void;
  setWorkspaceId: (workspaceId: string) => void;
  setTaskId: (taskId: string) => void;
  setSessionId: (sessionId: string) => void;
  setUserId: (userId: string) => void;
  loadMore: () => void;
  refresh: () => void;
  autoRefresh: boolean;
  setAutoRefresh: (on: boolean) => void;
}

const TIME_RANGE_MS: Record<TimeRange, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const AUTO_REFRESH_MS = 30_000;

function parseFilterFromParams(params: URLSearchParams): AdminErrorsFilterState {
  const rawSource = params.get('source') ?? 'all';
  const rawLevel = params.get('level') ?? 'all';
  const rawRange = params.get('range') ?? '24h';

  return {
    source: VALID_SOURCES.has(rawSource as PlatformErrorSource | 'all')
      ? (rawSource as PlatformErrorSource | 'all')
      : 'all',
    level: VALID_LEVELS.has(rawLevel as PlatformErrorLevel | 'all')
      ? (rawLevel as PlatformErrorLevel | 'all')
      : 'all',
    search: params.get('search') ?? '',
    timeRange: VALID_TIME_RANGES.has(rawRange as TimeRange) ? (rawRange as TimeRange) : '24h',
    nodeId: params.get('nodeId') ?? '',
    workspaceId: params.get('workspaceId') ?? '',
    taskId: params.get('taskId') ?? '',
    sessionId: params.get('sessionId') ?? '',
    userId: params.get('userId') ?? '',
  };
}

function syncFilterToParams(filter: AdminErrorsFilterState): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.source !== 'all') params.set('source', filter.source);
  if (filter.level !== 'all') params.set('level', filter.level);
  if (filter.search) params.set('search', filter.search);
  if (filter.timeRange !== '24h') params.set('range', filter.timeRange);
  if (filter.nodeId) params.set('nodeId', filter.nodeId);
  if (filter.workspaceId) params.set('workspaceId', filter.workspaceId);
  if (filter.taskId) params.set('taskId', filter.taskId);
  if (filter.sessionId) params.set('sessionId', filter.sessionId);
  if (filter.userId) params.set('userId', filter.userId);
  return params;
}

export function useAdminErrors(): UseAdminErrorsReturn {
  const [searchParams, setSearchParams] = useSearchParams();
  const [errors, setErrors] = useState<PlatformError[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const [filter, setFilter] = useState<AdminErrorsFilterState>(() =>
    parseFilterFromParams(searchParams),
  );

  const cursorRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const updateFilter = useCallback(
    (updater: (prev: AdminErrorsFilterState) => AdminErrorsFilterState) => {
      setFilter((prev) => {
        const next = updater(prev);
        setSearchParams(syncFilterToParams(next), { replace: true });
        return next;
      });
    },
    [setSearchParams],
  );

  const buildFilter = useCallback(
    (append: boolean): AdminErrorsFilter => {
      const now = Date.now();
      const startTime = new Date(now - TIME_RANGE_MS[filter.timeRange]).toISOString();
      const params: AdminErrorsFilter = {
        source: filter.source !== 'all' ? filter.source : undefined,
        level: filter.level !== 'all' ? filter.level : undefined,
        search: filter.search || undefined,
        startTime,
        limit: 50,
        cursor: append ? cursorRef.current ?? undefined : undefined,
      };
      if (filter.nodeId) (params as Record<string, unknown>).nodeId = filter.nodeId;
      if (filter.workspaceId) (params as Record<string, unknown>).workspaceId = filter.workspaceId;
      if (filter.taskId) (params as Record<string, unknown>).taskId = filter.taskId;
      if (filter.sessionId) (params as Record<string, unknown>).sessionId = filter.sessionId;
      if (filter.userId) (params as Record<string, unknown>).userId = filter.userId;
      return params;
    },
    [filter],
  );

  const fetchErrors = useCallback(
    async (append = false) => {
      try {
        if (!append) setLoading(true);
        setError(null);

        const result = await fetchAdminErrors(buildFilter(append));

        if (!mountedRef.current) return;

        if (append) {
          setErrors((prev) => [...prev, ...result.errors]);
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
    },
    [buildFilter],
  );

  useEffect(() => {
    cursorRef.current = null;
    fetchErrors(false);
  }, [fetchErrors]);

  // Auto-refresh interval
  useEffect(() => {
    if (autoRefreshRef.current) {
      clearInterval(autoRefreshRef.current);
      autoRefreshRef.current = null;
    }
    if (autoRefresh) {
      autoRefreshRef.current = setInterval(() => {
        cursorRef.current = null;
        fetchErrors(false);
      }, AUTO_REFRESH_MS);
    }
    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    };
  }, [autoRefresh, fetchErrors]);

  const setSource = useCallback(
    (source: PlatformErrorSource | 'all') => updateFilter((prev) => ({ ...prev, source })),
    [updateFilter],
  );
  const setLevel = useCallback(
    (level: PlatformErrorLevel | 'all') => updateFilter((prev) => ({ ...prev, level })),
    [updateFilter],
  );
  const setSearch = useCallback(
    (search: string) => updateFilter((prev) => ({ ...prev, search })),
    [updateFilter],
  );
  const setTimeRange = useCallback(
    (timeRange: TimeRange) => updateFilter((prev) => ({ ...prev, timeRange })),
    [updateFilter],
  );
  const setNodeId = useCallback(
    (nodeId: string) => updateFilter((prev) => ({ ...prev, nodeId })),
    [updateFilter],
  );
  const setWorkspaceId = useCallback(
    (workspaceId: string) => updateFilter((prev) => ({ ...prev, workspaceId })),
    [updateFilter],
  );
  const setTaskId = useCallback(
    (taskId: string) => updateFilter((prev) => ({ ...prev, taskId })),
    [updateFilter],
  );
  const setSessionId = useCallback(
    (sessionId: string) => updateFilter((prev) => ({ ...prev, sessionId })),
    [updateFilter],
  );
  const setUserId = useCallback(
    (userId: string) => updateFilter((prev) => ({ ...prev, userId })),
    [updateFilter],
  );

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
    setNodeId,
    setWorkspaceId,
    setTaskId,
    setSessionId,
    setUserId,
    loadMore,
    refresh,
    autoRefresh,
    setAutoRefresh,
  };
}
