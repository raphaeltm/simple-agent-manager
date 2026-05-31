import type { AgentSkill, CreateSkillRequest, UpdateSkillRequest } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useState } from 'react';

import * as api from '../lib/api';

export function useSkills(projectId: string | undefined) {
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    try {
      setSkills(await api.listSkills(projectId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load skills');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createSkill = useCallback(async (data: CreateSkillRequest) => {
    if (!projectId) throw new Error('No project ID');
    const skill = await api.createSkill(projectId, data);
    await refresh();
    return skill;
  }, [projectId, refresh]);

  const updateSkill = useCallback(async (skillId: string, data: UpdateSkillRequest) => {
    if (!projectId) throw new Error('No project ID');
    const skill = await api.updateSkill(projectId, skillId, data);
    await refresh();
    return skill;
  }, [projectId, refresh]);

  const deleteSkill = useCallback(async (skillId: string) => {
    if (!projectId) throw new Error('No project ID');
    await api.deleteSkill(projectId, skillId);
    await refresh();
  }, [projectId, refresh]);

  return { skills, loading, error, refresh, createSkill, updateSkill, deleteSkill };
}
