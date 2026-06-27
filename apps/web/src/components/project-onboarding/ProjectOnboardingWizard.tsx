import type {
  AgentInfo,
  AgentProfile,
  GitHubInstallation,
  Project,
} from '@simple-agent-manager/shared';
import { Alert, Button, Skeleton } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';
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
import {
  type CreatedProfiles,
  deriveProjectName,
  type FieldErrors,
  isCredentialError,
  isNotApprovedError,
  mapProjectCreateError,
  normalizeRepository,
  type ProfileDraft,
  profilePayload,
  type SetupStatus,
  StepIndicator,
  type WizardStep,
} from './shared';
import { StepConnect } from './StepConnect';
import { StepKickoff } from './StepKickoff';
import { StepSetup } from './StepSetup';

interface ProjectOnboardingWizardProps {
  installations: GitHubInstallation[];
  loading?: boolean;
  loadError?: string | null;
  onRetryInstallations?: () => void;
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

  // Step 2: Setup state
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

  // Step 3: Kickoff state
  const [kickoffMode, setKickoffMode] = useState<'task' | 'conversation'>('task');
  const [kickoffMessage, setKickoffMessage] = useState('Review this repository and suggest the highest-impact next steps.');
  const [kickoffError, setKickoffError] = useState<string | null>(null);
  const [kickoffSubmitting, setKickoffSubmitting] = useState(false);

  useEffect(() => {
    setProjectForm((current) => (
      current.installationId ? current : { ...current, installationId: defaultInstallationId }
    ));
  }, [defaultInstallationId]);

  /* ─── Step 1 handlers ─── */

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

  const loadConfiguredAgents = useCallback(async () => {
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

  const handleCreateProject = async (event: React.FormEvent<HTMLFormElement>) => {
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
      void loadConfiguredAgents();
    } catch (error) {
      const mapped = mapProjectCreateError(error);
      setFieldErrors(mapped);
      if (mapped.general) setSubmitError(mapped.general);
    } finally {
      setCreatingProject(false);
    }
  };

  /* ─── Step 2 handlers ─── */

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
      const created: AgentProfile = await createAgentProfile(project.id, profilePayload(draft, kind));
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

  /* ─── Step 3 handlers ─── */

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
      if (isNotApprovedError(error)) {
        setKickoffError('Your account is pending approval. You can still create projects and profiles, but starting tasks requires an approved account.');
      } else if (isCredentialError(error)) {
        setKickoffError('Cloud credentials are required. Connect a cloud provider in Settings before starting a task or conversation.');
      } else {
        setKickoffError(error instanceof Error ? error.message : 'Failed to start');
      }
    } finally {
      setKickoffSubmitting(false);
    }
  };

  const canContinueFromSetup = conversationStatus !== 'pending' && taskStatus !== 'pending' && triggerStatus !== 'pending';

  /* ─── Loading / error states ─── */

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

  /* ─── Render ─── */

  return (
    <div className="grid gap-4">
      <StepIndicator current={step} />

      {step === 'connect' && (
        <StepConnect
          installations={installations}
          projectForm={projectForm}
          branches={branches}
          branchesLoading={branchesLoading}
          branchesError={branchesError}
          repoDefaultBranch={repoDefaultBranch}
          fieldErrors={fieldErrors}
          submitError={submitError}
          creatingProject={creatingProject}
          onInstallationChange={handleInstallationChange}
          onRepositoryChange={handleRepositoryChange}
          onRepoSelect={handleRepoSelect}
          onBranchChange={(value) => setProjectForm((c) => ({ ...c, defaultBranch: value }))}
          onNameChange={(value) => {
            setProjectNameTouched(true);
            setProjectForm((c) => ({ ...c, name: value }));
            setFieldErrors((c) => ({ ...c, name: undefined }));
          }}
          onDescriptionChange={(value) => setProjectForm((c) => ({ ...c, description: value }))}
          onSubmit={handleCreateProject}
          onCancel={() => navigate('/projects')}
        />
      )}

      {step === 'setup' && project && (
        <StepSetup
          project={project}
          configuredAgents={configuredAgents}
          agentsLoading={agentsLoading}
          agentsError={agentsError}
          conversationProfile={conversationProfile}
          taskProfile={taskProfile}
          triggerForm={triggerForm}
          conversationStatus={conversationStatus}
          taskStatus={taskStatus}
          triggerStatus={triggerStatus}
          setupError={setupError}
          triggerError={triggerError}
          savingSetup={savingSetup}
          createdProfiles={createdProfiles}
          canContinueFromSetup={canContinueFromSetup}
          onRefreshAgents={loadConfiguredAgents}
          onConversationProfileChange={setConversationProfile}
          onTaskProfileChange={setTaskProfile}
          onTriggerFormChange={setTriggerForm}
          onSaveProfile={(kind) => void saveProfile(kind)}
          onSkipProfile={(kind) => {
            if (kind === 'conversation') setConversationStatus('skipped');
            if (kind === 'task') setTaskStatus('skipped');
          }}
          onSaveTrigger={() => void saveTrigger()}
          onSkipTrigger={() => setTriggerStatus('skipped')}
          onContinue={() => setStep('kickoff')}
          onOpenProject={() => navigate(`/projects/${project.id}`)}
        />
      )}

      {step === 'kickoff' && project && (
        <StepKickoff
          kickoffMode={kickoffMode}
          kickoffMessage={kickoffMessage}
          kickoffError={kickoffError}
          kickoffSubmitting={kickoffSubmitting}
          onModeChange={setKickoffMode}
          onMessageChange={setKickoffMessage}
          onKickoff={() => void handleKickoff()}
          onSkip={() => navigate(`/projects/${project.id}`)}
        />
      )}
    </div>
  );
}
