import type { SlashCommand } from '@simple-agent-manager/acp-client';
import type { AgentInfo, AgentProfile, ProviderCatalog, TaskMode, UpdateAgentProfileRequest, VMSize } from '@simple-agent-manager/shared';
import { VM_SIZE_LABELS } from '@simple-agent-manager/shared';
import { Check, ChevronRight, MessageSquare, Monitor, Plus, Settings, Wrench } from 'lucide-react';
import type { MutableRefObject, ReactNode } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { ProfileFormDialog } from '../../components/agent-profiles/ProfileFormDialog';
import { ProjectChatComposer } from '../../components/project-chat/ProjectChatComposer';
import { formatProviderCatalogContext, lookupSizeInfo, selectProviderCatalog } from '../../components/vm/format-vm-size';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { ProfileWizardState, ProfileWizardStep } from './useProjectChatState';

interface ChatAttachmentDisplay {
  file: File;
  uploadId: string | null;
  progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
}

const VM_SIZES: VMSize[] = ['small', 'medium', 'large'];
const WIZARD_STEPS: ProfileWizardStep[] = ['agent', 'work-type', 'vm-size', 'name'];

function getWizardStepNumber(step: ProfileWizardStep, skipAgent: boolean) {
  const visibleSteps: ProfileWizardStep[] = skipAgent ? ['work-type', 'vm-size', 'name'] : WIZARD_STEPS;
  return Math.max(1, visibleSteps.indexOf(step) + 1);
}

function getWizardTotalSteps(skipAgent: boolean) {
  return skipAgent ? 3 : 4;
}

function getAgentInitial(agent: AgentInfo) {
  return (agent.name.trim()[0] ?? agent.id[0] ?? 'A').toUpperCase();
}

function getVmSizeLabel(size: VMSize) {
  return VM_SIZE_LABELS[size]?.label ?? `${size.charAt(0).toUpperCase()}${size.slice(1)}`;
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
  onUpdateProfile: (profileId: string, data: UpdateAgentProfileRequest) => Promise<void>;
  providerCatalogs: ProviderCatalog[];
  projectDefaultProvider?: string | null;
  projectDefaultLocation?: string | null;
  hasUserCloudCredentials: boolean;
  profileWizard: ProfileWizardState;
  onOpenProfileWizard: () => void;
  onCloseProfileWizard: () => void;
  onUpdateProfileWizard: (patch: Partial<ProfileWizardState>) => void;
  onCreateProfileFromWizard: () => Promise<AgentProfile | null>;
  suggestProfileName: (agentType: string | null, workType: TaskMode | null) => string;
  slashCommands?: SlashCommand[];
  attachments?: ChatAttachmentDisplay[];
  onFilesSelected?: (files: FileList | null) => void;
  onRemoveAttachment?: (index: number) => void;
  fileInputRef?: MutableRefObject<HTMLInputElement | null>;
  uploading?: boolean;
}>;

function getComposerPlaceholder({
  noAgents,
  needsProfileBeforeSubmit,
  wizardOpen,
  placeholder,
}: Readonly<{ noAgents: boolean; needsProfileBeforeSubmit: boolean; wizardOpen: boolean; placeholder: string }>) {
  if (noAgents) return 'Add an agent in Settings to start chatting...';
  if (needsProfileBeforeSubmit || wizardOpen) return 'Create a profile to start chatting...';
  return placeholder;
}

function canAdvanceWizard(profileWizard: ProfileWizardState) {
  if (profileWizard.step === 'agent') return Boolean(profileWizard.selectedAgentType);
  if (profileWizard.step === 'work-type') return Boolean(profileWizard.workType);
  if (profileWizard.step === 'vm-size') return Boolean(profileWizard.vmSize);
  return Boolean(profileWizard.profileName.trim());
}

function getProfileButtonClass(selected: boolean) {
  return [
    'min-h-8 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors flex items-center gap-1.5 min-w-0 max-w-full',
    selected
      ? 'border-accent bg-accent/10 text-accent'
      : 'border-border-default bg-transparent text-fg-secondary hover:border-accent/60 hover:text-fg-primary',
  ].join(' ');
}

function getWizardBackLabel(step: ProfileWizardStep, skipAgentStep: boolean) {
  if (step === 'agent') return 'Cancel';
  if (skipAgentStep && step === 'work-type') return 'Cancel';
  return 'Back';
}

function getWizardTitle(step: ProfileWizardStep) {
  const titles: Record<ProfileWizardStep, string> = {
    agent: 'Which agent?',
    'work-type': 'What kind of work?',
    'vm-size': 'VM size',
    name: 'Name the profile',
  };
  return titles[step];
}

function getWizardDescription(step: ProfileWizardStep, providerContext: string) {
  const descriptions: Record<ProfileWizardStep, string> = {
    agent: 'Choose the agent this profile should use.',
    'work-type': 'Pick whether this profile should work independently or stay conversational.',
    'vm-size': providerContext ? `Specs are from ${providerContext}.` : 'Choose a general machine tier.',
    name: 'Use a short name that will be easy to pick later.',
  };
  return descriptions[step];
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
  agentProfiles,
  selectedProfileId,
  onProfileChange,
  onUpdateProfile,
  providerCatalogs,
  projectDefaultProvider,
  projectDefaultLocation,
  hasUserCloudCredentials,
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

  const selectedProfile = selectedProfileId
    ? agentProfiles.find((p) => p.id === selectedProfileId) ?? null
    : null;
  const activeCatalog = selectProviderCatalog(providerCatalogs, projectDefaultProvider);
  const providerContext = formatProviderCatalogContext(activeCatalog, projectDefaultLocation ?? activeCatalog?.defaultLocation ?? null);
  const skipAgentStep = agents.length === 1;
  const needsProfileBeforeSubmit = agentProfiles.length === 0 && agents.length >= 1;
  const noAgents = agents.length === 0;
  const inputDisabled = noAgents || needsProfileBeforeSubmit || profileWizard.open;
  const composerPlaceholder = getComposerPlaceholder({
    noAgents,
    needsProfileBeforeSubmit,
    wizardOpen: profileWizard.open,
    placeholder,
  });
  const canProceed = canAdvanceWizard(profileWizard);

  const selectedWizardAgent = agents.find((agent) => agent.id === profileWizard.selectedAgentType) ?? agents[0] ?? null;
  const selectedWizardSize = profileWizard.vmSize ?? 'medium';
  const stepNumber = getWizardStepNumber(profileWizard.step, skipAgentStep);
  const totalSteps = getWizardTotalSteps(skipAgentStep);

  const updateWizardStep = (step: ProfileWizardStep) => onUpdateProfileWizard({ step });

  const handleWizardNext = () => {
    if (!canProceed || profileWizard.saving) return;
    if (profileWizard.step === 'agent') {
      updateWizardStep('work-type');
      return;
    }
    if (profileWizard.step === 'work-type') {
      updateWizardStep('vm-size');
      return;
    }
    if (profileWizard.step === 'vm-size') {
      onUpdateProfileWizard({
        step: 'name',
        profileName: profileWizard.profileName.trim() || suggestProfileName(profileWizard.selectedAgentType, profileWizard.workType),
      });
      return;
    }
    void onCreateProfileFromWizard();
  };

  const handleWizardBack = () => {
    if (profileWizard.saving) return;
    if (profileWizard.step === 'agent' || (skipAgentStep && profileWizard.step === 'work-type')) {
      onCloseProfileWizard();
      return;
    }
    if (profileWizard.step === 'work-type') updateWizardStep('agent');
    else if (profileWizard.step === 'vm-size') updateWizardStep('work-type');
    else updateWizardStep('vm-size');
  };

  const renderVmSizeDetail = (size: VMSize) => {
    const info = lookupSizeInfo(providerCatalogs, projectDefaultProvider, size);
    if (!info) return 'Exact specs unavailable';
    const specs = `${info.vcpu} vCPU, ${info.ramGb} GB RAM, ${info.storageGb} GB storage`;
    return hasUserCloudCredentials ? `${info.type} · ${specs} · ${info.price}` : `${info.type} · ${specs}`;
  };

  return (
    <div className="relative shrink-0 glass-chrome border-x-0 border-b-0 px-4 py-3 before:content-[''] before:absolute before:top-0 before:left-[15%] before:right-[15%] before:h-px before:bg-[radial-gradient(ellipse_at_center,rgba(34,197,94,0.18)_0%,transparent_70%)] before:pointer-events-none">
      {error && (
        <div className="p-2 px-3 mb-2 rounded-sm bg-danger-tint text-danger text-xs">
          {error}
        </div>
      )}

      {noAgents && <NoAgentsNotice projectId={projectId} />}

      {agentProfiles.length > 0 && !profileWizard.open && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="Agent profiles">
          {agentProfiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              onClick={() => onProfileChange(profile.id)}
              disabled={submitting}
              className={getProfileButtonClass(profile.id === selectedProfileId)}
              aria-pressed={profile.id === selectedProfileId}
              title={profile.name}
            >
              <span className="truncate">{profile.name}</span>
            </button>
          ))}
          {selectedProfile && (
            <button
              type="button"
              onClick={() => setEditProfileOpen(true)}
              disabled={submitting}
              aria-label={`Edit ${selectedProfile.name}`}
              className="min-h-8 min-w-8 rounded-full border border-border-default bg-page text-fg-muted hover:text-fg-primary flex items-center justify-center disabled:opacity-50"
            >
              <Settings size={16} />
            </button>
          )}
          <button
            type="button"
            onClick={onOpenProfileWizard}
            disabled={submitting}
            className="min-h-8 rounded-full border border-dashed border-border-default bg-transparent px-2.5 py-1 text-xs text-fg-muted hover:border-accent/60 hover:text-fg-primary flex items-center gap-1 disabled:opacity-50"
          >
            <Plus size={15} />
            New
          </button>
        </div>
      )}

      {needsProfileBeforeSubmit && !profileWizard.open && (
        <NoProfilesGate onStartWizard={onOpenProfileWizard} />
      )}

      {profileWizard.open && (
        <div className="mb-3 overflow-hidden rounded-lg border border-border-default bg-surface">
          <div className="h-1 bg-border-default">
            <div
              className="h-full bg-accent transition-[width]"
              style={{ width: `${(stepNumber / totalSteps) * 100}%` }}
            />
          </div>
          <div className="p-3 sm:p-4">
            <div className="mb-3">
              <div className="text-[10px] uppercase text-fg-muted">Step {stepNumber} of {totalSteps}</div>
              <h2 className="m-0 mt-1 text-sm font-semibold text-fg-primary">
                {getWizardTitle(profileWizard.step)}
              </h2>
              <p className="m-0 mt-1 text-xs text-fg-muted">
                {getWizardDescription(profileWizard.step, providerContext)}
              </p>
            </div>

            {profileWizard.error && (
              <div role="alert" className="mb-3 rounded-sm bg-danger-tint px-3 py-2 text-xs text-danger">
                {profileWizard.error}
              </div>
            )}

            {profileWizard.step === 'agent' && (
              <div className="grid gap-2">
                {agents.map((agent) => (
                  <SelectionCard
                    key={agent.id}
                    selected={profileWizard.selectedAgentType === agent.id}
                    onClick={() => onUpdateProfileWizard({ selectedAgentType: agent.id })}
                    disabled={profileWizard.saving}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-page text-sm font-semibold text-fg-muted">
                        {getAgentInitial(agent)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-fg-primary">{agent.name}</div>
                        <div className="line-clamp-2 text-xs text-fg-muted">{agent.description || agent.id}</div>
                      </div>
                    </div>
                  </SelectionCard>
                ))}
              </div>
            )}

            {profileWizard.step === 'work-type' && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <WorkTypeCard
                  selected={profileWizard.workType === 'task'}
                  icon={<Wrench size={20} />}
                  title="Build and open PRs"
                  description="Best when you want the agent to make changes, run checks, and carry the task to a pull request."
                  onClick={() => onUpdateProfileWizard({ workType: 'task' })}
                  disabled={profileWizard.saving}
                />
                <WorkTypeCard
                  selected={profileWizard.workType === 'conversation'}
                  icon={<MessageSquare size={20} />}
                  title="Chat and explore"
                  description="Best for questions, planning, code reading, and lighter back-and-forth work."
                  onClick={() => onUpdateProfileWizard({ workType: 'conversation' })}
                  disabled={profileWizard.saving}
                />
              </div>
            )}

            {profileWizard.step === 'vm-size' && (
              <div className="grid gap-2">
                {VM_SIZES.map((size) => (
                  <SelectionCard
                    key={size}
                    selected={selectedWizardSize === size}
                    onClick={() => onUpdateProfileWizard({ vmSize: size })}
                    disabled={profileWizard.saving}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-page text-fg-muted">
                        <Monitor size={17} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg-primary">
                          {getVmSizeLabel(size)}
                          {size === 'medium' && (
                            <span className="rounded-sm bg-accent/10 px-1.5 py-0.5 text-[10px] uppercase text-accent">Recommended</span>
                          )}
                        </div>
                        <div className="text-xs text-fg-muted">{renderVmSizeDetail(size)}</div>
                      </div>
                    </div>
                  </SelectionCard>
                ))}
              </div>
            )}

            {profileWizard.step === 'name' && (
              <div className="grid gap-2">
                <label className="grid gap-1.5">
                  <span className="text-xs text-fg-muted">Profile name</span>
                  <input
                    type="text"
                    value={profileWizard.profileName}
                    onChange={(event) => onUpdateProfileWizard({ profileName: event.target.value })}
                    disabled={profileWizard.saving}
                    className="min-h-[44px] w-full rounded-md border border-border-default bg-page px-3 py-2 text-sm text-fg-primary outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
                    placeholder="e.g. Implementer, Quick Chat, Reviewer"
                  />
                </label>
                <div className="text-xs text-fg-muted">
                  Summary: <strong className="text-fg-secondary">{selectedWizardAgent?.name ?? 'Agent'}</strong> ·{' '}
                  {profileWizard.workType === 'task' ? 'Build and open PRs' : 'Chat and explore'} ·{' '}
                  {getVmSizeLabel(selectedWizardSize)} VM
                </div>
              </div>
            )}

            <div className="mt-4 flex items-center justify-between border-t border-border-default pt-3">
              <button
                type="button"
                onClick={handleWizardBack}
                disabled={profileWizard.saving}
                className="min-h-[44px] rounded-md border border-border-default bg-transparent px-3 py-2 text-sm text-fg-muted hover:text-fg-primary disabled:opacity-50"
              >
                {getWizardBackLabel(profileWizard.step, skipAgentStep)}
              </button>
              <button
                type="button"
                onClick={handleWizardNext}
                disabled={!canProceed || profileWizard.saving}
                className="min-h-[44px] rounded-md border-0 bg-accent px-4 py-2 text-sm font-semibold text-white disabled:bg-inset disabled:text-fg-muted disabled:opacity-70 flex items-center gap-1.5"
              >
                {profileWizard.step === 'name' ? (
                  <>
                    <Check size={15} />
                    {profileWizard.saving ? 'Creating...' : 'Create profile'}
                  </>
                ) : (
                  <>
                    Next
                    <ChevronRight size={15} />
                  </>
                )}
              </button>
            </div>
          </div>
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

function NoAgentsNotice({ projectId }: Readonly<{ projectId: string }>) {
  const navigate = useNavigate();
  return (
    <div className="mb-2 flex flex-col gap-3 rounded-md border border-border-default bg-surface px-3 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg-primary">Add an agent to start chatting</div>
        <div className="mt-1 text-xs text-fg-muted">Connect or enable an ACP-capable agent in project settings.</div>
      </div>
      <button
        type="button"
        onClick={() => navigate(`/projects/${projectId}/settings`)}
        className="min-h-[44px] rounded-md border border-border-default bg-page px-3 py-2 text-sm text-fg-primary hover:border-accent/60"
      >
        Settings &gt; Agents
      </button>
    </div>
  );
}

function NoProfilesGate({ onStartWizard }: Readonly<{ onStartWizard: () => void }>) {
  return (
    <div className="mb-3 flex flex-col gap-3 rounded-lg border border-accent/20 bg-accent/5 p-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg-primary">Create a profile to start</div>
        <div className="mt-1 text-xs text-fg-muted">Choose an agent and default runtime settings for this project chat.</div>
      </div>
      <button
        type="button"
        onClick={onStartWizard}
        className="min-h-[44px] rounded-md border-0 bg-accent px-4 py-2 text-sm font-semibold text-white flex items-center justify-center gap-1.5"
      >
        Create profile
        <ChevronRight size={15} />
      </button>
    </div>
  );
}

function SelectionCard({
  selected,
  disabled,
  onClick,
  children,
}: Readonly<{
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`min-h-[56px] w-full rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
        selected ? 'border-accent bg-accent/10' : 'border-border-default bg-page hover:border-accent/60'
      }`}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">{children}</div>
        {selected && <Check size={16} className="shrink-0 text-accent" />}
      </div>
    </button>
  );
}

function WorkTypeCard({
  icon,
  title,
  description,
  selected,
  disabled,
  onClick,
}: Readonly<{
  icon: ReactNode;
  title: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`min-h-[132px] rounded-md border p-3 text-left transition-colors disabled:opacity-50 ${
        selected ? 'border-accent bg-accent/10' : 'border-border-default bg-page hover:border-accent/60'
      }`}
    >
      <div className="mb-2 text-fg-muted">{icon}</div>
      <div className="text-sm font-semibold text-fg-primary">{title}</div>
      <div className="mt-1 text-xs leading-5 text-fg-muted">{description}</div>
    </button>
  );
}
