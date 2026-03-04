import { useState, useEffect, useCallback, useRef } from 'react';
import { DEFAULT_DASHBOARD_POLL_INTERVAL_MS } from '@simple-agent-manager/shared';
import type { DashboardTask } from '@simple-agent-manager/shared';
import * as api from '../lib/api';

interface UseActiveTasksOptions {
  /** Polling interval in ms. Defaults to DEFAULT_DASHBOARD_POLL_INTERVAL_MS. */
  pollInterval?: number;
}

interface UseActiveTasksResult {
  tasks: DashboardTask[];
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
}

export function useActiveTasks(options: UseActiveTasksOptions = {}): UseActiveTasksResult {
  const { pollInterval = DEFAULT_DASHBOARD_POLL_INTERVAL_MS } = options;
  const [tasks, setTasks] = useState<DashboardTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const fetchTasks = useCallback(async () => {
    if (hasLoadedRef.current) {
      setIsRefreshing(true);
    }
    try {
      const result = await api.listActiveTasks();
      setTasks(result.tasks);
      setError(null);
      hasLoadedRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load active tasks');
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    if (pollInterval > 0) {
      const interval = setInterval(fetchTasks, pollInterval);
      return () => clearInterval(interval);
    }
  }, [fetchTasks, pollInterval]);

  return { tasks, loading, isRefreshing, error, refresh: fetchTasks };
}
