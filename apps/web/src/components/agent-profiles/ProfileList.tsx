import { type FC, useState } from 'react';
import { Pencil, Trash2, Plus, Bot } from 'lucide-react';
import type { AgentProfile, CreateAgentProfileRequest, UpdateAgentProfileRequest } from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { ProfileFormDialog } from './ProfileFormDialog';

interface ProfileListProps {
  profiles: AgentProfile[];
  loading: boolean;
  error: string | null;
  onCreateProfile: (data: CreateAgentProfileRequest) => Promise<AgentProfile>;
  onUpdateProfile: (profileId: string, data: UpdateAgentProfileRequest) => Promise<AgentProfile>;
  onDeleteProfile: (profileId: string) => Promise<void>;
}

export const ProfileList: FC<ProfileListProps> = ({
  profiles,
  loading,
  error,
  onCreateProfile,
  onUpdateProfile,
  onDeleteProfile,
}) => {
  const [formOpen, setFormOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<AgentProfile | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleCreate = () => {
    setEditingProfile(null);
    setFormOpen(true);
  };

  const handleEdit = (profile: AgentProfile) => {
    setEditingProfile(profile);
    setFormOpen(true);
  };

  const handleSave = async (data: CreateAgentProfileRequest | UpdateAgentProfileRequest) => {
    if (editingProfile) {
      await onUpdateProfile(editingProfile.id, data as UpdateAgentProfileRequest);
    } else {
      await onCreateProfile(data as CreateAgentProfileRequest);
    }
  };

  const handleDelete = async (profileId: string) => {
    setDeleteError(null);
    try {
      await onDeleteProfile(profileId);
      setDeleteConfirmId(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete profile');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-4 px-3 rounded-sm bg-danger-tint text-danger text-sm">
        {error}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-semibold text-fg-primary">Agent Profiles</h3>
        <Button onClick={handleCreate}>
          <Plus className="w-4 h-4 mr-1.5 inline-block" />
          New Profile
        </Button>
      </div>

      {profiles.length === 0 ? (
        <div className="text-center py-8 text-fg-muted text-sm">
          <Bot className="w-8 h-8 mx-auto mb-2 opacity-50" />
          No profiles yet. Create one to bundle agent and infrastructure settings.
        </div>
      ) : (
        <div className="grid gap-2">
          {profiles.map((profile) => (
            <div
              key={profile.id}
              className="flex items-start gap-3 p-3 rounded-md border border-border-default bg-page"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg-primary truncate">
                    {profile.name}
                  </span>
                  {profile.isBuiltin && (
                    <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface border border-border-default text-fg-muted">
                      built-in
                    </span>
                  )}
                </div>
                {profile.description && (
                  <p className="text-xs text-fg-muted mt-0.5 truncate">{profile.description}</p>
                )}
                <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-xs text-fg-muted">
                  <span>{profile.agentType}</span>
                  {profile.model && <span>{profile.model}</span>}
                  {profile.permissionMode && <span>{profile.permissionMode}</span>}
                  {profile.vmSizeOverride && <span>VM: {profile.vmSizeOverride}</span>}
                  {profile.taskMode && <span>Mode: {profile.taskMode}</span>}
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => handleEdit(profile)}
                  aria-label={`Edit ${profile.name}`}
                  className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded text-fg-muted hover:text-fg-primary hover:bg-surface cursor-pointer"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                {deleteConfirmId === profile.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void handleDelete(profile.id)}
                      aria-label={`Confirm delete ${profile.name}`}
                      className="px-3 py-2 min-h-[44px] rounded text-xs text-danger bg-danger-tint hover:bg-danger hover:text-white cursor-pointer"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => { setDeleteConfirmId(null); setDeleteError(null); }}
                      aria-label="Cancel delete"
                      className="px-3 py-2 min-h-[44px] rounded text-xs text-fg-muted hover:text-fg-primary cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setDeleteConfirmId(profile.id); setDeleteError(null); }}
                    aria-label={`Delete ${profile.name}`}
                    className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded text-fg-muted hover:text-danger hover:bg-danger-tint cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {deleteError && (
        <div role="alert" className="mt-2 py-2 px-3 rounded-sm bg-danger-tint text-danger text-xs">
          {deleteError}
        </div>
      )}

      <ProfileFormDialog
        isOpen={formOpen}
        onClose={() => { setFormOpen(false); setEditingProfile(null); }}
        profile={editingProfile}
        onSave={handleSave}
      />
    </div>
  );
};
