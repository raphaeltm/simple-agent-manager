import type { ProjectDetailResponse, ProjectSummary } from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';

import { PROJECT_POLL_INTERVAL_MS } from '../lib/project-query-config';
import { projectDetailQueryOptions, projectListQueryOptions } from '../lib/query-options';

interface UseProjectListOptions {
  queryScope: string;
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

export function useProjectList(options: UseProjectListOptions): UseProjectListResult {
  const { queryScope, limit, pollInterval = PROJECT_POLL_INTERVAL_MS } = options;
  const query = useQuery({
    ...projectListQueryOptions(queryScope, limit),
    enabled: Boolean(queryScope),
    refetchInterval: pollInterval > 0 ? pollInterval : false,
  });

  return {
    projects: query.data ?? [],
    loading: query.isPending && query.data === undefined,
    isRefreshing: query.isFetching && query.data !== undefined,
    error:
      query.data === undefined
        ? query.error instanceof Error
          ? query.error.message
          : query.error
            ? 'Failed to load projects'
            : null
        : null,
    refresh: () => {
      void query.refetch();
    },
  };
}

interface UseProjectDetailResult {
  project:
    | (ProjectDetailResponse & { recentSessions?: unknown[]; recentActivity?: unknown[] })
    | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useProjectDetail(
  projectId: string | undefined,
  queryScope: string
): UseProjectDetailResult {
  const query = useQuery({
    ...projectDetailQueryOptions(queryScope, projectId ?? ''),
    enabled: Boolean(projectId && queryScope),
  });

  return {
    project: (query.data ?? null) as UseProjectDetailResult['project'],
    loading: Boolean(projectId) && query.isPending && query.data === undefined,
    error:
      query.data === undefined
        ? query.error instanceof Error
          ? query.error.message
          : query.error
            ? 'Failed to load project'
            : null
        : null,
    refresh: () => {
      void query.refetch();
    },
  };
}
