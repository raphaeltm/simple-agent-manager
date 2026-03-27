import { type FC, useState, useEffect, useCallback } from 'react';
import type { AgentProfile, VMSize, WorkspaceProfile, UpdateAgentProfileRequest } from '@simple-agent-manager/shared';
import { Settings } from 'lucide-react';
import { SplitButton } from '../ui/SplitButton';
import { ProfileSelector } from '../agent-profiles/ProfileSelector';
import { ProfileFormDialog } from '../agent-profiles/ProfileFormDialog';
import { listAgentProfiles, updateAgentProfile } from '../../lib/api';

export interface TaskSubmitFormProps {
  projectId: string;
  hasCloudCredentials: boolean;
  onRunNow: (title: string, options: TaskSubmitOptions) => Promise<void>;
  onSaveToBacklog: (title: string, options: TaskSubmitOptions) => Promise<void>;
}

export interface TaskSubmitOptions {
  description?: string;
  priority?: number;
  agentProfileId?: string;
  vmSize?: VMSize;
  workspaceProfile?: WorkspaceProfile;
}

export const TaskSubmitForm: FC<TaskSubmitFormProps> = ({
  projectId,
  hasCloudCredentials,
  onRunNow,
  onSaveToBacklog,
}) => {
  const [title, setTitle] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(0);
  const [agentProfileId, setAgentProfileId] = useState<string | null>(null);
  const [vmSize, setVmSize] = useState<VMSize | ''>('');
  const [workspaceProfile, setWorkspaceProfile] = useState<WorkspaceProfile | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [editProfileOpen, setEditProfileOpen] = useState(false);

  const hasProfile = !!agentProfileId;
  const selectedProfile = hasProfile
    ? profiles.find((p) => p.id === agentProfileId) ?? null
    : null;

  // Load profiles
  const loadProfiles = useCallback(() => {
    void listAgentProfiles(projectId)
      .then((data) => setProfiles(data))
      .catch(() => { /* best-effort */ });
  }, [projectId]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const handleUpdateProfile = useCallback(async (_profileId: string, data: UpdateAgentProfileRequest) => {
    await updateAgentProfile(projectId, _profileId, data);
    loadProfiles();
  }, [projectId, loadProfiles]);

  const options: TaskSubmitOptions = hasProfile
    ? {
        description: description.trim() || undefined,
        priority: priority || undefined,
        agentProfileId: agentProfileId ?? undefined,
      }
    : {
        description: description.trim() || undefined,
        priority: priority || undefined,
        vmSize: vmSize || undefined,
        workspaceProfile: workspaceProfile || undefined,
      };

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setPriority(0);
    setAgentProfileId(null);
    setVmSize('');
    setWorkspaceProfile('');
  };

  const handleRunNow = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError('Task description is required');
      return;
    }
    if (!hasCloudCredentials) {
      setError('Cloud credentials required. Go to Settings to connect your Hetzner account.');
      return;
    }
    try {
      setError(null);
      setSubmitting(true);
      await onRunNow(trimmed, options);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run task');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveToBacklog = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError('Task description is required');
      return;
    }
    try {
      setError(null);
      setSubmitting(true);
      await onSaveToBacklog(trimmed, options);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save task');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="border-t border-border-default py-3 px-4 bg-surface">
      {error && (
        <div className="py-2 px-3 mb-2 rounded-sm bg-danger-tint text-danger text-xs">
          {error}
        </div>
      )}

      <div className="flex gap-2 items-start">
        <div className="flex-1">
          <input
            type="text"
            value={title}
            onChange={(e) => { setTitle(e.target.value); setError(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !submitting) {
                void handleRunNow();
              }
            }}
            placeholder="Describe the task for the agent..."
            disabled={submitting}
            className="w-full py-2 px-3 bg-page border border-border-default rounded-md text-fg-primary text-base outline-none"
          />
        </div>

        <SplitButton
          primaryLabel="Run Now"
          onPrimaryAction={() => void handleRunNow()}
          options={[
            { label: 'Save to Backlog', onClick: () => void handleSaveToBacklog() },
          ]}
          disabled={submitting}
          loading={submitting}
        />
      </div>

      {/* Advanced options toggle */}
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="bg-transparent border-none text-fg-muted text-xs cursor-pointer p-0"
        >
          {showAdvanced ? 'Hide' : 'Show'} advanced options
        </button>
      </div>

      {showAdvanced && (
        <div className="grid gap-2 mt-2 p-3 bg-page rounded-md border border-border-default">
          <div>
            <label className="text-xs text-fg-muted block mb-1">
              Description (optional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Additional context for the agent..."
              rows={2}
              className="w-full p-2 bg-surface border border-border-default rounded-sm text-fg-primary text-sm resize-y"
            />
          </div>

          <div className="flex gap-3 flex-wrap items-end">
            {profiles.length > 0 && (
              <div className="flex items-end gap-1">
                <div>
                  <label className="text-xs text-fg-muted block mb-1">
                    Agent Profile
                  </label>
                  <ProfileSelector
                    profiles={profiles}
                    selectedProfileId={agentProfileId}
                    onChange={setAgentProfileId}
                    disabled={submitting}
                    compact
                  />
                </div>
                {hasProfile && (
                  <button
                    type="button"
                    onClick={() => setEditProfileOpen(true)}
                    disabled={submitting}
                    aria-label="Edit profile settings"
                    className="shrink-0 p-1.5 border border-border-default rounded-sm bg-surface text-fg-muted hover:text-fg-primary cursor-pointer disabled:opacity-50"
                  >
                    <Settings size={14} />
                  </button>
                )}
              </div>
            )}

            <div>
              <label className="text-xs text-fg-muted block mb-1">
                Priority
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className="py-1 px-2 bg-surface border border-border-default rounded-sm text-fg-primary text-sm"
              >
                <option value={0}>Normal (0)</option>
                <option value={1}>Low (1)</option>
                <option value={5}>Medium (5)</option>
                <option value={10}>High (10)</option>
              </select>
            </div>

            {!hasProfile && (
              <>
                <div>
                  <label className="text-xs text-fg-muted block mb-1">
                    VM Size
                  </label>
                  <select
                    value={vmSize}
                    onChange={(e) => setVmSize(e.target.value as VMSize | '')}
                    className="py-1 px-2 bg-surface border border-border-default rounded-sm text-fg-primary text-sm"
                  >
                    <option value="">Default</option>
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs text-fg-muted block mb-1">
                    Workspace
                  </label>
                  <select
                    value={workspaceProfile}
                    onChange={(e) => setWorkspaceProfile(e.target.value as WorkspaceProfile | '')}
                    className="py-1 px-2 bg-surface border border-border-default rounded-sm text-fg-primary text-sm"
                  >
                    <option value="">Default</option>
                    <option value="full">Full</option>
                    <option value="lightweight">Lightweight</option>
              </select>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {selectedProfile && (
        <ProfileFormDialog
          isOpen={editProfileOpen}
          onClose={() => setEditProfileOpen(false)}
          profile={selectedProfile}
          onSave={async (data) => {
            await handleUpdateProfile(selectedProfile.id, data as UpdateAgentProfileRequest);
          }}
        />
      )}
    </div>
  );
};
