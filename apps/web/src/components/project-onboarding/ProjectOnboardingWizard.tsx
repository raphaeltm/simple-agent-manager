import type {
  AgentInfo,
  AgentProfile,
  GitHubInstallation,
  GitLabProject,
  Project,
  RepoProvider,
} from '@simple-agent-manager/shared';
import { Alert, Button, Skeleton } from '@simple-agent-manager/ui';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import {
  ApiClientError,
  createAgentProfile,
  createProject,
  createTrigger,
  listAgents,
  listBranches,
  listGitLabBranches,
  submitTask,
} from '../../lib/api';
import {
  MobileProgress,
  ONBOARDING_STEPS,
  type OnboardingStepId,
  ProgressRail,
  stepIndex,
} from './explain';
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
} from './shared';
import { StepAutomation } from './StepAutomation';
import { StepConnect } from './StepConnect';
import { StepHowSamWorks, StepWelcome } from './StepIntro';
import { StepKickoff } from './StepKickoff';
import { StepProfile } from './StepProfile';
import { StepProvider } from './StepProvider';

interface ProjectOnboardingWizardProps {
  installations: GitHubInstallation[];
  artifactsEnabled?: boolean;
  gitlabEnabled?: boolean;
  loading?: boolean;
  loadError?: string | null;
  onRetryInstallations?: () => void;
}

export function ProjectOnboardingWizard({
  installations,
  artifactsEnabled = false,
  gitlabEnabled = false,
  loading = false,
  loadError,
  onRetryInstallations,
}: ProjectOnboardingWizardProps) {
  const navigate = useNavigate();
  const [step, setStep] = useState<OnboardingStepId>('welcome');
  const [repoProvider, setRepoProvider] = useState<RepoProvider>('github');
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
    gitlabProjectId: undefined as number | undefined,
  });
  const [branches, setBranches] = useState<Array<{ name: string }>>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [repoDefaultBranch, setRepoDefaultBranch] = useState<string | undefined>(undefined);

  // Setup state
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [configuredAgents, setConfiguredAgents] = useState<AgentInfo[]>([]);
  const [createdProfiles, setCreatedProfiles] = useState<CreatedProfiles>({});
  const [triggerStatus, setTriggerStatus] = useState<SetupStatus>('pending');
  const [setupError, setSetupError] = useState<string | null>(null);
  const [savingSetup, setSavingSetup] = useState<string | null>(null);

  const [conversationProfile, setConversationProfile] = useState<ProfileDraft>({
    name: 'Conversation profile',
    description: 'Default profile for project conversations',
    agentType: '',
    model: '',
  });
  const [taskProfile, setTaskProfile] = useState<ProfileDraft>({
    name: 'Task profile',
    description: 'Default profile for project tasks',
    agentType: '',
    model: '',
  });
  const [triggerForm, setTriggerForm] = useState({
    name: 'Daily project check-in',
    description: '',
    cronExpression: '0 9 * * *',
    cronTimezone: 'UTC',
    promptTemplate: 'Review recent project activity and suggest the next useful task.',
  });
  const [triggerError, setTriggerError] = useState<string | null>(null);

  // Kickoff state
  const [kickoffMode, setKickoffMode] = useState<'task' | 'conversation'>('task');
  const [kickoffMessage, setKickoffMessage] = useState(
    'Review this repository and suggest the highest-impact next steps.'
  );
  const [kickoffError, setKickoffError] = useState<string | null>(null);
  const [kickoffSubmitting, setKickoffSubmitting] = useState(false);

  useEffect(() => {
    setProjectForm((current) =>
      current.installationId ? current : { ...current, installationId: defaultInstallationId }
    );
  }, [defaultInstallationId]);

  const currentIndex = stepIndex(step);
  // Once a project exists, steps before "conversation" are locked (can't re-create).
  const lockedBeforeIndex = project ? stepIndex('conversation') : 0;

  useEffect(() => {
    const shellScroller = document.querySelector<HTMLElement>('.sam-main-content');
    if (!shellScroller) return;
    if (typeof shellScroller.scrollTo === 'function') {
      shellScroller.scrollTo({ top: 0, left: 0 });
      return;
    }
    shellScroller.scrollTop = 0;
    shellScroller.scrollLeft = 0;
  }, [step]);

  const goToStep = (id: OnboardingStepId) => {
    // Clear step-scoped setup errors so a failed Create attempt on one step does
    // not surface under a different step's form.
    setSetupError(null);
    setStep(id);
  };
  const goNext = () => {
    const nextStep = ONBOARDING_STEPS[Math.min(currentIndex + 1, ONBOARDING_STEPS.length - 1)];
    if (nextStep) goToStep(nextStep.id);
  };
  const goBack = () => {
    const previousStep = ONBOARDING_STEPS[Math.max(currentIndex - 1, 0)];
    if (previousStep) goToStep(previousStep.id);
  };

  /* ─── Connect handlers ─── */

  const fetchBranches = useCallback(
    async (repository: string, installationId: string, defaultBranch?: string) => {
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
    },
    []
  );

  const handleRepositoryChange = (value: string) => {
    setProjectForm((current) => ({
      ...current,
      repository: value,
      githubRepoId: undefined,
      gitlabProjectId: undefined,
    }));
    setBranches([]);
    setBranchesError(null);
    setFieldErrors((current) => ({
      ...current,
      repository: undefined,
      githubRepoId: undefined,
      gitlabProjectId: undefined,
    }));
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
    [fetchBranches, projectForm.installationId, projectNameTouched]
  );

  const handleGitLabProjectSelect = useCallback(
    (gitlabProject: GitLabProject | null) => {
      if (!gitlabProject) {
        setProjectForm((current) => ({ ...current, gitlabProjectId: undefined }));
        setBranches([]);
        setBranchesError(null);
        return;
      }
      const nextName = deriveProjectName(gitlabProject.pathWithNamespace);
      setRepoDefaultBranch(gitlabProject.defaultBranch);
      setProjectForm((current) => ({
        ...current,
        name: projectNameTouched || current.name.trim() ? current.name : nextName,
        repository: gitlabProject.pathWithNamespace,
        defaultBranch: gitlabProject.defaultBranch,
        gitlabProjectId: gitlabProject.id,
      }));
      setBranchesLoading(true);
      setBranches([]);
      setBranchesError(null);
      listGitLabBranches(gitlabProject.id)
        .then((result) => {
          setBranches(result.length > 0 ? result : [{ name: gitlabProject.defaultBranch }]);
          if (result.length === 0) {
            setBranchesError('No branches returned. The default branch is available.');
          }
        })
        .catch(() => {
          setBranches([{ name: gitlabProject.defaultBranch }]);
          setBranchesError('Unable to fetch branches. The default branch is available.');
        })
        .finally(() => setBranchesLoading(false));
    },
    [projectNameTouched]
  );

  const handleInstallationChange = (installationId: string) => {
    setProjectForm((current) => ({
      ...current,
      installationId,
      repository: '',
      defaultBranch: 'main',
      githubRepoId: undefined,
      gitlabProjectId: undefined,
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
      setConversationProfile((current) => ({
        ...current,
        agentType: current.agentType || firstAgent,
      }));
      setTaskProfile((current) => ({ ...current, agentType: current.agentType || firstAgent }));
    } catch (error) {
      setAgentsError(error instanceof Error ? error.message : 'Failed to load configured agents');
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  const handleCreateProject = async () => {
    if (project) {
      goToStep('conversation');
      return;
    }
    setSubmitError(null);
    setFieldErrors({});

    if (!projectForm.name.trim()) {
      setFieldErrors({ name: 'Project name is required.' });
      return;
    }

    let payload;
    if (repoProvider === 'artifacts') {
      payload = {
        name: projectForm.name.trim(),
        description: projectForm.description.trim() || undefined,
        repoProvider: 'artifacts' as const,
        defaultBranch: 'main',
      };
    } else if (repoProvider === 'gitlab') {
      if (!projectForm.gitlabProjectId) {
        setFieldErrors({ gitlabProjectId: 'Select a GitLab project.' });
        return;
      }
      if (!projectForm.defaultBranch.trim()) {
        setFieldErrors({ general: 'Default branch is required.' });
        setSubmitError('Default branch is required.');
        return;
      }
      payload = {
        name: projectForm.name.trim(),
        description: projectForm.description.trim() || undefined,
        repoProvider: 'gitlab' as const,
        gitlabProjectId: projectForm.gitlabProjectId,
        defaultBranch: projectForm.defaultBranch.trim(),
      };
    } else {
      const repository = normalizeRepository(projectForm.repository);
      if (!projectForm.installationId.trim()) {
        setFieldErrors({ general: 'Select a GitHub installation.' });
        setSubmitError('Select a GitHub installation.');
        return;
      }
      if (!repository) {
        setFieldErrors({ repository: 'Repository is required.' });
        return;
      }
      if (!projectForm.defaultBranch.trim()) {
        setFieldErrors({ general: 'Default branch is required.' });
        setSubmitError('Default branch is required.');
        return;
      }
      payload = {
        name: projectForm.name.trim(),
        description: projectForm.description.trim() || undefined,
        repoProvider: 'github' as const,
        installationId: projectForm.installationId,
        repository,
        defaultBranch: projectForm.defaultBranch.trim(),
        githubRepoId: projectForm.githubRepoId,
      };
    }

    setCreatingProject(true);
    try {
      const created = await createProject(payload);
      setProject(created);
      goToStep('conversation');
      void loadConfiguredAgents();
    } catch (error) {
      const mapped = mapProjectCreateError(error);
      setFieldErrors(mapped);
      if (mapped.general) setSubmitError(mapped.general);
    } finally {
      setCreatingProject(false);
    }
  };

  /* ─── Setup handlers ─── */

  const saveProfile = async (kind: 'conversation' | 'task'): Promise<boolean> => {
    if (!project) return false;
    const draft = kind === 'conversation' ? conversationProfile : taskProfile;
    if (!draft.agentType) {
      setSetupError('Choose a configured agent before creating this profile, or skip it.');
      return false;
    }
    if (!draft.name.trim()) {
      setSetupError('Profile name is required.');
      return false;
    }
    setSetupError(null);
    setSavingSetup(kind);
    try {
      const created: AgentProfile = await createAgentProfile(
        project.id,
        profilePayload(draft, kind)
      );
      setCreatedProfiles((current) => ({ ...current, [kind]: created }));
      return true;
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'Failed to create profile');
      return false;
    } finally {
      setSavingSetup(null);
    }
  };

  const saveTrigger = async (): Promise<boolean> => {
    if (!project) return false;
    setTriggerError(null);
    if (!triggerForm.name.trim()) {
      setTriggerError('Trigger name is required.');
      return false;
    }
    if (!triggerForm.cronExpression.trim()) {
      setTriggerError('Schedule is required.');
      return false;
    }
    if (!triggerForm.promptTemplate.trim()) {
      setTriggerError('Prompt is required.');
      return false;
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
      return true;
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 409) {
        setTriggerError('A trigger with this name already exists in this project.');
      } else {
        setTriggerError(error instanceof Error ? error.message : 'Failed to create trigger');
      }
      return false;
    } finally {
      setSavingSetup(null);
    }
  };

  /* ─── Footer step actions (Create / Skip advance to the next step) ─── */

  const createProfileAndAdvance = async (kind: 'conversation' | 'task') => {
    if (createdProfiles[kind]) {
      goNext();
      return;
    }
    if (await saveProfile(kind)) goNext();
  };

  const skipProfile = (_kind: 'conversation' | 'task') => {
    setSetupError(null);
    goNext();
  };

  const createTriggerAndAdvance = async () => {
    if (triggerStatus === 'done') {
      goNext();
      return;
    }
    if (await saveTrigger()) goNext();
  };

  const skipTrigger = () => {
    setTriggerStatus('skipped');
    setTriggerError(null);
    goNext();
  };

  /* ─── Kickoff handlers ─── */

  const selectedKickoffProfileId =
    kickoffMode === 'conversation' ? createdProfiles.conversation?.id : createdProfiles.task?.id;

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
      navigate(`/projects/${project.id}/chat/${result.sessionId}`);
    } catch (error) {
      if (isNotApprovedError(error)) {
        setKickoffError(
          'Your account is pending approval. You can still create projects and profiles, but starting tasks requires an approved account.'
        );
      } else if (isCredentialError(error)) {
        setKickoffError(
          'Cloud credentials are required. Connect a cloud provider in Settings before starting a task or conversation.'
        );
      } else {
        setKickoffError(error instanceof Error ? error.message : 'Failed to start');
      }
    } finally {
      setKickoffSubmitting(false);
    }
  };

  /* ─── Render ─── */

  const renderBody = () => {
    switch (step) {
      case 'welcome':
        return <StepWelcome />;
      case 'how-sam-works':
        return <StepHowSamWorks />;
      case 'provider':
        return (
          <StepProvider
            value={repoProvider}
            artifactsEnabled={artifactsEnabled}
            gitlabEnabled={gitlabEnabled}
            onChange={setRepoProvider}
          />
        );
      case 'connect':
        if (repoProvider === 'github' && loading) {
          return (
            <div className="grid gap-3 rounded-md border border-border-default bg-surface p-4">
              <Skeleton width="35%" height="1rem" />
              <Skeleton width="100%" height="2.75rem" borderRadius="var(--sam-radius-md)" />
              <Skeleton width="100%" height="2.75rem" borderRadius="var(--sam-radius-md)" />
            </div>
          );
        }
        if (repoProvider === 'github' && loadError) {
          return (
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
          );
        }
        return (
          <StepConnect
            repoProvider={repoProvider}
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
            onGitLabProjectSelect={handleGitLabProjectSelect}
            onBranchChange={(value) => setProjectForm((c) => ({ ...c, defaultBranch: value }))}
            onNameChange={(value) => {
              setProjectNameTouched(true);
              setProjectForm((c) => ({ ...c, name: value }));
              setFieldErrors((c) => ({ ...c, name: undefined }));
            }}
            onDescriptionChange={(value) => setProjectForm((c) => ({ ...c, description: value }))}
          />
        );
      case 'conversation':
        return (
          <StepProfile
            kind="conversation"
            draft={conversationProfile}
            configuredAgents={configuredAgents}
            agentsLoading={agentsLoading}
            agentsError={agentsError}
            onChange={setConversationProfile}
            onRefreshAgents={loadConfiguredAgents}
          />
        );
      case 'task':
        return (
          <StepProfile
            kind="task"
            draft={taskProfile}
            configuredAgents={configuredAgents}
            agentsLoading={agentsLoading}
            agentsError={agentsError}
            onChange={setTaskProfile}
            onRefreshAgents={loadConfiguredAgents}
          />
        );
      case 'automation':
        return (
          <StepAutomation
            triggerForm={triggerForm}
            error={triggerError}
            onChange={setTriggerForm}
          />
        );
      case 'kickoff':
        return (
          <StepKickoff
            kickoffMode={kickoffMode}
            kickoffMessage={kickoffMessage}
            kickoffError={kickoffError}
            kickoffSubmitting={kickoffSubmitting}
            onModeChange={setKickoffMode}
            onMessageChange={setKickoffMessage}
            onKickoff={() => void handleKickoff()}
            onSkip={() => navigate(`/projects/${project?.id ?? ''}`)}
          />
        );
    }
  };

  // Setup profile errors surface at the step level (shared across conversation/task).
  const showSetupError = setupError && (step === 'conversation' || step === 'task');

  // Footer primary/secondary actions per step. Create and Skip both advance;
  // kickoff renders its own actions inside the step body.
  const renderStepActions = () => {
    if (step === 'connect') {
      return (
        <Button type="button" onClick={() => void handleCreateProject()} disabled={creatingProject}>
          {creatingProject ? 'Creating...' : project ? 'Continue' : 'Create project'}{' '}
          <ArrowRight size={16} aria-hidden="true" />
        </Button>
      );
    }
    if (step === 'kickoff') return null;
    if (step === 'conversation' || step === 'task') {
      const saving = savingSetup === step;
      return (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => skipProfile(step)}
            disabled={saving}
          >
            Skip
          </Button>
          <Button
            type="button"
            onClick={() => void createProfileAndAdvance(step)}
            disabled={saving || configuredAgents.length === 0}
          >
            {saving ? 'Creating...' : 'Create profile'} <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </div>
      );
    }
    if (step === 'automation') {
      const saving = savingSetup === 'trigger';
      return (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={skipTrigger} disabled={saving}>
            Skip
          </Button>
          <Button type="button" onClick={() => void createTriggerAndAdvance()} disabled={saving}>
            {saving ? 'Creating...' : 'Create trigger'} <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </div>
      );
    }
    return (
      <Button type="button" onClick={goNext}>
        {step === 'welcome' ? 'Get started' : 'Continue'}{' '}
        <ArrowRight size={16} aria-hidden="true" />
      </Button>
    );
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <aside className="hidden lg:block">
        <div className="sticky top-4">
          <ProgressRail current={step} lockedBeforeIndex={lockedBeforeIndex} onJump={goToStep} />
        </div>
      </aside>

      <section className="grid gap-4">
        <MobileProgress current={step} />

        {renderBody()}

        {showSetupError && <Alert variant="error">{setupError}</Alert>}

        <nav
          className="flex items-center justify-between gap-2 border-t border-border-default pt-4"
          aria-label="Step navigation"
        >
          <Button
            type="button"
            variant="secondary"
            onClick={step === 'welcome' ? () => navigate('/projects') : goBack}
            disabled={
              creatingProject ||
              (currentIndex <= lockedBeforeIndex && currentIndex !== 0 && !!project)
            }
          >
            <ArrowLeft size={16} aria-hidden="true" /> {step === 'welcome' ? 'Cancel' : 'Back'}
          </Button>

          {renderStepActions()}
        </nav>
      </section>
    </div>
  );
}
