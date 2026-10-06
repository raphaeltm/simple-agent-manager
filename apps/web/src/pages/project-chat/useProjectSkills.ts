import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { projectSkillsQueryOptions } from '../../lib/query-options';

export function useProjectSkills(projectId: string) {
  const queryScope = useQueryScope();
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const skillsQuery = useQuery({
    ...projectSkillsQueryOptions(queryScope, projectId),
    enabled: Boolean(projectId && queryScope),
  });
  const skills = skillsQuery.data ?? [];

  useEffect(() => {
    setSelectedSkillId((current) =>
      current && skills.some((skill) => skill.id === current) ? current : null
    );
  }, [skills]);

  useEffect(() => {
    if (skillsQuery.error) console.error('Failed to load skills', skillsQuery.error);
  }, [skillsQuery.error]);

  return { skills, selectedSkillId, setSelectedSkillId };
}
