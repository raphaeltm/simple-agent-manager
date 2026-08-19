import { queryOptions } from '@tanstack/react-query';

import { listAgentCredentials, listAgentProfiles, listAgents } from '../api';
import { AGENT_CATALOG_STALE_TIME_MS } from '../query-stale-times';

/**
 * Agent catalog, agent credentials, and per-project agent profiles.
 *
 * `agentCatalog` is the platform's list of installable agent types
 * (`GET /api/agents`). It changes only on deploy, so it gets a longer `staleTime`
 * than the app default.
 *
 * Five surfaces read it; two route through this key so far (`useProjectChatState`,
 * which runs on the app's primary surface, and the workspace session state).
 * `AgentsSection`, `ProjectAgentsSection` and `ProjectOnboardingWizard` still fetch
 * it directly — see the follow-up note in the PR.
 *
 * `agentProfiles` is project-scoped, so its key carries `projectId`. Note the key
 * still leads with `['auth', queryScope, …]`: a profile list belongs to a project,
 * but two different users looking at the same project must not share a cache entry,
 * because profile visibility is an authorization decision made server-side.
 *
 * None of these are persistable — agent credentials are credentials, and profiles
 * carry runtime configuration.
 */
export const agentQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'agents'] as const,
  catalog: (queryScope: string) => [...agentQueryKeys.all(queryScope), 'catalog'] as const,
  credentials: (queryScope: string) => [...agentQueryKeys.all(queryScope), 'credentials'] as const,
  profiles: (queryScope: string) => [...agentQueryKeys.all(queryScope), 'profiles'] as const,
  profileList: (queryScope: string, projectId: string) =>
    [...agentQueryKeys.profiles(queryScope), projectId] as const,
};

export function agentCatalogQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: agentQueryKeys.catalog(queryScope),
    queryFn: async () => (await listAgents()).agents,
    staleTime: AGENT_CATALOG_STALE_TIME_MS,
  });
}

export function agentCredentialsQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: agentQueryKeys.credentials(queryScope),
    queryFn: async () => (await listAgentCredentials()).credentials,
  });
}

export function agentProfilesQueryOptions(queryScope: string, projectId: string) {
  return queryOptions({
    queryKey: agentQueryKeys.profileList(queryScope, projectId),
    queryFn: () => listAgentProfiles(projectId),
  });
}
