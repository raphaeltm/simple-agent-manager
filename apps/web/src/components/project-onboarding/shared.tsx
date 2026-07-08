import type {
  AgentInfo,
  CreateAgentProfileRequest,
  GitHubCliPolicy,
} from '@simple-agent-manager/shared';
import { Input } from '@simple-agent-manager/ui';

import { ApiClientError } from '../../lib/api';
import { ModelSelect } from '../ModelSelect';

/* ───────── Types ───────── */

export type SetupStatus = 'pending' | 'done' | 'skipped';
export type FieldErrors = Partial<
  Record<'name' | 'repository' | 'githubRepoId' | 'gitlabProjectId' | 'general', string>
>;

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
  if (error.message.includes('GitLab')) {
    return { gitlabProjectId: error.message };
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
  return (
    error.message.toLowerCase().includes('approved') ||
    error.message.toLowerCase().includes('pending')
  );
}

export function profilePayload(
  draft: ProfileDraft,
  taskMode: 'conversation' | 'task'
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

export function ModeButton({
  selected,
  title,
  description,
  onClick,
}: Readonly<{
  selected: boolean;
  title: string;
  description: string;
  onClick: () => void;
}>) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
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

/**
 * The profile form fields for a setup step. Buttons live in the wizard footer
 * (Skip / Create), so this panel always shows its fields and never collapses.
 */
export function ProfileSetupPanel({
  title,
  draft,
  configuredAgents,
  disabled,
  onChange,
}: {
  title: string;
  draft: ProfileDraft;
  configuredAgents: AgentInfo[];
  disabled: boolean;
  onChange: (next: ProfileDraft) => void;
}) {
  const fieldPrefix = title.toLowerCase().replace(/\s+/g, '-');

  return (
    <section className="grid gap-3 rounded-md border border-border-default bg-surface p-4">
      <h3 className="text-sm font-semibold text-fg-primary">{title}</h3>
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
            onChange={(event) =>
              onChange({ ...draft, agentType: event.currentTarget.value, model: '' })
            }
            disabled={disabled || configuredAgents.length === 0}
            className="min-h-11 w-full rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
          >
            {configuredAgents.length === 0 ? (
              <option value="">No configured agents</option>
            ) : (
              configuredAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
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
          onChange={(event) =>
            onChange({ ...draft, useCustomGithubPolicy: event.currentTarget.checked })
          }
          disabled={disabled}
          className="mt-1"
        />
        <span>Use a custom GitHub CLI policy for this project repository.</span>
      </label>
    </section>
  );
}
