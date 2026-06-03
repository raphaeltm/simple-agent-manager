import type { Repository } from '@simple-agent-manager/shared';
import { AGENT_CATALOG } from '@simple-agent-manager/shared';
import { Alert, Button, Card, Input } from '@simple-agent-manager/ui';
import { ArrowRight, Check, ChevronDown, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import {
  getGitHubInstallUrl,
  listGitHubInstallations,
  listRepositories,
} from '../../../lib/api';
import { createProject } from '../../../lib/api/projects';
import type { GeneratedStep, StepId } from './path-generator';
import { ProjectSelector } from './ProjectSelector';
import { executeStep, INITIAL_FORM, type StepFormState } from './step-actions';

interface StepExecutionProps {
  steps: GeneratedStep[];
  tags: string[];
  onComplete: () => void;
  onDismiss: () => void;
}

export function StepExecution({ steps, tags, onComplete, onDismiss }: StepExecutionProps) {
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
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);

  const markStepDone = useCallback(() => {
    const id = step?.id;
    if (!id) return;
    setCompletedSteps((prev) => [...prev, id]);
    setError(null);
    setExpandedDetails(false);
    if (isLast) {
      setTimeout(onComplete, 300);
    } else {
      setCurrentStepIndex((i) => i + 1);
    }
  }, [step?.id, isLast, onComplete]);

  const handleAction = useCallback(async () => {
    if (!step) return;
    setLoading(true);
    setError(null);

    try {
      await executeStep(step.id, form);
      markStepDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [step, form, markStepDone]);

  const handleSkip = useCallback(() => {
    markStepDone();
  }, [markStepDone]);

  const githubPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const githubTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Move focus to step heading when step changes or on initial mount
  useEffect(() => {
    stepHeadingRef.current?.focus();
  }, [currentStepIndex]);

  // Cleanup GitHub poll and timeout on unmount
  useEffect(() => {
    return () => {
      if (githubPollRef.current) clearInterval(githubPollRef.current);
      if (githubTimeoutRef.current) clearTimeout(githubTimeoutRef.current);
    };
  }, []);

  const handleGitHubInstall = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Clear any existing poll before starting a new one (prevents leak on double-click)
      if (githubPollRef.current) clearInterval(githubPollRef.current);
      if (githubTimeoutRef.current) clearTimeout(githubTimeoutRef.current);

      const { url } = await getGitHubInstallUrl();
      window.open(url, '_blank', 'noopener');

      // Poll for GitHub App installation completion
      const poll = setInterval(async () => {
        try {
          const installations = await listGitHubInstallations();
          if (installations.length > 0) {
            clearInterval(poll);
            githubPollRef.current = null;
            if (githubTimeoutRef.current) {
              clearTimeout(githubTimeoutRef.current);
              githubTimeoutRef.current = null;
            }
            setLoading(false);
            markStepDone();
          }
        } catch {
          // Keep polling on failure
        }
      }, 3000);
      githubPollRef.current = poll;

      // Stop polling after 5 minutes and show retry prompt
      githubTimeoutRef.current = setTimeout(() => {
        clearInterval(poll);
        githubPollRef.current = null;
        githubTimeoutRef.current = null;
        setLoading(false);
        setError('Installation not detected. If you completed the installation, click the button to try again.');
      }, 300_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get install URL');
      setLoading(false);
    }
  }, [markStepDone]);

  const handleCreateProject = useCallback(async () => {
    if (!form.selectedRepoUrl || !form.selectedRepoName) {
      setError('Please select a repository');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const selectedRepo = repos.find((r) => r.fullName === form.selectedRepoName);
      if (!selectedRepo) {
        setError('Selected repository not found. Please refresh and try again.');
        setLoading(false);
        return;
      }
      const project = await createProject({
        name: form.selectedRepoName.split('/').pop() || form.selectedRepoName,
        repository: form.selectedRepoUrl,
        installationId: selectedRepo.installationId,
        githubRepoId: selectedRepo.id,
      });
      // Dismiss the wizard (sets localStorage) and navigate directly to the project.
      // Skip the CompletionScreen — the user already has a project to go to.
      onDismiss();
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setLoading(false);
    }
  }, [form.selectedRepoUrl, form.selectedRepoName, repos, onDismiss, navigate]);

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
      setRepos([]);
    } finally {
      setReposLoading(false);
    }
  }, []);

  if (!step) return null;

  return (
    <div className="max-w-md mx-auto">
      {/* Progress header */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-fg-muted">
            Step {currentStepIndex + 1} of {steps.length}
          </span>
          <span className="text-xs text-fg-muted">
            {Math.round(progress)}% complete
          </span>
        </div>
        <div
          role="progressbar"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Setup progress: step ${currentStepIndex + 1} of ${steps.length}`}
          className="w-full h-1.5 bg-accent/10 rounded-full overflow-hidden"
        >
          <div
            className="h-full bg-accent rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
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
      <Card className="p-6 mb-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center text-xs font-bold text-accent">
            {currentStepIndex + 1}
          </div>
          <h3 ref={stepHeadingRef} tabIndex={-1} className="text-lg font-semibold text-fg-primary outline-none">{step.title}</h3>
        </div>
        <p className="text-sm text-fg-muted mb-4 ml-9">{step.description}</p>

        {error && (
          <div className="ml-9 mb-4">
            <Alert variant="error" onDismiss={() => setError(null)}>
              {error}
            </Alert>
          </div>
        )}

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
            onDismiss={onDismiss}
            actionLabel={step.actionLabel}
          />
        </div>

        <div className="ml-9 mt-4">
          <button
            type="button"
            onClick={() => setExpandedDetails(!expandedDetails)}
            aria-expanded={expandedDetails}
            className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg-primary transition-colors bg-transparent border-none cursor-pointer py-2 px-0 min-h-[44px]"
          >
            <ChevronDown
              size={12}
              aria-hidden="true"
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

      {/* Upcoming steps */}
      {!isLast && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-fg-muted uppercase tracking-wide font-medium">
            Coming up
          </p>
          {steps.slice(currentStepIndex + 1).map((s, i) => (
            <div
              key={s.id}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-fg-muted"
            >
              <div className="w-5 h-5 rounded-full bg-accent/5 flex items-center justify-center text-xs">
                {currentStepIndex + 2 + i}
              </div>
              <span>{s.title}</span>
              <span className="ml-auto text-xs text-fg-muted">{s.timeEstimate}</span>
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
  onDismiss: () => void;
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
  onDismiss,
  actionLabel,
}: StepFormProps) {
  // Auto-select default agent for API key step
  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (stepId !== 'ai-apikey' || didAutoSelect.current) return;
    const isAnthropic = tags.includes('anthropic-key') || tags.includes('has-claude');
    const agents = AGENT_CATALOG.filter((a) =>
      isAnthropic ? a.provider === 'anthropic' : a.provider === 'openai'
    );
    const defaultAgent = agents[0];
    if (!form.selectedAgent && defaultAgent) {
      didAutoSelect.current = true;
      setForm((prev) => ({ ...prev, selectedAgent: defaultAgent.id }));
    }
  }, [stepId, tags, form.selectedAgent, setForm]);

  switch (stepId) {
    case 'ai-apikey': {
      const isAnthropic = tags.includes('anthropic-key') || tags.includes('has-claude');
      const agents = AGENT_CATALOG.filter((a) =>
        isAnthropic ? a.provider === 'anthropic' : a.provider === 'openai'
      );
      const defaultAgent = agents[0];

      return (
        <>
          {agents.length > 1 && (
            <div className="mb-3">
              <label className="block text-xs font-medium text-fg-muted mb-1">Agent</label>
              <div className="flex gap-2 flex-wrap">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    aria-pressed={form.selectedAgent === agent.id}
                    onClick={() => setForm((prev) => ({ ...prev, selectedAgent: agent.id }))}
                    className={`px-3 py-2.5 rounded text-xs border cursor-pointer transition-colors min-h-[44px] ${
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
            <label htmlFor="onboarding-api-key" className="block text-xs font-medium text-fg-muted mb-1">
              {isAnthropic ? 'Anthropic' : 'OpenAI'} API key
            </label>
            <Input
              id="onboarding-api-key"
              type="password"
              autoComplete="off"
              value={form.apiKey}
              onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))}
              placeholder={`sk-...`}
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
            Connect your Claude subscription in Settings after completing setup.
            Your existing plan covers all costs.
          </p>
          <ActionButton onClick={onAction} loading={loading} label="Continue" />
        </>
      );

    case 'ai-sam':
      return (
        <>
          <p className="text-xs text-fg-muted mb-3">
            SAM provides AI through Cloudflare. You can set budget limits in Settings after setup.
          </p>
          <ActionButton onClick={onAction} loading={loading} label="Continue" />
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
            <label htmlFor="onboarding-hetzner-token" className="block text-xs font-medium text-fg-muted mb-1">
              Hetzner API token
            </label>
            <Input
              id="onboarding-hetzner-token"
              type="password"
              autoComplete="off"
              value={form.hetznerToken}
              onChange={(e) => setForm((prev) => ({ ...prev, hetznerToken: e.target.value }))}
              placeholder="Paste your token"
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
        <>
          <ActionButton onClick={onGitHubInstall} loading={loading} label={actionLabel} />
          {loading && (
            <p className="text-xs text-fg-muted mt-2">
              Complete the installation in the new tab. This will update automatically.
            </p>
          )}
        </>
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
          onDismiss={onDismiss}
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
