import type { AgentProfile, UpdateAgentProfileRequest,VMSize, WorkspaceProfile } from '@simple-agent-manager/shared';
import { ATTACHMENT_DEFAULTS, SAFE_FILENAME_REGEX } from '@simple-agent-manager/shared';
import { Paperclip, Settings, X } from 'lucide-react';
import { type FC, useCallback, useEffect, useRef,useState } from 'react';

import type { TaskAttachmentRef } from '../../lib/api';
import {
  listAgentProfiles,
  requestAttachmentUpload,
  updateAgentProfile,
  uploadAttachmentToR2,
} from '../../lib/api';
import { formatFileSize } from '../../lib/file-utils';
import { ProfileFormDialog } from '../agent-profiles/ProfileFormDialog';
import { ProfileSelector } from '../agent-profiles/ProfileSelector';
import { SplitButton } from '../ui/SplitButton';

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
  devcontainerConfigName?: string | null;
  attachments?: TaskAttachmentRef[];
}

interface AttachmentState {
  file: File;
  uploadId: string | null;
  progress: number; // 0-100
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
  ref?: TaskAttachmentRef;
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
  const [devcontainerConfigName, setDevcontainerConfigName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentState[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasProfile = !!agentProfileId;
  const selectedProfile = hasProfile
    ? profiles.find((p) => p.id === agentProfileId) ?? null
    : null;

  const uploading = attachments.some((a) => a.status === 'uploading' || a.status === 'pending');
  const allUploadsComplete = attachments.length === 0 || attachments.every((a) => a.status === 'complete');

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

  // Upload a single file: request presigned URL, then PUT to R2
  const uploadFile = useCallback(async (file: File, index: number) => {
    try {
      // Request presigned URL
      const presigned = await requestAttachmentUpload(
        projectId,
        file.name,
        file.size,
        file.type || 'application/octet-stream',
      );

      setAttachments((prev) =>
        prev.map((a, i) =>
          i === index ? { ...a, uploadId: presigned.uploadId, status: 'uploading' as const } : a,
        ),
      );

      // Upload directly to R2
      await uploadAttachmentToR2(presigned.uploadUrl, file, (loaded, total) => {
        const progress = Math.round((loaded / total) * 100);
        setAttachments((prev) =>
          prev.map((a, i) => (i === index ? { ...a, progress } : a)),
        );
      });

      const ref: TaskAttachmentRef = {
        uploadId: presigned.uploadId,
        filename: file.name,
        size: file.size,
        contentType: file.type || 'application/octet-stream',
      };

      setAttachments((prev) =>
        prev.map((a, i) =>
          i === index ? { ...a, status: 'complete' as const, progress: 100, ref } : a,
        ),
      );
    } catch (err) {
      setAttachments((prev) =>
        prev.map((a, i) =>
          i === index
            ? { ...a, status: 'error' as const, error: err instanceof Error ? err.message : 'Upload failed' }
            : a,
        ),
      );
    }
  }, [projectId]);

  const handleFilesSelected = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;

    const maxFiles = ATTACHMENT_DEFAULTS.MAX_FILES;
    const maxBytes = ATTACHMENT_DEFAULTS.UPLOAD_MAX_BYTES;
    const batchMax = ATTACHMENT_DEFAULTS.UPLOAD_BATCH_MAX_BYTES;

    const newFiles: AttachmentState[] = [];
    const currentTotal = attachments.reduce((sum, a) => sum + a.file.size, 0);
    let runningTotal = currentTotal;

    for (const file of Array.from(files)) {
      if (attachments.length + newFiles.length >= maxFiles) {
        setError(`Maximum ${maxFiles} files allowed`);
        break;
      }
      if (file.size > maxBytes) {
        setError(`${file.name} exceeds ${formatFileSize(maxBytes)} limit`);
        continue;
      }
      if (!SAFE_FILENAME_REGEX.test(file.name)) {
        setError(`${file.name} has invalid characters. Only letters, numbers, dots, dashes, underscores, and spaces allowed.`);
        continue;
      }
      if (runningTotal + file.size > batchMax) {
        setError(`Total size would exceed ${formatFileSize(batchMax)} limit`);
        break;
      }
      runningTotal += file.size;
      newFiles.push({
        file,
        uploadId: null,
        progress: 0,
        status: 'pending',
      });
    }

    if (newFiles.length === 0) return;

    const startIndex = attachments.length;
    setAttachments((prev) => [...prev, ...newFiles]);

    // Start uploads
    for (let i = 0; i < newFiles.length; i++) {
      void uploadFile(newFiles[i]!.file, startIndex + i);
    }
  }, [attachments, uploadFile]);

  const handleRemoveAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const buildOptions = (): TaskSubmitOptions => {
    const completedAttachments = attachments
      .filter((a) => a.status === 'complete' && a.ref)
      .map((a) => a.ref!);

    const base = hasProfile
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
          devcontainerConfigName: devcontainerConfigName.trim() || undefined,
        };

    return completedAttachments.length > 0
      ? { ...base, attachments: completedAttachments }
      : base;
  };

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setPriority(0);
    setAgentProfileId(null);
    setVmSize('');
    setWorkspaceProfile('');
    setDevcontainerConfigName('');
    setAttachments([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
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
    if (uploading) {
      setError('Please wait for file uploads to complete');
      return;
    }
    try {
      setError(null);
      setSubmitting(true);
      await onRunNow(trimmed, buildOptions());
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
      await onSaveToBacklog(trimmed, buildOptions());
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

      {/* Attachment list */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((att, index) => (
            <div
              key={`${att.file.name}-${index}`}
              className="flex items-center gap-1.5 py-1 px-2 rounded-sm bg-page border border-border-default text-xs max-w-[220px]"
            >
              <span className="truncate text-fg-primary" title={att.file.name}>
                {att.file.name}
              </span>
              <span className="text-fg-muted shrink-0">
                {att.status === 'uploading' ? `${att.progress}%` : formatFileSize(att.file.size)}
              </span>
              {att.status === 'error' && (
                <span className="text-danger shrink-0" title={att.error}>!</span>
              )}
              <button
                type="button"
                onClick={() => handleRemoveAttachment(index)}
                className="shrink-0 p-0.5 bg-transparent border-none text-fg-muted hover:text-fg-primary cursor-pointer"
                aria-label={`Remove ${att.file.name}`}
              >
                <X size={12} />
              </button>
              {att.status === 'uploading' && (
                <div className="absolute bottom-0 left-0 h-0.5 bg-accent-emphasis rounded-full transition-all" style={{ width: `${att.progress}%` }} />
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-start">
        {/* Attachment button */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handleFilesSelected(e.target.files)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={submitting || uploading}
          className="shrink-0 p-2 bg-transparent border border-border-default rounded-md text-fg-muted hover:text-fg-primary hover:border-fg-muted cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label="Attach files"
          title="Attach files to this task"
        >
          <Paperclip size={18} />
        </button>

        <div className="flex-1">
          <input
            type="text"
            value={title}
            onChange={(e) => { setTitle(e.target.value); setError(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !submitting && allUploadsComplete) {
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
          disabled={submitting || !allUploadsComplete}
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

                {workspaceProfile !== 'lightweight' && (
                  <div>
                    <label className="text-xs text-fg-muted block mb-1">
                      Devcontainer Config
                    </label>
                    <input
                      type="text"
                      value={devcontainerConfigName}
                      onChange={(e) => setDevcontainerConfigName(e.target.value)}
                      placeholder="Auto-detect"
                      className="py-1 px-2 bg-surface border border-border-default rounded-sm text-fg-primary text-sm w-full"
                    />
                  </div>
                )}
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
