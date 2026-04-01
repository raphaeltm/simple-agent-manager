import type { ProjectDetailResponse,ProjectSummary } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useRef,useState } from 'react';

import * as api from '../lib/api';

interface UseProjectListOptions {
  status?: string;
  sort?: string;
  limit?: number;
  pollInterval?: number;
}

interface UseProjectListResult {
  projects: ProjectSummary[];
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
}

export function useProjectList(options: UseProjectListOptions = {}): UseProjectListResult {
  const { status, sort, limit, pollInterval = 30000 } = options;
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const fetchProjects = useCallback(async () => {
    if (hasLoadedRef.current) {
      setIsRefreshing(true);
    }
    try {
      const result = await api.listProjects(limit);
      // The API now returns ProjectSummary objects via ListProjectsResponse
      setProjects(result.projects as unknown as ProjectSummary[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      hasLoadedRef.current = true;
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [status, sort, limit]);

  useEffect(() => {
    fetchProjects();
    if (pollInterval > 0) {
      const interval = setInterval(fetchProjects, pollInterval);
      return () => clearInterval(interval);
    }
  }, [fetchProjects, pollInterval]);

  return { projects, loading, isRefreshing, error, refresh: fetchProjects };
}

interface UseProjectDetailResult {
  project: (ProjectDetailResponse & { recentSessions?: unknown[]; recentActivity?: unknown[] }) | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useProjectDetail(projectId: string | undefined): UseProjectDetailResult {
  const [project, setProject] = useState<UseProjectDetailResult['project']>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProject = useCallback(async () => {
    if (!projectId) return;
    try {
      const result = await api.getProject(projectId);
      setProject(result as UseProjectDetailResult['project']);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchProject();
  }, [fetchProject]);

  return { project, loading, error, refresh: fetchProject };
}
