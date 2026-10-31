import { queryOptions } from '@tanstack/react-query';

import {
  getAgentSettings,
  getProfilePickerState,
  listAgentCredentials,
  listAgentProfiles,
  listAgents,
  listSkills,
} from '../api';
import { AGENT_CATALOG_STALE_TIME_MS } from '../query-stale-times';

/**
 * Agent catalog, agent credentials, and per-project agent profiles.
 *
 * `agentCatalog` is the platform's list of installable agent types
 * (`GET /api/agents`). It changes only on deploy, so it gets a longer `staleTime`
 * than the app default.
 *
 * Surfaces routing through this key: `useProjectChatState` (the app's primary
 * surface), the workspace session state, and Settings → Agents defaults.
 * `ProjectAgentsSection` and `ProjectOnboardingWizard` still fetch it directly —
 * see the follow-up note in the PR.
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
  /** The user's defaults for one agent (`GET /api/agent-settings/:agentType`). */
  settings: (queryScope: string, agentType: string) =>
    [...agentQueryKeys.all(queryScope), 'settings', agentType] as const,
  profiles: (queryScope: string) => [...agentQueryKeys.all(queryScope), 'profiles'] as const,
  profileList: (queryScope: string, projectId: string) =>
    [...agentQueryKeys.profiles(queryScope), projectId] as const,
  /**
   * The caller's own new-chat picker state (usage + hidden). Nested under
   * `profileList`, so invalidating a project's profiles also refreshes it.
   */
  profilePicker: (queryScope: string, projectId: string) =>
    [...agentQueryKeys.profileList(queryScope, projectId), 'picker'] as const,
  skills: (queryScope: string) => [...agentQueryKeys.all(queryScope), 'skills'] as const,
  skillList: (queryScope: string, projectId: string) =>
    [...agentQueryKeys.skills(queryScope), projectId] as const,
};

export function agentCatalogQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: agentQueryKeys.catalog(queryScope),
    queryFn: async () => (await listAgents()).agents,
    staleTime: AGENT_CATALOG_STALE_TIME_MS,
  });
}

export function agentSettingsQueryOptions(queryScope: string, agentType: string) {
  return queryOptions({
    queryKey: agentQueryKeys.settings(queryScope, agentType),
    queryFn: () => getAgentSettings(agentType),
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

export function profilePickerQueryOptions(queryScope: string, projectId: string) {
  return queryOptions({
    queryKey: agentQueryKeys.profilePicker(queryScope, projectId),
    queryFn: () => getProfilePickerState(projectId),
  });
}

export function projectSkillsQueryOptions(queryScope: string, projectId: string) {
  return queryOptions({
    queryKey: agentQueryKeys.skillList(queryScope, projectId),
    queryFn: () => listSkills(projectId),
  });
}
