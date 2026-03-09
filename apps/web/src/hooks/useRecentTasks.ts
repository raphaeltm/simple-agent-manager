import { useState, useEffect, useCallback, useRef } from 'react';
import type { DashboardRecentTask } from '@simple-agent-manager/shared';
import * as api from '../lib/api';

interface UseRecentTasksResult {
  tasks: DashboardRecentTask[];
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
}

export function useRecentTasks(): UseRecentTasksResult {
  const [tasks, setTasks] = useState<DashboardRecentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const fetchTasks = useCallback(async () => {
    if (hasLoadedRef.current) {
      setIsRefreshing(true);
    }
    try {
      const result = await api.listRecentTasks();
      setTasks(result.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recent tasks');
    } finally {
      hasLoadedRef.current = true;
      setLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  return { tasks, loading, isRefreshing, error, refresh: fetchTasks };
}
