import type { SlashCommand } from '@simple-agent-manager/acp-client';
import type { AgentInfo, AgentProfile, ProviderCatalog, TaskMode, UpdateAgentProfileRequest, VMSize, WorkspaceProfile } from '@simple-agent-manager/shared';
import { Settings } from 'lucide-react';
import type { MutableRefObject } from 'react';
import { useState } from 'react';

import { ProfileFormDialog } from '../../components/agent-profiles/ProfileFormDialog';
import { ProfileSelector } from '../../components/agent-profiles/ProfileSelector';
import { DevcontainerConfigSelect } from '../../components/devcontainer/DevcontainerConfigSelect';
import { ProjectChatComposer } from '../../components/project-chat/ProjectChatComposer';
import { formatProviderCatalogContext, formatVmSizeOption, selectProviderCatalog } from '../../components/vm/format-vm-size';
import { useIsMobile } from '../../hooks/useIsMobile';

interface ChatAttachmentDisplay {
  file: File;
  uploadId: string | null;
  progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  submitting,
  error,
  placeholder,
  transcribeApiUrl,
  projectId,
  agents,
  selectedAgentType,
  onAgentTypeChange,
  agentProfiles,
  selectedProfileId,
  onProfileChange,
  onUpdateProfile,
  selectedVmSize,
  onVmSizeChange,
  selectedWorkspaceProfile,
  onWorkspaceProfileChange,
  selectedDevcontainerConfigName,
  onDevcontainerConfigNameChange,
  selectedTaskMode,
  onTaskModeChange,
  providerCatalogs,
  projectDefaultProvider,
  projectDefaultLocation,
  slashCommands,
  attachments,
  onFilesSelected,
  onRemoveAttachment,
  fileInputRef,
  uploading,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string | null;
  placeholder: string;
  transcribeApiUrl: string;
  projectId: string;
  agents: AgentInfo[];
  selectedAgentType: string | null;
  onAgentTypeChange: (agentType: string) => void;
  agentProfiles: AgentProfile[];
  selectedProfileId: string | null;
  onProfileChange: (profileId: string | null) => void;
  onUpdateProfile: (profileId: string, data: UpdateAgentProfileRequest) => Promise<void>;
  selectedVmSize: VMSize;
  onVmSizeChange: (size: VMSize) => void;
  selectedWorkspaceProfile: WorkspaceProfile;
  onWorkspaceProfileChange: (profile: WorkspaceProfile) => void;
  selectedDevcontainerConfigName: string;
  onDevcontainerConfigNameChange: (name: string) => void;
  selectedTaskMode: TaskMode;
  onTaskModeChange: (mode: TaskMode) => void;
  providerCatalogs: ProviderCatalog[];
  projectDefaultProvider?: string | null;
  projectDefaultLocation?: string | null;
  slashCommands?: SlashCommand[];
  attachments?: ChatAttachmentDisplay[];
  onFilesSelected?: (files: FileList | null) => void;
  onRemoveAttachment?: (index: number) => void;
  fileInputRef?: MutableRefObject<HTMLInputElement | null>;
  uploading?: boolean;
}) {
  const isMobile = useIsMobile();
  const [editProfileOpen, setEditProfileOpen] = useState(false);

  const hasProfile = !!selectedProfileId;
  const selectedProfile = hasProfile
    ? agentProfiles.find((p) => p.id === selectedProfileId) ?? null
    : null;
  const activeCatalog = selectProviderCatalog(providerCatalogs, projectDefaultProvider);
  const providerContext = formatProviderCatalogContext(activeCatalog, projectDefaultLocation);
  const vmSizeOptions = (['small', 'medium', 'large'] as VMSize[]).map((size) => (
    <option key={size} value={size}>
      {formatVmSizeOption(size, activeCatalog?.sizes[size] ?? null)}
    </option>
  ));

  return (
    <div className="relative shrink-0 glass-chrome border-x-0 border-b-0 px-4 py-3 before:content-[''] before:absolute before:top-0 before:left-[15%] before:right-[15%] before:h-px before:bg-[radial-gradient(ellipse_at_center,rgba(34,197,94,0.18)_0%,transparent_70%)] before:pointer-events-none">
      {error && (
        <div className="p-2 px-3 mb-2 rounded-sm bg-danger-tint text-danger text-xs">
          {error}
        </div>
      )}
      {isMobile ? (
        /* Mobile: compact pill bar — no labels, single row */
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          {agentProfiles.length > 0 && (
            <>
              <ProfileSelector
                profiles={agentProfiles}
                selectedProfileId={selectedProfileId}
                onChange={onProfileChange}
                disabled={submitting}
                compact
                className="min-w-0 flex-1 min-h-[44px]"
              />
              {hasProfile && (
                <button
                  type="button"
                  onClick={() => setEditProfileOpen(true)}
                  disabled={submitting}
                  aria-label="Edit profile settings"
                  className="shrink-0 p-2 min-h-[44px] min-w-[44px] flex items-center justify-center border border-border-default rounded-md bg-page text-fg-muted hover:text-fg-primary cursor-pointer disabled:opacity-50"
                >
                  <Settings size={16} />
                </button>
              )}
            </>
          )}
          {!hasProfile && (
            <>
              {agents.length > 1 && (
                <select
                  value={selectedAgentType ?? ''}
                  onChange={(e) => onAgentTypeChange(e.target.value)}
                  disabled={submitting}
                  aria-label="Agent"
                  className="min-w-0 flex-1 px-2 py-1.5 min-h-[44px] border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              )}
              <select
                value={selectedVmSize}
                onChange={(e) => onVmSizeChange(e.target.value as VMSize)}
                disabled={submitting}
                aria-label="VM size"
                className="min-w-0 flex-1 px-2 py-1.5 min-h-[44px] border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
              >
                {vmSizeOptions}
              </select>
              <select
                value={selectedWorkspaceProfile}
                onChange={(e) => onWorkspaceProfileChange(e.target.value as WorkspaceProfile)}
                disabled={submitting}
                aria-label="Workspace profile"
                className="min-w-0 flex-1 px-2 py-1.5 min-h-[44px] border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
              >
                <option value="full">Full</option>
                <option value="lightweight">Lightweight</option>
              </select>
              {selectedWorkspaceProfile !== 'lightweight' && (
                <DevcontainerConfigSelect
                  projectId={projectId}
                  value={selectedDevcontainerConfigName}
                  onChange={onDevcontainerConfigNameChange}
                  disabled={submitting}
                  compact
                />
              )}
              <select
                value={selectedTaskMode}
                onChange={(e) => onTaskModeChange(e.target.value as TaskMode)}
                disabled={submitting}
                aria-label="Run mode"
                aria-describedby="mobile-task-mode-desc"
                className="min-w-0 flex-1 px-2 py-1.5 min-h-[44px] border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
              >
                <option value="task">Task</option>
                <option value="conversation">Conversation</option>
              </select>
              <span id="mobile-task-mode-desc" className="sr-only">
                {selectedTaskMode === 'task'
                  ? 'Agent will do the work, push changes, and create a PR'
                  : 'Chat with an agent. You decide when it\'s done.'}
              </span>
            </>
          )}
        </div>
      ) : (
        /* Desktop: labeled selects with wrapping */
        <div className="flex items-center gap-4 mb-2 flex-wrap">
          {agentProfiles.length > 0 && (
            <div className="flex items-center gap-2">
              <label htmlFor="profile-select" className="text-xs text-fg-muted whitespace-nowrap">Profile:</label>
              <ProfileSelector
                id="profile-select"
                profiles={agentProfiles}
                selectedProfileId={selectedProfileId}
                onChange={onProfileChange}
                disabled={submitting}
                compact
              />
              {hasProfile && (
                <button
                  type="button"
                  onClick={() => setEditProfileOpen(true)}
                  disabled={submitting}
                  aria-label="Edit profile settings"
                  className="shrink-0 p-1 border border-border-default rounded-md bg-page text-fg-muted hover:text-fg-primary cursor-pointer disabled:opacity-50"
                >
                  <Settings size={14} />
                </button>
              )}
            </div>
          )}
          {!hasProfile && (
            <>
              {agents.length > 1 && (
                <div className="flex items-center gap-2">
                  <label htmlFor="agent-type-select" className="text-xs text-fg-muted whitespace-nowrap">Agent:</label>
                  <select
                    id="agent-type-select"
                    value={selectedAgentType ?? ''}
                    onChange={(e) => onAgentTypeChange(e.target.value)}
                    disabled={submitting}
                    className="px-2 py-1 border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
                  >
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex items-center gap-2">
                <label htmlFor="vm-size-select" className="text-xs text-fg-muted whitespace-nowrap">
                  VM{providerContext ? ` (${providerContext})` : ''}:
                </label>
                <select
                  id="vm-size-select"
                  value={selectedVmSize}
                  onChange={(e) => onVmSizeChange(e.target.value as VMSize)}
                  disabled={submitting}
                  className="px-2 py-1 border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
                >
                  {vmSizeOptions}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="workspace-profile-select" className="text-xs text-fg-muted whitespace-nowrap">Workspace:</label>
                <select
                  id="workspace-profile-select"
                  value={selectedWorkspaceProfile}
                  onChange={(e) => onWorkspaceProfileChange(e.target.value as WorkspaceProfile)}
                  disabled={submitting}
                  className="px-2 py-1 border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
                >
                  <option value="full">Full</option>
                  <option value="lightweight">Lightweight</option>
                </select>
              </div>
              {selectedWorkspaceProfile !== 'lightweight' && (
                <div className="flex items-center gap-2">
                  <label htmlFor="devcontainer-config-select" className="text-xs text-fg-muted whitespace-nowrap">Config:</label>
                  <DevcontainerConfigSelect
                    id="devcontainer-config-select"
                    projectId={projectId}
                    value={selectedDevcontainerConfigName}
                    onChange={onDevcontainerConfigNameChange}
                    disabled={submitting}
                  />
                </div>
              )}
              <div className="flex items-center gap-2">
                <label htmlFor="task-mode-select" className="text-xs text-fg-muted whitespace-nowrap">Run mode:</label>
                <select
                  id="task-mode-select"
                  value={selectedTaskMode}
                  onChange={(e) => onTaskModeChange(e.target.value as TaskMode)}
                  disabled={submitting}
                  className="px-2 py-1 border border-border-default rounded-md bg-page text-fg-primary text-xs outline-none cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
                  aria-describedby="task-mode-desc"
                >
                  <option value="task">Task</option>
                  <option value="conversation">Conversation</option>
                </select>
                <span id="task-mode-desc" className="sr-only">
                  {selectedTaskMode === 'task'
                    ? 'Agent will do the work, push changes, and create a PR'
                    : 'Chat with an agent. You decide when it\'s done.'}
                </span>
              </div>
            </>
          )}
        </div>
      )}
      <ProjectChatComposer
        value={value}
        onChange={onChange}
        onSend={onSubmit}
        sending={submitting}
        placeholder={placeholder}
        transcribeApiUrl={transcribeApiUrl}
        slashCommands={slashCommands}
        agentProfiles={agentProfiles}
        attachments={attachments}
        onFilesSelected={onFilesSelected}
        onRemoveAttachment={onRemoveAttachment}
        fileInputRef={fileInputRef}
        uploading={uploading}
        showShortcutHint={!isMobile}
        attachTitle="Attach files to this task"
      />
      {selectedProfile && (
        <ProfileFormDialog
          isOpen={editProfileOpen}
          onClose={() => setEditProfileOpen(false)}
          profile={selectedProfile}
          onSave={async (data) => {
            await onUpdateProfile(selectedProfile.id, data as UpdateAgentProfileRequest);
          }}
          projectId={projectId}
        />
      )}
    </div>
  );
}
