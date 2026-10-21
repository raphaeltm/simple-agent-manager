import type { SlashCommand } from '@simple-agent-manager/acp-client';
import type {
  AgentInfo,
  AgentProfile,
  AgentSkill,
  TaskMode,
  UpdateAgentProfileRequest,
} from '@simple-agent-manager/shared';
import { Paperclip } from 'lucide-react';
import type { MutableRefObject } from 'react';
import { useState } from 'react';

import { ProfileFormDialog } from '../../components/agent-profiles/ProfileFormDialog';
import {
  ComposerOptionsButton,
  composerOptionsCount,
  ComposerOptionsPanel,
  type ComposerOptionsValue,
  ProfilePickerSheet,
  ProfileToControl,
} from '../../components/project-chat/profile-picker';
import { ProjectChatComposer } from '../../components/project-chat/ProjectChatComposer';
import {
  hasValidationErrors,
  type ResourceRequirementsFormState,
  type ResourceValidationErrors,
} from '../../components/resource-requirements';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { UseProfilePickerResult } from '../../hooks/useProfilePicker';
import { NoAgentsNotice, NoProfilesGate, ProfileWizardPanel } from './ProfileWizardPanel';
import type { ProfileSheetState, ProfileWizardState } from './useProfileChoice';

interface ChatAttachmentDisplay {
  file: File;
  uploadId: string | null;
  progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
}

type ChatInputProps = Readonly<{
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string | null;
  placeholder: string;
  transcribeApiUrl: string;
  projectId: string;
  agents: AgentInfo[];
  agentProfiles: AgentProfile[];
  selectedProfileId: string | null;
  onProfileChange: (profileId: string | null) => void;
  profilePicker: UseProfilePickerResult;
  profileSheet: ProfileSheetState;
  onOpenProfileSheet: (anchor: DOMRect | null) => void;
  onCloseProfileSheet: () => void;
  skills: AgentSkill[];
  selectedSkillId: string | null;
  onSkillChange: (skillId: string | null) => void;
  onUpdateProfile: (profileId: string, data: UpdateAgentProfileRequest) => Promise<void>;
  taskResourceReqs: ResourceRequirementsFormState;
  onTaskResourceReqsChange: (next: ResourceRequirementsFormState) => void;
  taskResourceErrors: ResourceValidationErrors;
  onTaskResourceErrorsClear: () => void;
  profileWizard: ProfileWizardState;
  onOpenProfileWizard: () => void;
  onCloseProfileWizard: () => void;
  onUpdateProfileWizard: (patch: Partial<ProfileWizardState>) => void;
  onCreateProfileFromWizard: () => Promise<AgentProfile | null>;
  suggestProfileName: (agentType: string | null, workType: TaskMode | null) => string;
  slashCommands?: SlashCommand[];
  attachments?: ChatAttachmentDisplay[];
  onFilesSelected?: (files: FileList | File[] | null) => void;
  onRemoveAttachment?: (index: number) => void;
  fileInputRef?: MutableRefObject<HTMLInputElement | null>;
  uploading?: boolean;
}>;

function getComposerPlaceholder({
  noAgents,
  needsProfileBeforeSubmit,
  wizardOpen,
  placeholder,
}: Readonly<{
  noAgents: boolean;
  needsProfileBeforeSubmit: boolean;
  wizardOpen: boolean;
  placeholder: string;
}>) {
  if (noAgents) return 'Add an agent in Settings to start chatting...';
  if (needsProfileBeforeSubmit || wizardOpen) return 'Create a profile to start chatting...';
  return placeholder;
}

/**
 * The new-chat composer: one toolbar row (who the chat goes to, attach, options) above
 * the message box. Profiles are picked in a sheet or from the cards above, not from a
 * wall of chips (idea 01M5EW9H86VD88S7E3WWA1D9X1).
 */
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
  agentProfiles,
  selectedProfileId,
  onProfileChange,
  profilePicker,
  profileSheet,
  onOpenProfileSheet,
  onCloseProfileSheet,
  skills,
  selectedSkillId,
  onSkillChange,
  onUpdateProfile,
  taskResourceReqs,
  onTaskResourceReqsChange,
  taskResourceErrors,
  onTaskResourceErrorsClear,
  profileWizard,
  onOpenProfileWizard,
  onCloseProfileWizard,
  onUpdateProfileWizard,
  onCreateProfileFromWizard,
  suggestProfileName,
  slashCommands,
  attachments,
  onFilesSelected,
  onRemoveAttachment,
  fileInputRef,
  uploading,
}: ChatInputProps) {
  const isMobile = useIsMobile();
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const hasResourceErrors = hasValidationErrors(taskResourceErrors);

  const selectedProfile = selectedProfileId
    ? (agentProfiles.find((p) => p.id === selectedProfileId) ?? null)
    : null;
  const needsProfileBeforeSubmit = agentProfiles.length === 0 && agents.length >= 1;
  const noAgents = agents.length === 0;
  const inputDisabled = noAgents || needsProfileBeforeSubmit || profileWizard.open;
  const showToolbar = !inputDisabled && agentProfiles.length > 0;
  const composerPlaceholder = getComposerPlaceholder({
    noAgents,
    needsProfileBeforeSubmit,
    wizardOpen: profileWizard.open,
    placeholder,
  });
  const options: ComposerOptionsValue = {
    skills,
    selectedSkillId,
    onSkillChange,
    taskResourceReqs,
    onTaskResourceReqsChange,
    taskResourceErrors,
    onTaskResourceErrorsClear,
    disabled: submitting,
  };
  const showOptions = optionsOpen || hasResourceErrors;

  return (
    <div className="relative shrink-0 glass-chrome border-x-0 border-b-0 px-4 py-3 before:content-[''] before:absolute before:top-0 before:left-[15%] before:right-[15%] before:h-px before:bg-[radial-gradient(ellipse_at_center,rgba(34,197,94,0.18)_0%,transparent_70%)] before:pointer-events-none">
      {error && (
        <div role="alert" className="p-2 px-3 mb-2 rounded-sm bg-danger-tint text-danger text-xs">
          {error}
        </div>
      )}

      {noAgents && <NoAgentsNotice projectId={projectId} />}

      {needsProfileBeforeSubmit && !profileWizard.open && (
        <NoProfilesGate onStartWizard={onOpenProfileWizard} />
      )}

      {profileWizard.open && (
        <ProfileWizardPanel
          agents={agents}
          profileWizard={profileWizard}
          onCloseProfileWizard={onCloseProfileWizard}
          onUpdateProfileWizard={onUpdateProfileWizard}
          onCreateProfileFromWizard={onCreateProfileFromWizard}
          suggestProfileName={suggestProfileName}
        />
      )}

      {showToolbar && showOptions && <ComposerOptionsPanel options={options} compact={isMobile} />}

      {showToolbar && (
        <div className="mb-2 flex items-center gap-2">
          <div className="@container min-w-0 flex-1">
            <ProfileToControl
              profile={selectedProfile}
              loading={profilePicker.picker.status === 'loading'}
              disabled={submitting}
              onOpen={onOpenProfileSheet}
            />
          </div>
          {onFilesSelected && (
            <button
              type="button"
              onClick={() => fileInputRef?.current?.click()}
              disabled={submitting || Boolean(uploading)}
              aria-label="Attach files to this task"
              title="Attach files to this task"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border-default bg-transparent text-fg-muted transition-colors hover:text-fg-primary disabled:opacity-50"
            >
              <Paperclip
                size={16}
                className={uploading ? 'animate-pulse' : ''}
                aria-hidden="true"
              />
            </button>
          )}
          <ComposerOptionsButton
            open={showOptions}
            count={composerOptionsCount(options)}
            disabled={submitting}
            onToggle={() => setOptionsOpen((open) => !open)}
          />
        </div>
      )}

      <ProjectChatComposer
        value={value}
        onChange={onChange}
        onSend={onSubmit}
        sending={submitting}
        disabled={inputDisabled}
        placeholder={composerPlaceholder}
        transcribeApiUrl={transcribeApiUrl}
        slashCommands={slashCommands}
        agentProfiles={agentProfiles}
        attachments={attachments}
        onFilesSelected={onFilesSelected}
        onRemoveAttachment={onRemoveAttachment}
        fileInputRef={fileInputRef}
        uploading={uploading}
        showShortcutHint={!isMobile}
        showAttachButton={!showToolbar}
        attachTitle="Attach files to this task"
      />
      <ProfilePickerSheet
        open={profileSheet.open}
        anchor={profileSheet.anchor}
        projectId={projectId}
        profiles={agentProfiles}
        selectedProfileId={selectedProfileId}
        pickerState={profilePicker.state}
        hiddenUpdating={profilePicker.updating}
        hiddenUpdateError={profilePicker.updateError}
        onSelect={onProfileChange}
        onSetHidden={profilePicker.setHidden}
        onClose={onCloseProfileSheet}
        onNewProfile={onOpenProfileWizard}
        onEditProfile={selectedProfile ? () => setEditProfileOpen(true) : undefined}
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
