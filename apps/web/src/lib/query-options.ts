import type { ProjectSummary } from '@simple-agent-manager/shared';
import { queryOptions } from '@tanstack/react-query';

import { getProject, listGitHubInstallations, listProjects } from './api';

export const projectQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'projects'] as const,
  lists: (queryScope: string) => [...projectQueryKeys.all(queryScope), 'list'] as const,
  list: (queryScope: string, limit?: number) => [
    ...projectQueryKeys.lists(queryScope),
    { limit: limit ?? null },
  ] as const,
  details: (queryScope: string) => [...projectQueryKeys.all(queryScope), 'detail'] as const,
  detail: (queryScope: string, projectId: string) => [
    ...projectQueryKeys.details(queryScope),
    projectId,
  ] as const,
};

export const githubQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'github'] as const,
  installations: (queryScope: string) => [
    ...githubQueryKeys.all(queryScope),
    'installations',
  ] as const,
};

export function projectListQueryOptions(queryScope: string, limit?: number) {
  return queryOptions({
    queryKey: projectQueryKeys.list(queryScope, limit),
    queryFn: async () => (await listProjects(limit)).projects as unknown as ProjectSummary[],
  });
}

export function projectDetailQueryOptions(queryScope: string, projectId: string) {
  return queryOptions({
    queryKey: projectQueryKeys.detail(queryScope, projectId),
    queryFn: () => getProject(projectId),
  });
}

export function githubInstallationsQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: githubQueryKeys.installations(queryScope),
    queryFn: listGitHubInstallations,
  });
}
