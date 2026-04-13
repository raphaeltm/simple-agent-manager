import { ProfileList } from '../components/agent-profiles/ProfileList';
import { useAgentProfiles } from '../hooks/useAgentProfiles';
import { useProjectContext } from './ProjectContext';

export function ProjectProfiles() {
  const { projectId } = useProjectContext();
  const {
    profiles,
    loading,
    error,
    createProfile,
    updateProfile,
    deleteProfile,
  } = useAgentProfiles(projectId);

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <ProfileList
        profiles={profiles}
        loading={loading}
        error={error}
        onCreateProfile={createProfile}
        onUpdateProfile={updateProfile}
        onDeleteProfile={deleteProfile}
      />
    </div>
  );
}
