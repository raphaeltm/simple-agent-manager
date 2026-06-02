import type {
  AgentType,
  Repository,
  SaveAgentCredentialRequest,
} from '@simple-agent-manager/shared';
import { AGENT_CATALOG } from '@simple-agent-manager/shared';
import { Alert, Button, Card, Input } from '@simple-agent-manager/ui';
import { ArrowRight, Check, ChevronDown, Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

import {
  createCredential,
  getGitHubInstallUrl,
  listGitHubInstallations,
  listRepositories,
  saveAgentCredential,
  validateAgentCredential,
  validateCredential,
} from '../../../lib/api';
import { createProject } from '../../../lib/api/projects';
import type { GeneratedStep, StepId } from './path-generator';

interface StepExecutionProps {
  steps: GeneratedStep[];
  tags: string[];
  onComplete: () => void;
}

/** Per-step inline form state */
interface StepFormState {
  apiKey: string;
  selectedAgent: AgentType | null;
  hetznerToken: string;
  selectedRepoUrl: string;
  selectedRepoName: string;
}

const INITIAL_FORM: StepFormState = {
  apiKey: '',
  selectedAgent: null,
  hetznerToken: '',
  selectedRepoUrl: '',
  selectedRepoName: '',
};

export function StepExecution({ steps, tags, onComplete }: StepExecutionProps) {
  const navigate = useNavigate();
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);
  const [expandedDetails, setExpandedDetails] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<StepFormState>(INITIAL_FORM);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [reposLoading, setReposLoading] = useState(false);

  const step = steps[currentStepIndex];
  const isLast = currentStepIndex >= steps.length - 1;
  const progress = steps.length > 0 ? (completedSteps.length / steps.length) * 100 : 0;
  const stepId = step?.id ?? ('ai-apikey' as StepId);

  const markStepDone = useCallback(() => {
    setCompletedSteps((prev) => [...prev, stepId]);
    setError(null);
    setExpandedDetails(false);
    if (isLast) {
      setTimeout(onComplete, 300);
    } else {
      setCurrentStepIndex((i) => i + 1);
    }
  }, [stepId, isLast, onComplete]);

  const handleAction = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      await executeStep(stepId, form);
      markStepDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [stepId, form, markStepDone]);

  const handleSkip = useCallback(() => {
    markStepDone();
  }, [markStepDone]);

  const handleGitHubInstall = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { url } = await getGitHubInstallUrl();
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get install URL');
      setLoading(false);
    }
  }, []);

  const handleCreateProject = useCallback(async () => {
    if (!form.selectedRepoUrl || !form.selectedRepoName) {
      setError('Please select a repository');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Find the selected repo to get its installationId and githubRepoId
      const selectedRepo = repos.find((r) => r.fullName === form.selectedRepoName);
      const project = await createProject({
        name: form.selectedRepoName.split('/').pop() || form.selectedRepoName,
        repository: form.selectedRepoUrl,
        installationId: selectedRepo?.installationId,
        githubRepoId: selectedRepo?.id,
      });
      markStepDone();
      setTimeout(() => navigate(`/projects/${project.id}`), 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setLoading(false);
    }
  }, [form.selectedRepoUrl, form.selectedRepoName, repos, markStepDone, navigate]);

  const loadRepos = useCallback(async () => {
    setReposLoading(true);
    try {
      const installations = await listGitHubInstallations();
      if (installations.length === 0) {
        setRepos([]);
        return;
      }
      const result = await listRepositories(installations[0]!.id);
      setRepos(result.repositories);
    } catch {
      // Non-critical — user may not have GitHub set up yet
      setRepos([]);
    } finally {
      setReposLoading(false);
    }
  }, []);

  return (
    <div className="max-w-md mx-auto">
      {/* Progress header */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-fg-muted/60">
            Step {currentStepIndex + 1} of {steps.length}
          </span>
          <span className="text-xs text-fg-muted/60">
            {Math.round(progress)}% complete
          </span>
        </div>
        <div className="w-full h-1.5 bg-accent/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        {/* Step pills */}
        <div className="flex gap-1 mt-2">
          {steps.map((s, i) => (
            <div
              key={s.id}
              className={`h-1 flex-1 rounded-full transition-all ${
                completedSteps.includes(s.id)
                  ? 'bg-accent'
                  : i === currentStepIndex
                    ? 'bg-accent/50'
                    : 'bg-accent/10'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Current step card */}
      {step && (
        <Card className="p-6 mb-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center text-xs font-bold text-accent">
              {currentStepIndex + 1}
            </div>
            <h3 className="text-lg font-semibold text-fg-primary">{step.title}</h3>
          </div>
          <p className="text-sm text-fg-muted mb-4 ml-9">{step.description}</p>

          {/* Error */}
          {error && (
            <div className="ml-9 mb-4">
              <Alert variant="error" onDismiss={() => setError(null)}>
                {error}
              </Alert>
            </div>
          )}

          {/* Step-specific form content */}
          <div className="ml-9">
            <StepForm
              stepId={step.id}
              tags={tags}
              form={form}
              setForm={setForm}
              loading={loading}
              repos={repos}
              reposLoading={reposLoading}
              onLoadRepos={loadRepos}
              onAction={handleAction}
              onGitHubInstall={handleGitHubInstall}
              onCreateProject={handleCreateProject}
              onSkip={step.isOptional ? handleSkip : undefined}
              actionLabel={step.actionLabel}
            />
          </div>

          {/* Expandable details */}
          <div className="ml-9 mt-4">
            <button
              type="button"
              onClick={() => setExpandedDetails(!expandedDetails)}
              className="flex items-center gap-1 text-xs text-fg-muted/50 hover:text-fg-muted transition-colors bg-transparent border-none cursor-pointer p-0"
            >
              <ChevronDown
                size={12}
                className={`transition-transform ${expandedDetails ? 'rotate-180' : ''}`}
              />
              {expandedDetails ? 'Hide' : 'Show'} details
            </button>
            {expandedDetails && (
              <ul className="mt-2 flex flex-col gap-1.5">
                {step.details.map((detail, i) => (
                  <li key={i} className="text-xs text-fg-muted flex items-start gap-2">
                    <Check size={10} className="text-accent/50 mt-0.5 shrink-0" />
                    {detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}

      {/* Upcoming steps */}
      {!isLast && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[10px] text-fg-muted/30 uppercase tracking-wide font-medium">
            Coming up
          </p>
          {steps.slice(currentStepIndex + 1).map((s, i) => (
            <div
              key={s.id}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-fg-muted/40"
            >
              <div className="w-5 h-5 rounded-full bg-accent/5 flex items-center justify-center text-[10px]">
                {currentStepIndex + 2 + i}
              </div>
              <span>{s.title}</span>
              <span className="ml-auto text-[10px]">{s.timeEstimate}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Step-specific form rendering ─── */

interface StepFormProps {
  stepId: StepId;
  tags: string[];
  form: StepFormState;
  setForm: React.Dispatch<React.SetStateAction<StepFormState>>;
  loading: boolean;
  repos: Repository[];
  reposLoading: boolean;
  onLoadRepos: () => void;
  onAction: () => void;
  onGitHubInstall: () => void;
  onCreateProject: () => void;
  onSkip?: () => void;
  actionLabel: string;
}

function StepForm({
  stepId,
  tags,
  form,
  setForm,
  loading,
  repos,
  reposLoading,
  onLoadRepos,
  onAction,
  onGitHubInstall,
  onCreateProject,
  onSkip,
  actionLabel,
}: StepFormProps) {
  switch (stepId) {
    case 'ai-apikey': {
      const isAnthropic = tags.includes('anthropic-key') || tags.includes('has-claude');
      const agents = AGENT_CATALOG.filter((a) =>
        isAnthropic ? a.provider === 'anthropic' : a.provider === 'openai'
      );
      const defaultAgent = agents[0];

      // Auto-select agent if not already selected
      if (!form.selectedAgent && defaultAgent) {
        // Use setTimeout to avoid setState during render
        setTimeout(() => setForm((prev) => ({ ...prev, selectedAgent: defaultAgent.id })), 0);
      }

      return (
        <>
          {agents.length > 1 && (
            <div className="mb-3">
              <label className="block text-xs font-medium text-fg-muted mb-1">Agent</label>
              <div className="flex gap-2">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, selectedAgent: agent.id }))}
                    className={`px-3 py-1.5 rounded text-xs border cursor-pointer transition-colors ${
                      form.selectedAgent === agent.id
                        ? 'border-accent bg-accent/10 text-fg-primary'
                        : 'border-border-default bg-surface text-fg-muted hover:border-fg-muted'
                    }`}
                  >
                    {agent.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="mb-3">
            <Input
              type="password"
              autoComplete="off"
              value={form.apiKey}
              onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))}
              placeholder={`Paste your ${isAnthropic ? 'Anthropic' : 'OpenAI'} API key`}
            />
            {defaultAgent && (
              <a
                href={defaultAgent.credentialHelpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-accent hover:underline mt-1 inline-block"
              >
                Where do I get this?
              </a>
            )}
          </div>
          <ActionButton
            onClick={onAction}
            loading={loading}
            disabled={!form.apiKey.trim() || !form.selectedAgent}
            label={actionLabel}
          />
        </>
      );
    }

    case 'ai-oauth':
      return (
        <>
          <p className="text-xs text-fg-muted mb-3">
            You'll be redirected to Anthropic to approve access. Your existing subscription covers the cost.
          </p>
          <ActionButton onClick={onAction} loading={loading} label={actionLabel} />
        </>
      );

    case 'ai-sam':
      return (
        <>
          <p className="text-xs text-fg-muted mb-3">
            SAM provides AI through Cloudflare. You can set budget limits in Settings after setup.
          </p>
          <ActionButton onClick={onAction} loading={loading} label={actionLabel} />
          {onSkip && (
            <button
              type="button"
              onClick={onSkip}
              className="ml-2 text-sm text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer"
            >
              Skip
            </button>
          )}
        </>
      );

    case 'cloud-hetzner':
      return (
        <>
          <div className="mb-3">
            <Input
              type="password"
              autoComplete="off"
              value={form.hetznerToken}
              onChange={(e) => setForm((prev) => ({ ...prev, hetznerToken: e.target.value }))}
              placeholder="Paste your Hetzner API token"
            />
            <a
              href="https://console.hetzner.cloud/projects"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-accent hover:underline mt-1 inline-block"
            >
              Get a token from Hetzner Console
            </a>
          </div>
          <ActionButton
            onClick={onAction}
            loading={loading}
            disabled={!form.hetznerToken.trim()}
            label={actionLabel}
          />
        </>
      );

    case 'cloud-sam':
      return (
        <div className="flex items-center gap-2">
          <ActionButton onClick={onAction} loading={loading} label="Continue" />
          {onSkip && (
            <button
              type="button"
              onClick={onSkip}
              className="text-sm text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer"
            >
              Skip
            </button>
          )}
        </div>
      );

    case 'github':
      return (
        <ActionButton onClick={onGitHubInstall} loading={loading} label={actionLabel} />
      );

    case 'project':
      return (
        <ProjectSelector
          repos={repos}
          reposLoading={reposLoading}
          onLoadRepos={onLoadRepos}
          form={form}
          setForm={setForm}
          loading={loading}
          onCreateProject={onCreateProject}
          tags={tags}
        />
      );

    default:
      return <ActionButton onClick={onAction} loading={loading} label={actionLabel} />;
  }
}

function ActionButton({
  onClick,
  loading,
  disabled,
  label,
}: {
  onClick: () => void;
  loading: boolean;
  disabled?: boolean;
  label: string;
}) {
  return (
    <Button
      variant="primary"
      size="md"
      onClick={onClick}
      disabled={loading || disabled}
    >
      {loading ? (
        <>
          <Loader2 size={14} className="animate-spin" /> Setting up...
        </>
      ) : (
        <>
          {label} <ArrowRight size={14} />
        </>
      )}
    </Button>
  );
}

function ProjectSelector({
  repos,
  reposLoading,
  onLoadRepos,
  form,
  setForm,
  loading,
  onCreateProject,
  tags,
}: {
  repos: Repository[];
  reposLoading: boolean;
  onLoadRepos: () => void;
  form: StepFormState;
  setForm: React.Dispatch<React.SetStateAction<StepFormState>>;
  loading: boolean;
  onCreateProject: () => void;
  tags: string[];
}) {
  const [loaded, setLoaded] = useState(false);

  const handleLoad = () => {
    if (!loaded) {
      setLoaded(true);
      onLoadRepos();
    }
  };

  // Auto-load on mount
  if (!loaded) {
    handleLoad();
  }

  if (tags.includes('use-template')) {
    return (
      <div>
        <p className="text-xs text-fg-muted mb-3">
          After setup, you can create a project from a template on the Projects page.
        </p>
        <ActionButton onClick={onCreateProject} loading={loading} label="Go to Projects" />
      </div>
    );
  }

  return (
    <div>
      {reposLoading ? (
        <div className="flex items-center gap-2 text-sm text-fg-muted py-3">
          <Loader2 size={14} className="animate-spin" /> Loading your repositories...
        </div>
      ) : repos.length === 0 ? (
        <div className="text-sm text-fg-muted py-3">
          <p className="mb-2">No repositories found. Make sure you've installed the GitHub App and granted repo access.</p>
          <Button variant="secondary" size="sm" onClick={onLoadRepos}>
            Refresh
          </Button>
        </div>
      ) : (
        <div className="mb-3">
          <select
            value={form.selectedRepoName}
            onChange={(e) => {
              const repo = repos.find((r) => r.fullName === e.target.value);
              setForm((prev) => ({
                ...prev,
                selectedRepoUrl: repo ? `https://github.com/${repo.fullName}.git` : '',
                selectedRepoName: repo?.fullName ?? '',
              }));
            }}
            className="w-full p-2 rounded-md border border-border-default bg-surface text-fg-primary text-sm"
          >
            <option value="">Select a repository...</option>
            {repos.map((repo) => (
              <option key={repo.id} value={repo.fullName}>
                {repo.fullName}
              </option>
            ))}
          </select>
        </div>
      )}
      {repos.length > 0 && (
        <ActionButton
          onClick={onCreateProject}
          loading={loading}
          disabled={!form.selectedRepoUrl}
          label="Create Project"
        />
      )}
    </div>
  );
}

/* ─── Step action execution ─── */

async function executeStep(
  stepId: StepId,
  form: StepFormState
): Promise<void> {
  switch (stepId) {
    case 'ai-apikey': {
      if (!form.selectedAgent || !form.apiKey.trim()) {
        throw new Error('Please enter an API key');
      }
      const request: SaveAgentCredentialRequest = {
        agentType: form.selectedAgent,
        credentialKind: 'api-key',
        credential: form.apiKey.trim(),
      };
      // Validate first
      const validation = await validateAgentCredential(request);
      if (validation.valid === false) {
        throw new Error(validation.message ??'Invalid API key');
      }
      // Save
      await saveAgentCredential(request);
      return;
    }

    case 'ai-oauth': {
      // For OAuth, we just mark it as done for now — OAuth setup happens in Settings
      // This is a "we'll redirect you" step
      return;
    }

    case 'ai-sam': {
      // SAM billing doesn't require setup — just acknowledge
      return;
    }

    case 'cloud-hetzner': {
      if (!form.hetznerToken.trim()) {
        throw new Error('Please enter your Hetzner API token');
      }
      // Validate
      const validation = await validateCredential({
        provider: 'hetzner',
        token: form.hetznerToken.trim(),
      });
      if (validation.valid === false) {
        throw new Error(validation.message ??'Invalid Hetzner token');
      }
      // Save
      await createCredential({
        provider: 'hetzner',
        token: form.hetznerToken.trim(),
      });
      return;
    }

    case 'cloud-sam': {
      // No action needed — SAM handles infrastructure
      return;
    }

    case 'github': {
      // GitHub install is handled by redirect, not by this function
      return;
    }

    case 'project': {
      // Project creation is handled separately
      return;
    }
  }
}
