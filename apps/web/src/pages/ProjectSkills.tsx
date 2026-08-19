import { SkillList } from '../components/skills/SkillList';
import { useAgentProfiles } from '../hooks/useAgentProfiles';
import { useQueryScope } from '../hooks/useQueryScope';
import { useSkills } from '../hooks/useSkills';
import { useProjectContext } from './ProjectContext';

export function ProjectSkills() {
  const { projectId } = useProjectContext();
  const queryScope = useQueryScope();
  const { profiles } = useAgentProfiles(projectId, queryScope);
  const { skills, loading, error, refresh, createSkill, updateSkill, deleteSkill } = useSkills(projectId);

  return (
    <div className="w-full min-w-0 mx-auto max-w-3xl px-4 py-6">
      <h1 className="mb-1 text-lg font-semibold text-fg-primary">Skills</h1>
      <p className="mb-4 text-sm text-fg-muted">
        Reusable bundles of agent settings. When a skill is selected for a task, its values override
        the agent profile, project, and platform defaults.
      </p>
      <SkillList
        skills={skills}
        profiles={profiles}
        loading={loading}
        error={error}
        onCreateSkill={createSkill}
        onUpdateSkill={updateSkill}
        onDeleteSkill={deleteSkill}
        onRetry={() => void refresh()}
        projectId={projectId}
      />
    </div>
  );
}
