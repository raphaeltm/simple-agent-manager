import type { AgentProfile, CreateAgentProfileRequest, UpdateAgentProfileRequest } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useRef,useState } from 'react';

import * as api from '../lib/api';

interface UseAgentProfilesResult {
  profiles: AgentProfile[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  createProfile: (data: CreateAgentProfileRequest) => Promise<AgentProfile>;
  updateProfile: (profileId: string, data: UpdateAgentProfileRequest) => Promise<AgentProfile>;
  deleteProfile: (profileId: string) => Promise<void>;
}

export function useAgentProfiles(projectId: string | undefined): UseAgentProfilesResult {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const fetchProfiles = useCallback(async () => {
    if (!projectId) return;
    try {
      const result = await api.listAgentProfiles(projectId);
      setProfiles(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agent profiles');
    } finally {
      hasLoadedRef.current = true;
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    void fetchProfiles();
  }, [fetchProfiles, projectId]);

  const refresh = useCallback(() => {
    void fetchProfiles();
  }, [fetchProfiles]);

  const createProfile = useCallback(
    async (data: CreateAgentProfileRequest): Promise<AgentProfile> => {
      if (!projectId) throw new Error('No project ID');
      const profile = await api.createAgentProfile(projectId, data);
      await fetchProfiles();
      return profile;
    },
    [projectId, fetchProfiles],
  );

  const updateProfile = useCallback(
    async (profileId: string, data: UpdateAgentProfileRequest): Promise<AgentProfile> => {
      if (!projectId) throw new Error('No project ID');
      const profile = await api.updateAgentProfile(projectId, profileId, data);
      await fetchProfiles();
      return profile;
    },
    [projectId, fetchProfiles],
  );

  const deleteProfile = useCallback(
    async (profileId: string): Promise<void> => {
      if (!projectId) throw new Error('No project ID');
      await api.deleteAgentProfile(projectId, profileId);
      await fetchProfiles();
    },
    [projectId, fetchProfiles],
  );

  return { profiles, loading, error, refresh, createProfile, updateProfile, deleteProfile };
}
