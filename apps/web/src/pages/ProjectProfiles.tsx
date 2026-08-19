import { ProfileList } from '../components/agent-profiles/ProfileList';
import { useAgentProfiles } from '../hooks/useAgentProfiles';
import { useQueryScope } from '../hooks/useQueryScope';
import { useProjectContext } from './ProjectContext';

export function ProjectProfiles() {
  const { projectId } = useProjectContext();
  const queryScope = useQueryScope();
  const {
    profiles,
    loading,
    error,
    createProfile,
    updateProfile,
    deleteProfile,
  } = useAgentProfiles(projectId, queryScope);

  return (
    <div className="w-full min-w-0 max-w-3xl mx-auto px-4 py-6">
      <h1 className="text-lg font-semibold text-fg-primary mb-4">Agent Profiles</h1>
      <ProfileList
        profiles={profiles}
        loading={loading}
        error={error}
        onCreateProfile={createProfile}
        onUpdateProfile={updateProfile}
        onDeleteProfile={deleteProfile}
        hideHeader
        projectId={projectId}
      />
    </div>
  );
}
