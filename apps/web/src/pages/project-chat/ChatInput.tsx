import type { SlashCommand } from '@simple-agent-manager/acp-client';
import type {
  AgentInfo,
  AgentProfile,
  AgentSkill,
  TaskMode,
  UpdateAgentProfileRequest,
} from '@simple-agent-manager/shared';
import { paneClassName } from '@simple-agent-manager/ui';
import { Paperclip } from 'lucide-react';
import type { MutableRefObject } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import { ProfileFormDialog } from '../../components/agent-profiles/ProfileFormDialog';
import {
  activeChatAgentOverrides,
  chatAgentDefaults,
  type ChatAgentOverrides,
  ComposerOptionsButton,
  composerOptionsCount,
  ComposerOptionsPanel,
  type ComposerOptionsValue,
  ProfilePickerSheet,
  ProfileToControl,
  type ProfileUsage,
  ProfileUsageNudge,
  RunAccountButton,
  RunAccountPanel,
  usageEntry,
  useRunAccounts,
  withChatAccount,
} from '../../components/project-chat/profile-picker';
import {
  effectiveChatAgent,
  EMPTY_CHAT_AGENT_OVERRIDES,
} from '../../components/project-chat/profile-picker/agent-overrides';
import { agentLabel } from '../../components/project-chat/profile-picker/model';
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
  /** What's left on each profile's account; null while loading. */
  profileUsages?: ReadonlyMap<string, ProfileUsage> | null;
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
  agentOverrides: ChatAgentOverrides;
  onAgentOverridesChange: (next: ChatAgentOverrides) => void;
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
  profileUsages,
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
  agentOverrides,
  onAgentOverridesChange,
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
  const [accountsOpen, setAccountsOpen] = useState(false);
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
  const selectedSkill = selectedSkillId
    ? (skills.find((skill) => skill.id === selectedSkillId) ?? null)
    : null;
  const agentDefaults = chatAgentDefaults(selectedProfile, selectedSkill);
  const effectiveAgent = effectiveChatAgent(agentDefaults, agentOverrides);
  // Usage belongs to the account the profile's agent resolves to. A skill or Chat option
  // that switches the agent runs on a different account, so the profile's usage would lie.
  const selectedUsage =
    selectedProfile &&
    (!effectiveAgent.agentType || effectiveAgent.agentType === selectedProfile.agentType)
      ? usageEntry(profileUsages, selectedProfile.id)
      : undefined;
  // Overrides belong to the agent they were picked for: a profile or skill that switches the
  // agent clears them, so switching back starts from that agent's defaults again.
  const effectiveAgentType = agentDefaults.agentType;
  useEffect(() => {
    if (
      agentOverrides.agentType &&
      effectiveAgentType &&
      agentOverrides.agentType !== effectiveAgentType
    ) {
      onAgentOverridesChange(EMPTY_CHAT_AGENT_OVERRIDES);
    }
  }, [agentOverrides.agentType, effectiveAgentType, onAgentOverridesChange]);
  // The account this chat runs on: one chosen for this chat (beside To, or from the nudge),
  // else the profile's. The ring and the nudge follow it.
  const runAccounts = useRunAccounts(effectiveAgentType, showToolbar && Boolean(profileUsages));
  const chosenAccountId = activeChatAgentOverrides(agentOverrides, effectiveAgentType).accountId;
  const chosenAccount = chosenAccountId
    ? (runAccounts?.find((account) => account.id === chosenAccountId) ?? null)
    : null;
  const runUsage = chosenAccount ? chosenAccount.usage : selectedUsage;
  const profileAccountId = selectedUsage?.accountId ?? null;
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const closeAccounts = () => {
    setAccountsOpen(false);
    // The list (or the nudge button) that had focus unmounts: return it to the trigger.
    requestAnimationFrame(() => accountButtonRef.current?.focus());
  };
  const chooseAccount = (accountId: string | null) => {
    if (!effectiveAgentType) return;
    // Choosing the profile's own account is no choice at all: send nothing, inherit.
    const next = accountId && accountId !== profileAccountId ? accountId : null;
    onAgentOverridesChange(withChatAccount(agentOverrides, effectiveAgentType, next));
    closeAccounts();
  };
  // A chosen account that was paused or removed since is dropped, not sent to be refused.
  useEffect(() => {
    if (runAccounts && chosenAccountId && !chosenAccount && effectiveAgentType) {
      onAgentOverridesChange(withChatAccount(agentOverrides, effectiveAgentType, null));
    }
  }, [
    runAccounts,
    chosenAccountId,
    chosenAccount,
    effectiveAgentType,
    agentOverrides,
    onAgentOverridesChange,
  ]);
  // What the profile runs on when it is not one of your accounts: the platform, or nothing.
  const profileAccountLabel =
    selectedUsage?.accountLabel ??
    (selectedUsage?.state === 'platform'
      ? 'SAM platform'
      : selectedUsage?.state === 'none'
        ? 'No account'
        : null);
  const runAccountLabel = chosenAccount?.label ?? profileAccountLabel;
  // Worth showing when there is a choice to make: another account than the profile's.
  const otherAccounts = (runAccounts ?? []).filter((account) => account.id !== profileAccountId);
  const showAccountControl = Boolean(
    runAccounts && runAccountLabel && (otherAccounts.length > 0 || chosenAccount)
  );
  const accountsPanelId = useId();
  const options: ComposerOptionsValue = {
    skills,
    selectedSkillId,
    onSkillChange,
    taskResourceReqs,
    onTaskResourceReqsChange,
    taskResourceErrors,
    onTaskResourceErrorsClear,
    agentDefaults,
    agentOverrides,
    onAgentOverridesChange,
    disabled: submitting,
  };
  const showOptions = optionsOpen || hasResourceErrors;
  const optionsPanelId = useId();

  return (
    // The new-chat message box is a SAM Glass slab, like the follow-up composer in a chat.
    <div className={`${paneClassName('slab')} shrink-0 px-3 py-3 md:px-4`}>
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

      {showToolbar && showOptions && (
        <ComposerOptionsPanel id={optionsPanelId} options={options} compact={isMobile} />
      )}

      {showToolbar && accountsOpen && showAccountControl && runAccounts && (
        <RunAccountPanel
          id={accountsPanelId}
          accounts={runAccounts}
          selectedId={chosenAccount?.id ?? null}
          profileAccountId={profileAccountId}
          profileAccountLabel={profileAccountLabel}
          agentName={effectiveAgentType ? agentLabel(effectiveAgentType) : 'agent'}
          profileName={selectedProfile?.name ?? null}
          disabled={submitting}
          onSelect={chooseAccount}
          onClose={closeAccounts}
        />
      )}

      {/* While the account list is open it is the place to choose; the nudge would repeat it. */}
      {showToolbar && selectedProfile && profileUsages && !accountsOpen && (
        <ProfileUsageNudge
          usage={runUsage}
          profileUsage={selectedUsage}
          accounts={runAccounts}
          chosenAccount={chosenAccount}
          onChooseAccount={chooseAccount}
          disabled={submitting}
        />
      )}

      {showToolbar && (
        <div className="mb-2 flex items-center gap-2">
          {/* The account wraps under To when the toolbar is narrow (a phone). */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <div className="@container min-w-[9rem] flex-1">
              <ProfileToControl
                profile={selectedProfile}
                effective={effectiveAgent}
                usage={runUsage}
                loading={profilePicker.picker.status === 'loading'}
                disabled={submitting}
                onOpen={onOpenProfileSheet}
              />
            </div>
            {showAccountControl && runAccountLabel && (
              <RunAccountButton
                buttonRef={accountButtonRef}
                label={runAccountLabel}
                chosen={Boolean(chosenAccount)}
                open={accountsOpen}
                panelId={accountsPanelId}
                disabled={submitting}
                onToggle={() => setAccountsOpen((open) => !open)}
              />
            )}
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
            panelId={optionsPanelId}
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
        usages={profileUsages}
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
