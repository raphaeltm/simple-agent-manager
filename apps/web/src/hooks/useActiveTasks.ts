import { useState, useEffect, useCallback } from 'react';
import type { DashboardTask } from '@simple-agent-manager/shared';
import * as api from '../lib/api';

interface UseActiveTasksOptions {
  /** Polling interval in ms. Default: 15000 (15s) */
  pollInterval?: number;
}

interface UseActiveTasksResult {
  tasks: DashboardTask[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useActiveTasks(options: UseActiveTasksOptions = {}): UseActiveTasksResult {
  const { pollInterval = 15000 } = options;
  const [tasks, setTasks] = useState<DashboardTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTasks = useCallback(async () => {
    try {
      const result = await api.listActiveTasks();
      setTasks(result.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load active tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    if (pollInterval > 0) {
      const interval = setInterval(fetchTasks, pollInterval);
      return () => clearInterval(interval);
    }
  }, [fetchTasks, pollInterval]);

  return { tasks, loading, error, refresh: fetchTasks };
}
