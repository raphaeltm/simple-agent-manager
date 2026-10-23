import { queryOptions } from '@tanstack/react-query';

import {
  fetchAdminAgentEmail,
  fetchAgentEmailSetupPlan,
  getAgentEmailConfig,
} from '../api/agent-email';
import { PROJECT_CREATE_CONFIG_STALE_TIME_MS } from '../query-stale-times';

export const agentEmailQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'agent-email'] as const,
  config: (queryScope: string) => [...agentEmailQueryKeys.all(queryScope), 'config'] as const,
  adminStatus: (queryScope: string) =>
    [...agentEmailQueryKeys.all(queryScope), 'admin-status'] as const,
  setupPlan: (queryScope: string) =>
    [...agentEmailQueryKeys.all(queryScope), 'setup-plan'] as const,
};

/**
 * Whether this deployment can offer the "Email" automation start. Changes when a superadmin
 * turns agent email on; the admin setup writes the new value into this query itself.
 */
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

/** Each fetch makes several Cloudflare API calls, so it is fetched only while agent email is off. */
export function adminAgentEmailSetupQueryOptions(queryScope: string, enabled: boolean) {
  return queryOptions({
    queryKey: agentEmailQueryKeys.setupPlan(queryScope),
    queryFn: fetchAgentEmailSetupPlan,
    enabled: Boolean(queryScope) && enabled,
  });
}
