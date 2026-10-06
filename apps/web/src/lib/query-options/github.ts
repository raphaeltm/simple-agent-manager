import { queryOptions } from '@tanstack/react-query';

import { listGitHubInstallations } from '../api';

export const githubQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'github'] as const,
  installations: (queryScope: string) =>
    [...githubQueryKeys.all(queryScope), 'installations'] as const,
};

export function githubInstallationsQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: githubQueryKeys.installations(queryScope),
    queryFn: listGitHubInstallations,
  });
}
