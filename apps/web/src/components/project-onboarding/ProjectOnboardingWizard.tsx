import type {
  AgentInfo,
  AgentProfile,
  CreateAgentProfileRequest,
  GitHubCliPolicy,
  GitHubInstallation,
  Project,
} from '@simple-agent-manager/shared';
import { Alert, Button, Input, Skeleton } from '@simple-agent-manager/ui';
import { Check, ChevronRight } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import {
  ApiClientError,
  createAgentProfile,
  createProject,
  createTrigger,
  listAgents,
  listBranches,
  submitTask,
} from '../../lib/api';
import { BranchSelector } from '../BranchSelector';
import { ModelSelect } from '../ModelSelect';
import { RepoSelector } from '../RepoSelector';

type WizardStep = 'connect' | 'setup' | 'kickoff';
type SetupStatus = 'pending' | 'done' | 'skipped';
type FieldErrors = Partial<Record<'name' | 'repository' | 'githubRepoId' | 'general', string>>;

interface ProjectOnboardingWizardProps {
  installations: GitHubInstallation[];
  loading?: boolean;
  loadError?: string | null;
  onRetryInstallations?: () => void;
}

interface ProfileDraft {
  name: string;
  description: string;
  agentType: string;
  model: string;
  useCustomGithubPolicy: boolean;
}

interface CreatedProfiles {
  conversation?: AgentProfile;
  task?: AgentProfile;
}

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

function normalizeRepository(value: string): string {
  let repository = value.trim();
  if (repository.startsWith('https://github.com/')) {
    repository = repository.replace('https://github.com/', '');
  } else if (repository.startsWith('git@github.com:')) {
    repository = repository.replace('git@github.com:', '');
  }
  return repository.replace(/\.git$/, '').toLowerCase();
}

function deriveProjectName(repository: string): string {
  const normalized = normalizeRepository(repository);
  const [, repoName] = normalized.split('/');
  return repoName || normalized || '';
}

function mapProjectCreateError(error: unknown): FieldErrors {
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

function isCredentialError(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 403;
}

function profilePayload(
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

function StepIndicator({ current }: { current: WizardStep }) {
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

export function ProjectOnboardingWizard({
  installations,
  loading = false,
  loadError,
  onRetryInstallations,
}: ProjectOnboardingWizardProps) {
  const navigate = useNavigate();
  const [step, setStep] = useState<WizardStep>('connect');
  const [project, setProject] = useState<Project | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);

  const defaultInstallationId = installations[0]?.id ?? '';
  const [projectNameTouched, setProjectNameTouched] = useState(false);
  const [projectForm, setProjectForm] = useState({
    name: '',
    description: '',
    installationId: defaultInstallationId,
    repository: '',
    defaultBranch: 'main',
    githubRepoId: undefined as number | undefined,
  });
  const [branches, setBranches] = useState<Array<{ name: string }>>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [repoDefaultBranch, setRepoDefaultBranch] = useState<string | undefined>(undefined);

  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [configuredAgents, setConfiguredAgents] = useState<AgentInfo[]>([]);
  const [createdProfiles, setCreatedProfiles] = useState<CreatedProfiles>({});
  const [conversationStatus, setConversationStatus] = useState<SetupStatus>('pending');
  const [taskStatus, setTaskStatus] = useState<SetupStatus>('pending');
  const [triggerStatus, setTriggerStatus] = useState<SetupStatus>('pending');
  const [setupError, setSetupError] = useState<string | null>(null);
  const [savingSetup, setSavingSetup] = useState<string | null>(null);

  const [conversationProfile, setConversationProfile] = useState<ProfileDraft>({
    name: 'Conversation profile',
    description: 'Default profile for project conversations',
    agentType: '',
    model: '',
    useCustomGithubPolicy: false,
  });
  const [taskProfile, setTaskProfile] = useState<ProfileDraft>({
    name: 'Task profile',
    description: 'Default profile for project tasks',
    agentType: '',
    model: '',
    useCustomGithubPolicy: false,
  });
  const [triggerForm, setTriggerForm] = useState({
    name: 'Daily project check-in',
    description: '',
    cronExpression: '0 9 * * *',
    cronTimezone: 'UTC',
    promptTemplate: 'Review recent project activity and suggest the next useful task.',
  });
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const [kickoffMode, setKickoffMode] = useState<'task' | 'conversation'>('task');
  const [kickoffMessage, setKickoffMessage] = useState('Review this repository and suggest the highest-impact next steps.');
  const [kickoffError, setKickoffError] = useState<string | null>(null);
  const [kickoffSubmitting, setKickoffSubmitting] = useState(false);

  useEffect(() => {
    setProjectForm((current) => (
      current.installationId ? current : { ...current, installationId: defaultInstallationId }
    ));
  }, [defaultInstallationId]);

  const fetchBranches = useCallback(async (repository: string, installationId: string, defaultBranch?: string) => {
    setBranchesLoading(true);
    setBranches([]);
    setBranchesError(null);
    try {
      const result = await listBranches(repository, installationId || undefined, defaultBranch);
      setBranches(result.length > 0 ? result : [{ name: 'main' }, { name: 'master' }]);
      if (result.length === 0) {
        setBranchesError('No branches returned. Common branch names are available.');
      }
    } catch {
      setBranches([{ name: 'main' }, { name: 'master' }, { name: 'develop' }]);
      setBranchesError('Unable to fetch branches. Common branch names are available.');
    } finally {
      setBranchesLoading(false);
    }
  }, []);

  const handleRepositoryChange = (value: string) => {
    setProjectForm((current) => ({ ...current, repository: value, githubRepoId: undefined }));
    setBranches([]);
    setBranchesError(null);
    setFieldErrors((current) => ({ ...current, repository: undefined, githubRepoId: undefined }));
  };

  const handleRepoSelect = useCallback(
    (repo: { fullName: string; defaultBranch: string; githubRepoId?: number } | null) => {
      if (!repo) return;
      const nextName = deriveProjectName(repo.fullName);
      setRepoDefaultBranch(repo.defaultBranch);
      setProjectForm((current) => ({
        ...current,
        name: projectNameTouched || current.name.trim() ? current.name : nextName,
        repository: repo.fullName,
        defaultBranch: repo.defaultBranch,
        githubRepoId: repo.githubRepoId,
      }));
      void fetchBranches(repo.fullName, projectForm.installationId, repo.defaultBranch);
    },
    [fetchBranches, projectForm.installationId, projectNameTouched],
  );

  const handleInstallationChange = (installationId: string) => {
    setProjectForm((current) => ({
      ...current,
      installationId,
      repository: '',
      defaultBranch: 'main',
      githubRepoId: undefined,
    }));
    setBranches([]);
    setBranchesError(null);
    setRepoDefaultBranch(undefined);
    setFieldErrors({});
  };

  const loadAgents = useCallback(async () => {
    setAgentsLoading(true);
    setAgentsError(null);
    try {
      const response = await listAgents();
      const agents = response.agents.filter((agent) => agent.configured);
      setConfiguredAgents(agents);
      const firstAgent = agents[0]?.id ?? '';
      setConversationProfile((current) => ({ ...current, agentType: current.agentType || firstAgent }));
      setTaskProfile((current) => ({ ...current, agentType: current.agentType || firstAgent }));
    } catch (error) {
      setAgentsError(error instanceof Error ? error.message : 'Failed to load configured agents');
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  const handleCreateProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);
    setFieldErrors({});

    const repository = normalizeRepository(projectForm.repository);
    if (!projectForm.name.trim()) {
      setFieldErrors({ name: 'Project name is required.' });
      return;
    }
    if (!projectForm.installationId.trim()) {
      setFieldErrors({ general: 'Select a GitHub installation.' });
      return;
    }
    if (!repository) {
      setFieldErrors({ repository: 'Repository is required.' });
      return;
    }
    if (!projectForm.defaultBranch.trim()) {
      setFieldErrors({ general: 'Default branch is required.' });
      return;
    }

    setCreatingProject(true);
    try {
      const created = await createProject({
        name: projectForm.name.trim(),
        description: projectForm.description.trim() || undefined,
        repoProvider: 'github',
        installationId: projectForm.installationId,
        repository,
        defaultBranch: projectForm.defaultBranch.trim(),
        githubRepoId: projectForm.githubRepoId,
      });
      setProject(created);
      setStep('setup');
      void loadAgents();
    } catch (error) {
      const mapped = mapProjectCreateError(error);
      setFieldErrors(mapped);
      if (mapped.general) setSubmitError(mapped.general);
    } finally {
      setCreatingProject(false);
    }
  };

  const saveProfile = async (kind: 'conversation' | 'task') => {
    if (!project) return;
    const draft = kind === 'conversation' ? conversationProfile : taskProfile;
    if (!draft.agentType) {
      setSetupError('Choose a configured agent before creating this profile, or skip it.');
      return;
    }
    if (!draft.name.trim()) {
      setSetupError('Profile name is required.');
      return;
    }
    setSetupError(null);
    setSavingSetup(kind);
    try {
      const created = await createAgentProfile(project.id, profilePayload(draft, kind));
      setCreatedProfiles((current) => ({ ...current, [kind]: created }));
      if (kind === 'conversation') setConversationStatus('done');
      if (kind === 'task') setTaskStatus('done');
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'Failed to create profile');
    } finally {
      setSavingSetup(null);
    }
  };

  const saveTrigger = async () => {
    if (!project) return;
    setTriggerError(null);
    if (!triggerForm.name.trim()) {
      setTriggerError('Trigger name is required.');
      return;
    }
    if (!triggerForm.cronExpression.trim()) {
      setTriggerError('Schedule is required.');
      return;
    }
    if (!triggerForm.promptTemplate.trim()) {
      setTriggerError('Prompt is required.');
      return;
    }
    setSavingSetup('trigger');
    try {
      await createTrigger(project.id, {
        name: triggerForm.name.trim(),
        description: triggerForm.description.trim() || undefined,
        sourceType: 'cron',
        cronExpression: triggerForm.cronExpression.trim(),
        cronTimezone: triggerForm.cronTimezone.trim() || 'UTC',
        promptTemplate: triggerForm.promptTemplate.trim(),
        skipIfRunning: true,
        maxConcurrent: 1,
        taskMode: 'task',
        agentProfileId: createdProfiles.task?.id,
      });
      setTriggerStatus('done');
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 409) {
        setTriggerError('A trigger with this name already exists in this project.');
      } else {
        setTriggerError(error instanceof Error ? error.message : 'Failed to create trigger');
      }
    } finally {
      setSavingSetup(null);
    }
  };

  const selectedKickoffProfileId = kickoffMode === 'conversation'
    ? createdProfiles.conversation?.id
    : createdProfiles.task?.id;

  const handleKickoff = async () => {
    if (!project) return;
    setKickoffError(null);
    if (!kickoffMessage.trim()) {
      setKickoffError('Write a message before starting.');
      return;
    }
    setKickoffSubmitting(true);
    try {
      const result = await submitTask(project.id, {
        message: kickoffMessage.trim(),
        taskMode: kickoffMode,
        agentProfileId: selectedKickoffProfileId,
      });
      const destination = kickoffMode === 'conversation'
        ? `/projects/${project.id}/chat/${result.sessionId}`
        : `/projects/${project.id}/tasks/${result.taskId}`;
      navigate(destination);
    } catch (error) {
      if (isCredentialError(error)) {
        setKickoffError('Cloud credentials are required before SAM can start a task or conversation for this project.');
      } else {
        setKickoffError(error instanceof Error ? error.message : 'Failed to start');
      }
    } finally {
      setKickoffSubmitting(false);
    }
  };

  const canContinueFromSetup = conversationStatus !== 'pending' && taskStatus !== 'pending' && triggerStatus !== 'pending';

  if (loading) {
    return (
      <div className="grid gap-4">
        <StepIndicator current="connect" />
        <div className="grid gap-3 rounded-md border border-border-default bg-surface p-4">
          <Skeleton width="35%" height="1rem" />
          <Skeleton width="100%" height="2.75rem" borderRadius="var(--sam-radius-md)" />
          <Skeleton width="100%" height="2.75rem" borderRadius="var(--sam-radius-md)" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="grid gap-4">
        <StepIndicator current="connect" />
        <Alert variant="error">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{loadError}</span>
            {onRetryInstallations && (
              <Button type="button" variant="secondary" onClick={onRetryInstallations}>
                Retry
              </Button>
            )}
          </div>
        </Alert>
      </div>
    );
  }

  if (installations.length === 0) {
    return (
      <div className="grid gap-4">
        <StepIndicator current="connect" />
        <Alert variant="warning">
          Install the GitHub App in Settings before creating a project from a repository.
        </Alert>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <StepIndicator current={step} />

      {step === 'connect' && (
        <form onSubmit={handleCreateProject} className="grid gap-4 rounded-md border border-border-default bg-surface p-4">
          <div className="grid gap-1">
            <h2 className="text-base font-semibold text-fg-primary">Connect code</h2>
            <p className="text-sm text-fg-muted">
              Pick the repository and branch SAM should use when it starts work.
            </p>
          </div>

          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Installation</span>
            <select
              value={projectForm.installationId}
              onChange={(event) => handleInstallationChange(event.currentTarget.value)}
              disabled={creatingProject}
              className="min-h-11 w-full rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
            >
              {installations.map((installation) => (
                <option key={installation.id} value={installation.id}>
                  {installation.accountName} ({installation.accountType})
                </option>
              ))}
            </select>
          </label>

          <label htmlFor="project-onboarding-repository" className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Repository</span>
            <RepoSelector
              id="project-onboarding-repository"
              value={projectForm.repository}
              onChange={handleRepositoryChange}
              onRepoSelect={handleRepoSelect}
              installationId={projectForm.installationId}
              disabled={creatingProject}
              required
            />
            {fieldErrors.repository && <span className="text-sm text-danger">{fieldErrors.repository}</span>}
            {fieldErrors.githubRepoId && <span className="text-sm text-danger">{fieldErrors.githubRepoId}</span>}
          </label>

          <label htmlFor="project-onboarding-branch" className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Branch</span>
            <BranchSelector
              id="project-onboarding-branch"
              branches={branches}
              value={projectForm.defaultBranch}
              onChange={(value) => setProjectForm((current) => ({ ...current, defaultBranch: value }))}
              defaultBranch={repoDefaultBranch}
              loading={branchesLoading}
              error={branchesError}
              disabled={creatingProject}
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Project name</span>
            <Input
              value={projectForm.name}
              onChange={(event) => {
                setProjectNameTouched(true);
                setProjectForm((current) => ({ ...current, name: event.currentTarget.value }));
                setFieldErrors((current) => ({ ...current, name: undefined }));
              }}
              disabled={creatingProject}
              placeholder="Project name"
            />
            {fieldErrors.name && <span className="text-sm text-danger">{fieldErrors.name}</span>}
          </label>

          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Description</span>
            <textarea
              value={projectForm.description}
              onChange={(event) => setProjectForm((current) => ({ ...current, description: event.currentTarget.value }))}
              rows={3}
              disabled={creatingProject}
              className="w-full resize-y rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
            />
          </label>

          {submitError && <Alert variant="error">{submitError}</Alert>}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={creatingProject}>
              {creatingProject ? 'Creating...' : 'Create project'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => navigate('/projects')} disabled={creatingProject}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {step === 'setup' && project && (
        <div className="grid gap-4">
          <div className="rounded-md border border-border-default bg-surface p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="grid gap-1">
                <h2 className="text-base font-semibold text-fg-primary">Set up {project.name}</h2>
                <p className="text-sm text-fg-muted">
                  Add optional profiles and a cron trigger. Each item can be skipped.
                </p>
              </div>
              <Button type="button" variant="secondary" onClick={loadAgents} disabled={agentsLoading}>
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
            onChange={setConversationProfile}
            onSave={() => void saveProfile('conversation')}
            onSkip={() => setConversationStatus('skipped')}
          />
          <ProfileSetupPanel
            title="Task profile"
            status={taskStatus}
            draft={taskProfile}
            configuredAgents={configuredAgents}
            disabled={agentsLoading || savingSetup !== null || taskStatus !== 'pending'}
            saving={savingSetup === 'task'}
            onChange={setTaskProfile}
            onSave={() => void saveProfile('task')}
            onSkip={() => setTaskStatus('skipped')}
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
                      onChange={(event) => setTriggerForm((current) => ({ ...current, name: event.currentTarget.value }))}
                      disabled={savingSetup !== null}
                    />
                  </label>
                  <label htmlFor="project-onboarding-trigger-schedule" className="grid gap-1.5">
                    <span className="text-sm text-fg-muted">Schedule</span>
                    <Input
                      id="project-onboarding-trigger-schedule"
                      value={triggerForm.cronExpression}
                      onChange={(event) => setTriggerForm((current) => ({ ...current, cronExpression: event.currentTarget.value }))}
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
                    onChange={(event) => setTriggerForm((current) => ({ ...current, promptTemplate: event.currentTarget.value }))}
                    rows={4}
                    disabled={savingSetup !== null}
                    className="w-full resize-y rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
                  />
                </label>
                {triggerError && <Alert variant="error">{triggerError}</Alert>}
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={() => void saveTrigger()} disabled={savingSetup !== null}>
                    {savingSetup === 'trigger' ? 'Creating...' : 'Create trigger'}
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setTriggerStatus('skipped')} disabled={savingSetup !== null}>
                    Skip trigger
                  </Button>
                </div>
              </>
            )}
          </section>

          {setupError && <Alert variant="error">{setupError}</Alert>}

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => setStep('kickoff')} disabled={!canContinueFromSetup}>
              Continue <ChevronRight size={16} aria-hidden="true" />
            </Button>
            <Button type="button" variant="secondary" onClick={() => navigate(`/projects/${project.id}`)}>
              Open project
            </Button>
          </div>
        </div>
      )}

      {step === 'kickoff' && project && (
        <section className="grid gap-4 rounded-md border border-border-default bg-surface p-4">
          <div className="grid gap-1">
            <h2 className="text-base font-semibold text-fg-primary">Kick off work</h2>
            <p className="text-sm text-fg-muted">
              Starting either option uses cloud credentials. You can skip this and open the project now.
            </p>
          </div>

          <fieldset className="grid gap-2">
            <legend className="text-sm text-fg-muted">Start mode</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <ModeButton
                selected={kickoffMode === 'task'}
                title="Task"
                description="Create a tracked task run."
                onClick={() => setKickoffMode('task')}
              />
              <ModeButton
                selected={kickoffMode === 'conversation'}
                title="Conversation"
                description="Start an open-ended project conversation."
                onClick={() => setKickoffMode('conversation')}
              />
            </div>
          </fieldset>

          <label htmlFor="project-onboarding-kickoff-message" className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Message</span>
            <textarea
              id="project-onboarding-kickoff-message"
              value={kickoffMessage}
              onChange={(event) => setKickoffMessage(event.currentTarget.value)}
              rows={5}
              disabled={kickoffSubmitting}
              className="w-full resize-y rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
            />
          </label>

          {kickoffError && <Alert variant="error">{kickoffError}</Alert>}

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void handleKickoff()} disabled={kickoffSubmitting}>
              {kickoffSubmitting ? 'Starting...' : kickoffMode === 'task' ? 'Start task' : 'Start conversation'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => navigate(`/projects/${project.id}`)} disabled={kickoffSubmitting}>
              Skip - open project
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

function SetupHeader({ title, status }: { title: string; status: SetupStatus }) {
  const label = status === 'pending' ? 'Optional' : status === 'done' ? 'Created' : 'Skipped';
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-fg-primary">{title}</h3>
      <span className="rounded-md border border-border-default px-2 py-1 text-xs text-fg-muted">{label}</span>
    </div>
  );
}

function ProfileSetupPanel({
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

function ModeButton({
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
