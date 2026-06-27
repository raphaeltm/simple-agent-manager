import type {
  AgentInfo,
  CreateAgentProfileRequest,
  GitHubCliPolicy,
} from '@simple-agent-manager/shared';
import { Button, Input } from '@simple-agent-manager/ui';
import { Check } from 'lucide-react';

import { ApiClientError } from '../../lib/api';
import { ModelSelect } from '../ModelSelect';

/* ───────── Types ───────── */

export type WizardStep = 'connect' | 'setup' | 'kickoff';
export type SetupStatus = 'pending' | 'done' | 'skipped';
export type FieldErrors = Partial<Record<'name' | 'repository' | 'githubRepoId' | 'general', string>>;

export interface ProfileDraft {
  name: string;
  description: string;
  agentType: string;
  model: string;
  useCustomGithubPolicy: boolean;
}

export interface CreatedProfiles {
  conversation?: { id: string };
  task?: { id: string };
}

/* ───────── Constants ───────── */

const CUSTOM_GITHUB_CLI_POLICY: GitHubCliPolicy = {
  mode: 'custom',
  repositoryScope: 'project',
  permissions: {
    contents: 'write',
    pullRequests: 'write',
    issues: 'write',
    actions: 'read',
    packages: 'read',
  },
};

/* ───────── Helpers ───────── */

export function normalizeRepository(value: string): string {
  let repository = value.trim();
  if (repository.startsWith('https://github.com/')) {
    repository = repository.replace('https://github.com/', '');
  } else if (repository.startsWith('git@github.com:')) {
    repository = repository.replace('git@github.com:', '');
  }
  return repository.replace(/\.git$/, '').toLowerCase();
}

export function deriveProjectName(repository: string): string {
  const normalized = normalizeRepository(repository);
  const [, repoName] = normalized.split('/');
  return repoName || normalized || '';
}

export function mapProjectCreateError(error: unknown): FieldErrors {
  if (!(error instanceof ApiClientError) || error.status !== 409) {
    return { general: error instanceof Error ? error.message : 'Failed to create project' };
  }
  if (error.message.includes('Project name')) {
    return { name: 'A project with this name already exists.' };
  }
  if (error.message.includes('repository ID')) {
    return { githubRepoId: 'This GitHub repository is already linked to another project.' };
  }
  if (error.message.includes('repository')) {
    return { repository: 'This repository is already linked to another project.' };
  }
  return { general: error.message };
}

export function isCredentialError(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 403;
}

export function isNotApprovedError(error: unknown): boolean {
  if (!(error instanceof ApiClientError) || error.status !== 403) return false;
  return error.message.toLowerCase().includes('approved') || error.message.toLowerCase().includes('pending');
}

export function profilePayload(
  draft: ProfileDraft,
  taskMode: 'conversation' | 'task',
): CreateAgentProfileRequest {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    agentType: draft.agentType,
    model: draft.model.trim() || null,
    taskMode,
    ...(draft.useCustomGithubPolicy ? { githubCliPolicy: CUSTOM_GITHUB_CLI_POLICY } : {}),
  };
}

/* ───────── Shared UI Components ───────── */

export function StepIndicator({ current }: { current: WizardStep }) {
  const steps: Array<{ id: WizardStep; label: string }> = [
    { id: 'connect', label: 'Connect code' },
    { id: 'setup', label: 'Set up' },
    { id: 'kickoff', label: 'Kick off' },
  ];
  const currentIndex = steps.findIndex((step) => step.id === current);

  return (
    <ol className="grid gap-2 sm:grid-cols-3" aria-label="Project onboarding steps">
      {steps.map((step, index) => {
        const state = index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'upcoming';
        return (
          <li
            key={step.id}
            className={`flex min-h-11 items-center gap-2 rounded-md border px-3 py-2 text-sm ${
              state === 'current'
                ? 'border-accent bg-accent/10 text-fg-primary'
                : state === 'complete'
                  ? 'border-success/40 bg-success-tint text-fg-primary'
                  : 'border-border-default bg-surface text-fg-muted'
            }`}
            aria-current={state === 'current' ? 'step' : undefined}
            aria-label={state === 'complete' ? `${step.label} — complete` : undefined}
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-current text-xs">
              {state === 'complete' ? <Check size={14} aria-hidden="true" /> : index + 1}
            </span>
            <span className="truncate">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function SetupHeader({ title, status }: { title: string; status: SetupStatus }) {
  const label = status === 'pending' ? 'Optional' : status === 'done' ? 'Created' : 'Skipped';
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-fg-primary">{title}</h3>
      <span className="rounded-md border border-border-default px-2 py-1 text-xs text-fg-muted">{label}</span>
    </div>
  );
}

export function ModeButton({
  selected,
  title,
  description,
  onClick,
}: {
  selected: boolean;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`min-h-[56px] rounded-md border px-3 py-2 text-left transition-colors ${
        selected
          ? 'border-accent bg-accent/10 text-fg-primary'
          : 'border-border-default bg-transparent text-fg-muted hover:bg-surface-hover'
      }`}
    >
      <span className="block text-sm font-semibold">{title}</span>
      <span className="block text-xs">{description}</span>
    </button>
  );
}

export function ProfileSetupPanel({
  title,
  status,
  draft,
  configuredAgents,
  disabled,
  saving,
  onChange,
  onSave,
  onSkip,
}: {
  title: string;
  status: SetupStatus;
  draft: ProfileDraft;
  configuredAgents: AgentInfo[];
  disabled: boolean;
  saving: boolean;
  onChange: (next: ProfileDraft) => void;
  onSave: () => void;
  onSkip: () => void;
}) {
  const fieldPrefix = title.toLowerCase().replace(/\s+/g, '-');

  return (
    <section className="grid gap-3 rounded-md border border-border-default bg-surface p-4">
      <SetupHeader title={title} status={status} />
      {status === 'pending' && (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <label htmlFor={`${fieldPrefix}-profile-name`} className="grid gap-1.5">
              <span className="text-sm text-fg-muted">Name</span>
              <Input
                id={`${fieldPrefix}-profile-name`}
                value={draft.name}
                onChange={(event) => onChange({ ...draft, name: event.currentTarget.value })}
                disabled={disabled}
              />
            </label>
            <label htmlFor={`${fieldPrefix}-profile-agent`} className="grid gap-1.5">
              <span className="text-sm text-fg-muted">Agent</span>
              <select
                id={`${fieldPrefix}-profile-agent`}
                value={draft.agentType}
                onChange={(event) => onChange({ ...draft, agentType: event.currentTarget.value, model: '' })}
                disabled={disabled || configuredAgents.length === 0}
                className="min-h-11 w-full rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
              >
                {configuredAgents.length === 0 ? (
                  <option value="">No configured agents</option>
                ) : (
                  configuredAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                  ))
                )}
              </select>
            </label>
          </div>
          <label htmlFor={`${fieldPrefix}-profile-model`} className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Model override</span>
            <ModelSelect
              id={`${fieldPrefix}-profile-model`}
              agentType={draft.agentType}
              value={draft.model}
              onChange={(model) => onChange({ ...draft, model })}
              disabled={disabled || !draft.agentType}
              placeholder="Use profile default"
            />
          </label>
          <label className="flex min-h-11 items-start gap-2 rounded-md border border-border-default p-3 text-sm text-fg-muted">
            <input
              type="checkbox"
              checked={draft.useCustomGithubPolicy}
              onChange={(event) => onChange({ ...draft, useCustomGithubPolicy: event.currentTarget.checked })}
              disabled={disabled}
              className="mt-1"
            />
            <span>Use a custom GitHub CLI policy for this project repository.</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={onSave} disabled={disabled || configuredAgents.length === 0}>
              {saving ? 'Creating...' : 'Create profile'}
            </Button>
            <Button type="button" variant="secondary" onClick={onSkip} disabled={disabled}>
              Skip profile
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
