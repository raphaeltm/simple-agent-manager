import { queryOptions } from '@tanstack/react-query';

import { listCredentials } from '../api';

/**
 * The user's cloud-provider credential list (`GET /api/credentials`).
 *
 * Read by seven independent surfaces before this migration — the settings shell,
 * the workspace-creation prerequisites, the project-chat state hook, scaling
 * settings, and three onboarding components — each of which mounted its own
 * `useState`/`useEffect` loader and issued its own request.
 *
 * NOT persistable. `CredentialResponse` is connection configuration, which
 * `query-persist-config.ts` places on the never-persist-without-security-review
 * list. It is deliberately absent from `PERSISTED_QUERY_OPERATIONS`.
 */
export const credentialQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'credentials'] as const,
  list: (queryScope: string) => [...credentialQueryKeys.all(queryScope), 'list'] as const,
};

export function credentialsQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: credentialQueryKeys.list(queryScope),
    queryFn: listCredentials,
  });
}
