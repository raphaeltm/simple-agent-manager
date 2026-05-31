import { SkillList } from '../components/skills/SkillList';
import { useAgentProfiles } from '../hooks/useAgentProfiles';
import { useSkills } from '../hooks/useSkills';
import { useProjectContext } from './ProjectContext';

export function ProjectSkills() {
  const { projectId } = useProjectContext();
  const { profiles } = useAgentProfiles(projectId);
  const { skills, loading, error, createSkill, updateSkill, deleteSkill } = useSkills(projectId);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="mb-4 text-lg font-semibold text-fg-primary">Skills</h1>
      <SkillList
        skills={skills}
        profiles={profiles}
        loading={loading}
        error={error}
        onCreateSkill={createSkill}
        onUpdateSkill={updateSkill}
        onDeleteSkill={deleteSkill}
        projectId={projectId}
      />
    </div>
  );
}
