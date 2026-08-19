import type {
  AgentProfile,
  CreateAgentProfileRequest,
  UpdateAgentProfileRequest,
} from '@simple-agent-manager/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { createAgentProfile, deleteAgentProfile, updateAgentProfile } from '../lib/api';
import { agentProfilesQueryOptions, agentQueryKeys } from '../lib/query-options';

interface UseAgentProfilesResult {
  profiles: AgentProfile[];
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
  createProfile: (data: CreateAgentProfileRequest) => Promise<AgentProfile>;
  updateProfile: (profileId: string, data: UpdateAgentProfileRequest) => Promise<AgentProfile>;
  deleteProfile: (profileId: string) => Promise<void>;
}

/**
 * Agent profiles for a project.
 *
 * Read by five surfaces (the profiles page, both task forms, the trigger form, and
 * project chat), which previously each ran their own loader.
 *
 * Mutations invalidate the shared cache entry rather than chaining
 * `await fetchProfiles()` on the mutating component only — so creating a profile in
 * the profiles page also refreshes the selector in an open chat composer, which the
 * old implementation could not do (`.claude/rules/16-no-page-reload-on-mutation.md`).
 */
export function useAgentProfiles(
  projectId: string | undefined,
  queryScope: string
): UseAgentProfilesResult {
  const queryClient = useQueryClient();
  const enabled = Boolean(projectId && queryScope);

  const query = useQuery({
    ...agentProfilesQueryOptions(queryScope, projectId ?? ''),
    enabled,
  });

  const invalidate = useCallback(async () => {
    if (!projectId) return;
    await queryClient.invalidateQueries({
      queryKey: agentQueryKeys.profileList(queryScope, projectId),
    });
  }, [projectId, queryClient, queryScope]);

  const createMutation = useMutation({
    mutationFn: (data: CreateAgentProfileRequest) => {
      if (!projectId) throw new Error('No project ID');
      return createAgentProfile(projectId, data);
    },
    onSuccess: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: ({ profileId, data }: { profileId: string; data: UpdateAgentProfileRequest }) => {
      if (!projectId) throw new Error('No project ID');
      return updateAgentProfile(projectId, profileId, data);
    },
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (profileId: string) => {
      if (!projectId) throw new Error('No project ID');
      return deleteAgentProfile(projectId, profileId);
    },
    onSuccess: invalidate,
  });

  return {
    profiles: query.data ?? [],
    loading: enabled && query.isPending && query.data === undefined,
    isRefreshing: query.isFetching && query.data !== undefined,
    error:
      query.data === undefined && query.error
        ? query.error instanceof Error
          ? query.error.message
          : 'Failed to load agent profiles'
        : null,
    refresh: () => {
      void query.refetch();
    },
    createProfile: (data) => createMutation.mutateAsync(data),
    updateProfile: (profileId, data) => updateMutation.mutateAsync({ profileId, data }),
    deleteProfile: (profileId) => deleteMutation.mutateAsync(profileId),
  };
}
