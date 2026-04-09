import type { SlashCommand, SlashCommandPaletteHandle } from '@simple-agent-manager/acp-client';
import { SlashCommandPalette, VoiceButton } from '@simple-agent-manager/acp-client';
import type { AgentInfo, AgentProfile, TaskMode, UpdateAgentProfileRequest, WorkspaceProfile } from '@simple-agent-manager/shared';
import { Paperclip, Settings, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ProfileFormDialog } from '../../components/agent-profiles/ProfileFormDialog';
import { ProfileSelector } from '../../components/agent-profiles/ProfileSelector';
import { useIsMobile } from '../../hooks/useIsMobile';
import { formatFileSize } from '../../lib/file-utils';

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
  agents,
  selectedAgentType,
  onAgentTypeChange,
  agentProfiles,
  selectedProfileId,
  onProfileChange,
  onUpdateProfile,
  selectedWorkspaceProfile,
  onWorkspaceProfileChange,
  selectedTaskMode,
  onTaskModeChange,
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
  agents: AgentInfo[];
  selectedAgentType: string | null;
  onAgentTypeChange: (agentType: string) => void;
  agentProfiles: AgentProfile[];
  selectedProfileId: string | null;
  onProfileChange: (profileId: string | null) => void;
  onUpdateProfile: (profileId: string, data: UpdateAgentProfileRequest) => Promise<void>;
  selectedWorkspaceProfile: WorkspaceProfile;
  onWorkspaceProfileChange: (profile: WorkspaceProfile) => void;
  selectedTaskMode: TaskMode;
  onTaskModeChange: (mode: TaskMode) => void;
  slashCommands?: SlashCommand[];
  attachments?: ChatAttachmentDisplay[];
  onFilesSelected?: (files: FileList | null) => void;
  onRemoveAttachment?: (index: number) => void;
  fileInputRef?: React.RefObject<HTMLInputElement | null>;
  uploading?: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const paletteRef = useRef<SlashCommandPaletteHandle>(null);
  const isMobile = useIsMobile();
  const [editProfileOpen, setEditProfileOpen] = useState(false);

  const hasProfile = !!selectedProfileId;
  const selectedProfile = hasProfile
    ? agentProfiles.find((p) => p.id === selectedProfileId) ?? null
    : null;

  // Slash command palette state.
  // dismissedFilterRef tracks the exact filter string at the time the user pressed
  // Escape — the palette stays closed until the filter changes (user types more).
  const dismissedFilterRef = useRef<string | null>(null);
  const slashMatch = value.match(/^\/(\S*)$/);
  const slashFilter = slashMatch?.[1] ?? '';
  // Clear the dismissed state whenever the input exits slash-command mode entirely
  // (e.g., user cleared the field) so the next "/" still opens the palette.
  if (!slashMatch && dismissedFilterRef.current !== null) {
    dismissedFilterRef.current = null;
  }
  const showPalette =
    !!slashMatch &&
    (slashCommands?.length ?? 0) > 0 &&
    dismissedFilterRef.current !== slashFilter;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Auto-grow: resize textarea to fit content up to max-height
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [value]);

  const handleTranscription = useCallback(
    (text: string) => {
      const separator = value.length > 0 && !value.endsWith(' ') ? ' ' : '';
      onChange(value + separator + text);
      inputRef.current?.focus();
    },
    [value, onChange],
  );

  const handleCommandSelect = useCallback(
    (cmd: SlashCommand) => {
      onChange(`/${cmd.name} `);
      inputRef.current?.focus();
    },
    [onChange],
  );

  const handleDismissPalette = useCallback(() => {
    // Record the current filter as dismissed so the palette stays closed until
    // the user changes the input further. Does NOT clear the typed text.
    dismissedFilterRef.current = slashFilter;
    inputRef.current?.focus();
  }, [slashFilter]);

  return (
    <div className="shrink-0 border-t border-border-default px-4 py-3 bg-surface">
      {error && (
        <div className="p-2 px-3 mb-2 rounded-sm bg-danger-tint text-danger text-xs">
          {error}
        </div>
      )}
      {slashCommands && slashCommands.length > 0 && (
        <SlashCommandPalette
          ref={paletteRef}
          commands={slashCommands}
          filter={slashFilter}
          onSelect={handleCommandSelect}
          onDismiss={handleDismissPalette}
          visible={showPalette}
        />
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
                value={selectedWorkspaceProfile}
                onChange={(e) => onWorkspaceProfileChange(e.target.value as WorkspaceProfile)}
                disabled={submitting}
                aria-label="Workspace profile"
                className="min-w-0 flex-1 px-2 py-1.5 min-h-[44px] border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
              >
                <option value="full">Full</option>
                <option value="lightweight">Lightweight</option>
              </select>
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
      {/* Attachment chips */}
      {attachments && attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((att, index) => (
            <div
              key={`${att.file.name}-${index}`}
              className="relative flex items-center gap-1.5 py-1 px-2 rounded-sm bg-page border border-border-default text-xs max-w-[220px] overflow-hidden"
            >
              <span className="truncate text-fg-primary" title={att.file.name}>{att.file.name}</span>
              <span className="text-fg-muted shrink-0">
                {att.status === 'uploading' ? `${att.progress}%` : formatFileSize(att.file.size)}
              </span>
              {att.status === 'error' && (
                <span className="text-danger shrink-0 truncate max-w-[120px]">
                  {att.error ? att.error : 'Failed'}
                </span>
              )}
              {onRemoveAttachment && (
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(index)}
                  className="shrink-0 p-0.5 bg-transparent border-none text-fg-muted hover:text-fg-primary cursor-pointer"
                  aria-label={`Remove ${att.file.name}`}
                >
                  <X size={12} />
                </button>
              )}
              {att.status === 'uploading' && (
                <div className="absolute bottom-0 left-0 h-0.5 bg-accent-emphasis rounded-full transition-all" style={{ width: `${att.progress}%` }} />
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 items-end">
        {/* Attachment button */}
        {onFilesSelected && (
          <>
            <input
              ref={fileInputRef as React.RefObject<HTMLInputElement>}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => onFilesSelected(e.target.files)}
            />
            <button
              type="button"
              onClick={() => (fileInputRef as React.RefObject<HTMLInputElement>)?.current?.click()}
              disabled={submitting || uploading}
              className="shrink-0 p-2 bg-transparent border border-border-default rounded-md text-fg-muted hover:text-fg-primary hover:border-fg-muted cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Attach files"
              title="Attach files to this task"
            >
              <Paperclip size={18} />
            </button>
          </>
        )}
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Delegate to slash command palette first
            if (paletteRef.current?.handleKeyDown(e as unknown as React.KeyboardEvent)) return;
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !submitting) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={placeholder}
          disabled={submitting}
          rows={1}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showPalette}
          aria-controls={showPalette ? 'slash-palette-listbox' : undefined}
          aria-activedescendant={showPalette ? paletteRef.current?.activeDescendantId : undefined}
          className="flex-1 p-2 px-3 bg-page border border-border-default rounded-md text-fg-primary text-base outline-none resize-none font-[inherit] leading-[1.5] min-h-[38px] max-h-[120px] overflow-y-auto"
        />
        <VoiceButton
          onTranscription={handleTranscription}
          disabled={submitting}
          apiUrl={transcribeApiUrl}
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting || !value.trim() || uploading}
          className="px-3 py-2 border-none rounded-md text-base font-medium whitespace-nowrap"
          style={{
            backgroundColor: submitting || !value.trim() || uploading ? 'var(--sam-color-bg-inset)' : 'var(--sam-color-accent-primary)',
            color: submitting || !value.trim() || uploading ? 'var(--sam-color-fg-muted)' : 'white',
            cursor: submitting || !value.trim() || uploading ? 'default' : 'pointer',
          }}
        >
          {submitting ? 'Sending...' : 'Send'}
        </button>
      </div>
      {!isMobile && (
        <div className="sam-type-caption text-fg-muted mt-1">
          Press Ctrl+Enter to send, Enter for new line
        </div>
      )}
      {selectedProfile && (
        <ProfileFormDialog
          isOpen={editProfileOpen}
          onClose={() => setEditProfileOpen(false)}
          profile={selectedProfile}
          onSave={async (data) => {
            await onUpdateProfile(selectedProfile.id, data as UpdateAgentProfileRequest);
          }}
        />
      )}
    </div>
  );
}
