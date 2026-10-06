import type { AgentCredentialInfo, AgentInfo } from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';

import { agentCatalogQueryOptions, agentCredentialsQueryOptions } from '../lib/query-options';

interface UseAgentCatalogResult {
  agents: AgentInfo[];
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * The platform's agent catalog (`GET /api/agents`).
 *
 * Used by `useProjectChatState` (the primary chat surface) and the workspace session
 * state. It only changes when the platform is redeployed, so it carries a longer
 * `staleTime` (`lib/query-stale-times.ts`) — in practice a session fetches it once.
 * Three further call sites are not migrated yet; see `lib/query-options/agents.ts`.
 */
export function useAgentCatalog(queryScope: string): UseAgentCatalogResult {
  const query = useQuery({
    ...agentCatalogQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });

  return {
    agents: query.data ?? [],
    loading: Boolean(queryScope) && query.isPending && query.data === undefined,
    isRefreshing: query.isFetching && query.data !== undefined,
    error:
      query.data === undefined && query.error
        ? query.error instanceof Error
          ? query.error.message
          : 'Failed to load agents'
        : null,
    refresh: () => {
      void query.refetch();
    },
  };
}

interface UseAgentCredentialsResult {
  credentials: AgentCredentialInfo[];
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
}

/** Per-user agent credentials (`GET /api/credentials/agent`). */
export function useAgentCredentials(queryScope: string): UseAgentCredentialsResult {
  const query = useQuery({
    ...agentCredentialsQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });

  return {
    credentials: query.data ?? [],
    loading: Boolean(queryScope) && query.isPending && query.data === undefined,
    isRefreshing: query.isFetching && query.data !== undefined,
    error:
      query.data === undefined && query.error
        ? query.error instanceof Error
          ? query.error.message
          : 'Failed to load agent credentials'
        : null,
    refresh: () => {
      void query.refetch();
    },
  };
}
