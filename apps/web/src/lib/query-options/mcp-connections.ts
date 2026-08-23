import { queryOptions } from '@tanstack/react-query';

import { listMcpConnections } from '../api';

/**
 * Bring-your-own MCP servers, at either the caller's personal scope (`projectId === null`)
 * or a project's shared scope.
 *
 * Keys are identity-scoped via `queryScope` so a cached list can never render for a
 * different account after a user switch (rule 48).
 *
 * NOT persistable. These rows describe third-party connection configuration, which
 * `query-persist-config.ts` places on the never-persist-without-security-review list; they
 * are deliberately absent from `PERSISTED_QUERY_OPERATIONS`. (The API never returns the URL
 * or token, but the host and server names are still connection metadata.)
 */
export const mcpConnectionQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'mcp-connections'] as const,
  list: (queryScope: string, projectId: string | null) =>
    [...mcpConnectionQueryKeys.all(queryScope), 'list', projectId ?? 'personal'] as const,
};

export function mcpConnectionsQueryOptions(queryScope: string, projectId: string | null) {
  return queryOptions({
    queryKey: mcpConnectionQueryKeys.list(queryScope, projectId),
    queryFn: () => listMcpConnections(projectId),
  });
}
