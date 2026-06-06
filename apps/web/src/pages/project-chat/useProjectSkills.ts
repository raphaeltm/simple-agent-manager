import type { AgentSkill } from '@simple-agent-manager/shared';
import { useEffect, useState } from 'react';

import { listSkills } from '../../lib/api';

export function useProjectSkills(projectId: string) {
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);

  useEffect(() => {
    void listSkills(projectId)
      .then((data) => {
        setSkills(data);
        setSelectedSkillId((current) => (current && data.some((skill) => skill.id === current) ? current : null));
      })
      .catch((err: unknown) => { console.error('Failed to load skills', err); });
  }, [projectId]);

  return { skills, selectedSkillId, setSelectedSkillId };
}
