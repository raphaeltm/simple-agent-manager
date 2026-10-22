import { queryOptions } from '@tanstack/react-query';

import { fetchAdminAgentEmail, getAgentEmailConfig } from '../api/agent-email';
import { PROJECT_CREATE_CONFIG_STALE_TIME_MS } from '../query-stale-times';

export const agentEmailQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'agent-email'] as const,
  config: (queryScope: string) => [...agentEmailQueryKeys.all(queryScope), 'config'] as const,
  adminStatus: (queryScope: string) =>
    [...agentEmailQueryKeys.all(queryScope), 'admin-status'] as const,
};

/** Whether this deployment can offer the "Email" automation start. Changes only at deploy time. */
export function agentEmailConfigQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: agentEmailQueryKeys.config(queryScope),
    queryFn: getAgentEmailConfig,
    staleTime: PROJECT_CREATE_CONFIG_STALE_TIME_MS,
  });
}

export function adminAgentEmailQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: agentEmailQueryKeys.adminStatus(queryScope),
    queryFn: fetchAdminAgentEmail,
    enabled: Boolean(queryScope),
  });
}
