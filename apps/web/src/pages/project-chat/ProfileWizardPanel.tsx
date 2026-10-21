import type { AgentInfo, AgentProfileRuntime, TaskMode } from '@simple-agent-manager/shared';
import { Check, ChevronRight, MessageSquare, Server, Wrench, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';

import {
  EMPTY_RESOURCE_STATE,
  hasValidationErrors,
  type ResourceRequirementsFormState,
  ResourceRequirementsInput,
  validateResourceState,
} from '../../components/resource-requirements';
import type { ProfileWizardState, ProfileWizardStep } from './useProfileChoice';

const WIZARD_STEPS: ProfileWizardStep[] = ['agent', 'work-type', 'runtime', 'resources', 'name'];

function getWizardSteps(skipAgent: boolean, runtime: AgentProfileRuntime | null) {
  return WIZARD_STEPS.filter((step) => {
    if (skipAgent && step === 'agent') return false;
    if (runtime === 'cf-container' && step === 'resources') return false;
    return true;
  });
}

function getWizardStepNumber(step: ProfileWizardStep, visibleSteps: ProfileWizardStep[]) {
  return Math.max(1, visibleSteps.indexOf(step) + 1);
}

function getWizardNextStep(step: ProfileWizardStep, visibleSteps: ProfileWizardStep[]) {
  const index = visibleSteps.indexOf(step);
  if (index < 0 || index >= visibleSteps.length - 1) return null;
  return visibleSteps[index + 1] ?? null;
}

function getWizardPreviousStep(step: ProfileWizardStep, visibleSteps: ProfileWizardStep[]) {
  const index = visibleSteps.indexOf(step);
  if (index <= 0) return null;
  return visibleSteps[index - 1] ?? null;
}

function getAgentInitial(agent: AgentInfo) {
  return (agent.name.trim()[0] ?? agent.id[0] ?? 'A').toUpperCase();
}

function getRuntimeSummary(runtime: AgentProfileRuntime | null) {
  if (runtime === 'cf-container') return 'Instant container';
  if (runtime === 'vm') return 'Cloud VM';
  return 'Auto runtime';
}

function canAdvanceWizard(profileWizard: ProfileWizardState) {
  if (profileWizard.step === 'agent') return Boolean(profileWizard.selectedAgentType);
  if (profileWizard.step === 'work-type') return Boolean(profileWizard.workType);
  if (profileWizard.step === 'runtime') return Boolean(profileWizard.runtime);
  if (profileWizard.step === 'resources') {
    return !hasValidationErrors(validateResourceState(profileWizard.resourceReqs));
  }
  return Boolean(profileWizard.profileName.trim());
}

function getWizardBackLabel(step: ProfileWizardStep, visibleSteps: ProfileWizardStep[]) {
  return getWizardPreviousStep(step, visibleSteps) ? 'Back' : 'Cancel';
}

function getWizardTitle(step: ProfileWizardStep) {
  const titles: Record<ProfileWizardStep, string> = {
    agent: 'Which agent?',
    'work-type': 'What kind of work?',
    runtime: 'Where should it run?',
    resources: 'Resources',
    name: 'Name the profile',
  };
  return titles[step];
}

function getWizardDescription(step: ProfileWizardStep) {
  const descriptions: Record<ProfileWizardStep, string> = {
    agent: 'Choose the agent this profile should use.',
    'work-type': 'Pick whether this profile should work independently or stay conversational.',
    runtime: 'Choose Instant for quick chat, or Cloud VM for heavier work.',
    resources: 'Set minimum resource requirements, or leave blank for defaults.',
    name: 'Use a short name that will be easy to pick later.',
  };
  return descriptions[step];
}

/** The inline "create your first profile" wizard shown in the new-chat composer. */
export function ProfileWizardPanel({
  agents,
  profileWizard,
  onCloseProfileWizard,
  onUpdateProfileWizard,
  onCreateProfileFromWizard,
  suggestProfileName,
}: Readonly<{
  agents: AgentInfo[];
  profileWizard: ProfileWizardState;
  onCloseProfileWizard: () => void;
  onUpdateProfileWizard: (patch: Partial<ProfileWizardState>) => void;
  onCreateProfileFromWizard: () => Promise<unknown>;
  suggestProfileName: (agentType: string | null, workType: TaskMode | null) => string;
}>) {
  const skipAgentStep = agents.length === 1;
  const canProceed = canAdvanceWizard(profileWizard);
  const selectedWizardAgent =
    agents.find((agent) => agent.id === profileWizard.selectedAgentType) ?? agents[0] ?? null;
  const visibleWizardSteps = getWizardSteps(skipAgentStep, profileWizard.runtime);
  const stepNumber = getWizardStepNumber(profileWizard.step, visibleWizardSteps);
  const totalSteps = visibleWizardSteps.length;

  const updateWizardStep = (step: ProfileWizardStep) => onUpdateProfileWizard({ step });

  const handleWizardNext = () => {
    if (!canProceed || profileWizard.saving) return;
    const nextStep = getWizardNextStep(profileWizard.step, visibleWizardSteps);
    if (!nextStep) {
      void onCreateProfileFromWizard();
      return;
    }
    if (nextStep === 'name') {
      onUpdateProfileWizard({
        step: 'name',
        profileName:
          profileWizard.profileName.trim() ||
          suggestProfileName(profileWizard.selectedAgentType, profileWizard.workType),
      });
      return;
    }
    updateWizardStep(nextStep);
  };

  const handleWizardBack = () => {
    if (profileWizard.saving) return;
    const previousStep = getWizardPreviousStep(profileWizard.step, visibleWizardSteps);
    if (!previousStep) {
      onCloseProfileWizard();
      return;
    }
    updateWizardStep(previousStep);
  };

  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-border-default bg-surface">
      <div className="h-1 bg-border-default">
        <div
          className="h-full bg-accent transition-[width]"
          style={{ width: `${(stepNumber / totalSteps) * 100}%` }}
        />
      </div>
      <div className="p-3 sm:p-4">
        <div className="mb-3">
          <div className="text-[10px] uppercase text-fg-muted">
            Step {stepNumber} of {totalSteps}
          </div>
          <h2 className="m-0 mt-1 text-sm font-semibold text-fg-primary">
            {getWizardTitle(profileWizard.step)}
          </h2>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            {getWizardDescription(profileWizard.step)}
          </p>
        </div>

        {profileWizard.error && (
          <div
            role="alert"
            className="mb-3 rounded-sm bg-danger-tint px-3 py-2 text-xs text-danger"
          >
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
                    <div className="truncate text-sm font-semibold text-fg-primary">
                      {agent.name}
                    </div>
                    <div className="line-clamp-2 text-xs text-fg-muted">
                      {agent.description || agent.id}
                    </div>
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
              onClick={() => onUpdateProfileWizard({ workType: 'task', runtime: null })}
              disabled={profileWizard.saving}
            />
            <WorkTypeCard
              selected={profileWizard.workType === 'conversation'}
              icon={<MessageSquare size={20} />}
              title="Chat and explore"
              description="Best for questions, planning, code reading, and lighter back-and-forth work."
              onClick={() => onUpdateProfileWizard({ workType: 'conversation', runtime: null })}
              disabled={profileWizard.saving}
            />
          </div>
        )}

        {profileWizard.step === 'runtime' && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <WorkTypeCard
              selected={profileWizard.runtime === 'cf-container'}
              icon={<Zap size={20} />}
              title="Instant container"
              description="Starts a chat workspace in a Cloudflare Container without a VM provisioning step."
              onClick={() =>
                onUpdateProfileWizard({
                  runtime: 'cf-container',
                  resourceReqs: { ...EMPTY_RESOURCE_STATE },
                  workType: 'conversation',
                })
              }
              disabled={profileWizard.saving}
            />
            <WorkTypeCard
              selected={profileWizard.runtime === 'vm'}
              icon={<Server size={20} />}
              title="Cloud VM"
              description="Uses the project's cloud provisioning path for larger or longer-running work."
              onClick={() => onUpdateProfileWizard({ runtime: 'vm' })}
              disabled={profileWizard.saving}
            />
          </div>
        )}

        {profileWizard.step === 'resources' && (
          <div className="rounded-md border border-border-default bg-surface p-3">
            <ResourceRequirementsInput
              value={profileWizard.resourceReqs}
              onChange={(next: ResourceRequirementsFormState) =>
                onUpdateProfileWizard({ resourceReqs: next })
              }
              disabled={profileWizard.saving}
              inheritLabel="platform default"
              hideDisk
              errors={validateResourceState(profileWizard.resourceReqs)}
            />
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
              Summary:{' '}
              <strong className="text-fg-secondary">{selectedWizardAgent?.name ?? 'Agent'}</strong>{' '}
              · {profileWizard.workType === 'task' ? 'Build and open PRs' : 'Chat and explore'} ·{' '}
              {getRuntimeSummary(profileWizard.runtime)}
              {profileWizard.runtime !== 'cf-container' && profileWizard.resourceReqs.minVcpu && (
                <> · {profileWizard.resourceReqs.minVcpu} vCPU</>
              )}
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
            {getWizardBackLabel(profileWizard.step, visibleWizardSteps)}
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
  );
}

export function NoAgentsNotice({ projectId }: Readonly<{ projectId: string }>) {
  const navigate = useNavigate();
  return (
    <div className="mb-2 flex flex-col gap-3 rounded-md border border-border-default bg-surface px-3 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg-primary">Add an agent to start chatting</div>
        <div className="mt-1 text-xs text-fg-muted">
          Connect or enable an ACP-capable agent in project settings.
        </div>
      </div>
      <button
        type="button"
        onClick={() => navigate(`/projects/${projectId}/settings/agents`)}
        className="min-h-[44px] rounded-md border border-border-default bg-page px-3 py-2 text-sm text-fg-primary hover:border-accent/60"
      >
        Settings &gt; Agents
      </button>
    </div>
  );
}

export function NoProfilesGate({ onStartWizard }: Readonly<{ onStartWizard: () => void }>) {
  return (
    <div className="mb-3 flex flex-col gap-3 rounded-lg border border-accent/20 bg-accent/5 p-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg-primary">Create a profile to start</div>
        <div className="mt-1 text-xs text-fg-muted">
          Choose an agent and default runtime settings for this project chat.
        </div>
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
        selected
          ? 'border-accent bg-accent/10'
          : 'border-border-default bg-page hover:border-accent/60'
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
        selected
          ? 'border-accent bg-accent/10'
          : 'border-border-default bg-page hover:border-accent/60'
      }`}
    >
      <div className="mb-2 text-fg-muted">{icon}</div>
      <div className="text-sm font-semibold text-fg-primary">{title}</div>
      <div className="mt-1 text-xs leading-5 text-fg-muted">{description}</div>
    </button>
  );
}
