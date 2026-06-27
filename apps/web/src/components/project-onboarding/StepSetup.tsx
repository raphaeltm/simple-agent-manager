import type { AgentInfo, Project } from '@simple-agent-manager/shared';
import { Alert, Button, Input } from '@simple-agent-manager/ui';
import { ChevronRight } from 'lucide-react';

import {
  type CreatedProfiles,
  type ProfileDraft,
  ProfileSetupPanel,
  SetupHeader,
  type SetupStatus,
} from './shared';

interface TriggerFormState {
  name: string;
  description: string;
  cronExpression: string;
  cronTimezone: string;
  promptTemplate: string;
}

interface StepSetupProps {
  project: Project;
  configuredAgents: AgentInfo[];
  agentsLoading: boolean;
  agentsError: string | null;
  conversationProfile: ProfileDraft;
  taskProfile: ProfileDraft;
  triggerForm: TriggerFormState;
  conversationStatus: SetupStatus;
  taskStatus: SetupStatus;
  triggerStatus: SetupStatus;
  setupError: string | null;
  triggerError: string | null;
  savingSetup: string | null;
  createdProfiles: CreatedProfiles;
  canContinueFromSetup: boolean;
  onRefreshAgents: () => void;
  onConversationProfileChange: (draft: ProfileDraft) => void;
  onTaskProfileChange: (draft: ProfileDraft) => void;
  onTriggerFormChange: (form: TriggerFormState) => void;
  onSaveProfile: (kind: 'conversation' | 'task') => void;
  onSkipProfile: (kind: 'conversation' | 'task') => void;
  onSaveTrigger: () => void;
  onSkipTrigger: () => void;
  onContinue: () => void;
  onOpenProject: () => void;
}

export function StepSetup({
  project,
  configuredAgents,
  agentsLoading,
  agentsError,
  conversationProfile,
  taskProfile,
  triggerForm,
  conversationStatus,
  taskStatus,
  triggerStatus,
  setupError,
  triggerError,
  savingSetup,
  canContinueFromSetup,
  onRefreshAgents,
  onConversationProfileChange,
  onTaskProfileChange,
  onTriggerFormChange,
  onSaveProfile,
  onSkipProfile,
  onSaveTrigger,
  onSkipTrigger,
  onContinue,
  onOpenProject,
}: StepSetupProps) {
  return (
    <div className="grid gap-4">
      <div className="rounded-md border border-border-default bg-surface p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="grid gap-1">
            <h2 className="text-base font-semibold text-fg-primary">Set up {project.name}</h2>
            <p className="text-sm text-fg-muted">
              Add optional profiles and a cron trigger. Each item can be skipped.
            </p>
          </div>
          <Button type="button" variant="secondary" onClick={onRefreshAgents} disabled={agentsLoading}>
            {agentsLoading ? 'Refreshing...' : 'Refresh agents'}
          </Button>
        </div>
        {agentsError && <div className="mt-3"><Alert variant="error">{agentsError}</Alert></div>}
        {!agentsLoading && configuredAgents.length === 0 && (
          <div className="mt-3">
            <Alert variant="warning">No configured agents are available. You can skip profile setup and add profiles later.</Alert>
          </div>
        )}
      </div>

      <ProfileSetupPanel
        title="Conversation profile"
        status={conversationStatus}
        draft={conversationProfile}
        configuredAgents={configuredAgents}
        disabled={agentsLoading || savingSetup !== null || conversationStatus !== 'pending'}
        saving={savingSetup === 'conversation'}
        onChange={onConversationProfileChange}
        onSave={() => onSaveProfile('conversation')}
        onSkip={() => onSkipProfile('conversation')}
      />
      <ProfileSetupPanel
        title="Task profile"
        status={taskStatus}
        draft={taskProfile}
        configuredAgents={configuredAgents}
        disabled={agentsLoading || savingSetup !== null || taskStatus !== 'pending'}
        saving={savingSetup === 'task'}
        onChange={onTaskProfileChange}
        onSave={() => onSaveProfile('task')}
        onSkip={() => onSkipProfile('task')}
      />

      <section className="grid gap-3 rounded-md border border-border-default bg-surface p-4">
        <SetupHeader title="Cron trigger" status={triggerStatus} />
        {triggerStatus === 'pending' && (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <label htmlFor="project-onboarding-trigger-name" className="grid gap-1.5">
                <span className="text-sm text-fg-muted">Name</span>
                <Input
                  id="project-onboarding-trigger-name"
                  value={triggerForm.name}
                  onChange={(event) => onTriggerFormChange({ ...triggerForm, name: event.currentTarget.value })}
                  disabled={savingSetup !== null}
                />
              </label>
              <label htmlFor="project-onboarding-trigger-schedule" className="grid gap-1.5">
                <span className="text-sm text-fg-muted">Schedule</span>
                <Input
                  id="project-onboarding-trigger-schedule"
                  value={triggerForm.cronExpression}
                  onChange={(event) => onTriggerFormChange({ ...triggerForm, cronExpression: event.currentTarget.value })}
                  disabled={savingSetup !== null}
                  placeholder="0 9 * * *"
                />
              </label>
            </div>
            <label htmlFor="project-onboarding-trigger-prompt" className="grid gap-1.5">
              <span className="text-sm text-fg-muted">Prompt</span>
              <textarea
                id="project-onboarding-trigger-prompt"
                value={triggerForm.promptTemplate}
                onChange={(event) => onTriggerFormChange({ ...triggerForm, promptTemplate: event.currentTarget.value })}
                rows={4}
                disabled={savingSetup !== null}
                className="w-full resize-y rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
              />
            </label>
            {triggerError && <Alert variant="error">{triggerError}</Alert>}
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={onSaveTrigger} disabled={savingSetup !== null}>
                {savingSetup === 'trigger' ? 'Creating...' : 'Create trigger'}
              </Button>
              <Button type="button" variant="secondary" onClick={onSkipTrigger} disabled={savingSetup !== null}>
                Skip trigger
              </Button>
            </div>
          </>
        )}
      </section>

      {setupError && <Alert variant="error">{setupError}</Alert>}

      {!canContinueFromSetup && (
        <p className="text-sm text-fg-muted">Create or skip each item above to continue.</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onContinue} disabled={!canContinueFromSetup}>
          Continue <ChevronRight size={16} aria-hidden="true" />
        </Button>
        <Button type="button" variant="secondary" onClick={onOpenProject}>
          Open project
        </Button>
      </div>
    </div>
  );
}
