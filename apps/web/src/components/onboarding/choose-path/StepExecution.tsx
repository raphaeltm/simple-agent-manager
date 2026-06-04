import type { Repository } from '@simple-agent-manager/shared';
import { AGENT_CATALOG } from '@simple-agent-manager/shared';
import { Alert, Card } from '@simple-agent-manager/ui';
import { Check, ChevronDown } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import {
  getGitHubInstallUrl,
  listGitHubInstallations,
  listRepositories,
} from '../../../lib/api';
import { createProject } from '../../../lib/api/projects';
import type { GeneratedStep } from './path-generator';
import { executeStep, INITIAL_FORM, type StepFormState } from './step-actions';
import { StepForm } from './StepForm';

/* ─── Constants ─── */

const GITHUB_POLL_INTERVAL_MS = 3_000;
const GITHUB_POLL_TIMEOUT_MS = 300_000; // 5 minutes
const COMPLETION_DELAY_MS = 300;

/* ─── Props ─── */

interface StepExecutionProps {
  steps: GeneratedStep[];
  tags: string[];
  onComplete: () => void;
  onDismiss: () => void;
}

/* ─── Component ─── */

export function StepExecution({ steps, tags, onComplete, onDismiss }: StepExecutionProps) {
  const navigate = useNavigate();
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);
  const [expandedDetails, setExpandedDetails] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<StepFormState>(() => {
    const base = { ...INITIAL_FORM };
    if (steps.some((s) => s.id === 'ai-apikey')) {
      const isAnthropic = tags.includes('anthropic-key') || tags.includes('has-claude');
      const agents = AGENT_CATALOG.filter((a) =>
        isAnthropic ? a.provider === 'anthropic' : a.provider === 'openai'
      );
      if (agents[0]) base.selectedAgent = agents[0].id;
    }
    return base;
  });
  const [repos, setRepos] = useState<Repository[]>([]);
  const [reposLoading, setReposLoading] = useState(false);

  const step = steps[currentStepIndex];
  const isLast = currentStepIndex >= steps.length - 1;
  const progress = steps.length > 0 ? (completedSteps.length / steps.length) * 100 : 0;

  const abortRef = useRef(new AbortController());
  const githubPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const githubTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Focus step heading via ref callback — React re-invokes when currentStepIndex changes
  const stepHeadingRef = useCallback(
    (el: HTMLHeadingElement | null) => el?.focus(),
    [currentStepIndex] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Cleanup ref callback — abort in-flight requests and clear timers when root element unmounts
  const cleanupRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) {
      abortRef.current.abort();
      abortRef.current = new AbortController();
      if (githubPollRef.current) clearInterval(githubPollRef.current);
      if (githubTimeoutRef.current) clearTimeout(githubTimeoutRef.current);
    }
  }, []);

  /* ─── Step lifecycle ─── */

  const markStepDone = useCallback(() => {
    if (!step) return;
    setCompletedSteps((prev) => [...prev, step.id]);
    setError(null);
    setExpandedDetails(false);
    if (isLast) {
      setTimeout(onComplete, COMPLETION_DELAY_MS);
    } else {
      setCurrentStepIndex((i) => i + 1);
    }
  }, [step, isLast, onComplete]);

  const handleAction = useCallback(async () => {
    if (!step) return;
    setLoading(true);
    setError(null);
    try {
      await executeStep(step.id, form);
      if (abortRef.current.signal.aborted) return;
      // Clear credentials from memory after successful submission
      if (step.id === 'ai-apikey') setForm((prev) => ({ ...prev, apiKey: '' }));
      if (step.id === 'cloud-hetzner') setForm((prev) => ({ ...prev, hetznerToken: '' }));
      markStepDone();
    } catch (err) {
      if (abortRef.current.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      if (!abortRef.current.signal.aborted) setLoading(false);
    }
  }, [step, form, markStepDone]);

  const handleSkip = useCallback(() => markStepDone(), [markStepDone]);

  /* ─── GitHub App installation (opens tab, polls for completion) ─── */

  const clearGitHubTimers = useCallback(() => {
    if (githubPollRef.current) { clearInterval(githubPollRef.current); githubPollRef.current = null; }
    if (githubTimeoutRef.current) { clearTimeout(githubTimeoutRef.current); githubTimeoutRef.current = null; }
  }, []);

  const handleGitHubInstall = useCallback(async () => {
    setLoading(true);
    setError(null);
    clearGitHubTimers();

    try {
      const { url } = await getGitHubInstallUrl();
      if (abortRef.current.signal.aborted) return;

      // Validate the URL before opening to prevent open-redirect attacks
      const parsed = new URL(url);
      if (parsed.origin !== 'https://github.com') {
        throw new Error('Unexpected installation URL from server');
      }
      window.open(url, '_blank', 'noopener');

      const poll = setInterval(async () => {
        try {
          const installations = await listGitHubInstallations();
          if (installations.length > 0) {
            clearGitHubTimers();
            setLoading(false);
            markStepDone();
          }
        } catch {
          // Keep polling on transient failures
        }
      }, GITHUB_POLL_INTERVAL_MS);
      githubPollRef.current = poll;

      githubTimeoutRef.current = setTimeout(() => {
        clearGitHubTimers();
        setLoading(false);
        setError('Installation not detected. If you completed the installation, click the button to try again.');
      }, GITHUB_POLL_TIMEOUT_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get install URL');
      setLoading(false);
    }
  }, [markStepDone, clearGitHubTimers]);

  /* ─── Project creation ─── */

  const handleCreateProject = useCallback(async () => {
    if (!form.selectedRepoUrl || !form.selectedRepoName) {
      setError('Please select a repository');
      return;
    }
    const selectedRepo = repos.find((r) => r.fullName === form.selectedRepoName);
    if (!selectedRepo) {
      setError('Selected repository not found. Please refresh and try again.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const project = await createProject({
        name: form.selectedRepoName.split('/').pop() || form.selectedRepoName,
        repository: form.selectedRepoUrl,
        installationId: selectedRepo.installationId,
        githubRepoId: selectedRepo.id,
      });
      if (abortRef.current.signal.aborted) return;
      onDismiss();
      navigate(`/projects/${project.id}`);
    } catch (err) {
      if (abortRef.current.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      if (!abortRef.current.signal.aborted) setLoading(false);
    }
  }, [form.selectedRepoUrl, form.selectedRepoName, repos, onDismiss, navigate]);

  /* ─── Repository loading ─── */

  const loadRepos = useCallback(async () => {
    setReposLoading(true);
    try {
      const installations = await listGitHubInstallations();
      if (abortRef.current.signal.aborted) return;
      if (installations.length === 0) { setRepos([]); return; }

      const allRepos = await Promise.all(
        installations.map((inst) => listRepositories(inst.id).then((r) => r.repositories))
      );
      if (abortRef.current.signal.aborted) return;
      setRepos(allRepos.flat());
    } catch {
      if (!abortRef.current.signal.aborted) setRepos([]);
    } finally {
      if (!abortRef.current.signal.aborted) setReposLoading(false);
    }
  }, []);

  /* ─── Render ─── */

  if (!step) return null;

  return (
    <div ref={cleanupRef} className="max-w-md mx-auto">
      <ProgressHeader
        steps={steps}
        currentStepIndex={currentStepIndex}
        completedSteps={completedSteps}
        progress={progress}
      />

      <Card className="p-6 mb-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center text-xs font-bold text-accent">
            {currentStepIndex + 1}
          </div>
          <h3 ref={stepHeadingRef} tabIndex={-1} className="text-lg font-semibold text-fg-primary outline-none">
            {step.title}
          </h3>
        </div>
        <p className="text-sm text-fg-muted mb-4 ml-9">{step.description}</p>

        {error && (
          <div className="ml-9 mb-4">
            <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
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
            actionLabel={step.actionLabel}
          />
        </div>

        <StepDetails
          details={step.details}
          expanded={expandedDetails}
          onToggle={() => setExpandedDetails(!expandedDetails)}
        />
      </Card>

      {!isLast && (
        <UpcomingSteps steps={steps} currentStepIndex={currentStepIndex} />
      )}
    </div>
  );
}

/* ─── Sub-components ─── */

function ProgressHeader({
  steps,
  currentStepIndex,
  completedSteps,
  progress,
}: {
  steps: GeneratedStep[];
  currentStepIndex: number;
  completedSteps: string[];
  progress: number;
}) {
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-fg-muted">
          Step {currentStepIndex + 1} of {steps.length}
        </span>
        <span className="text-xs text-fg-muted">{Math.round(progress)}% complete</span>
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
      <div className="flex gap-1 mt-2" aria-hidden="true">
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
  );
}

function StepDetails({
  details,
  expanded,
  onToggle,
}: {
  details: string[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="ml-9 mt-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg-primary transition-colors bg-transparent border-none cursor-pointer py-2 px-0 min-h-[44px]"
      >
        <ChevronDown
          size={12}
          aria-hidden="true"
          className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
        {expanded ? 'Hide' : 'Show'} details
      </button>
      {expanded && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {details.map((detail, i) => (
            <li key={i} className="text-xs text-fg-muted flex items-start gap-2">
              <Check size={10} className="text-accent/50 mt-0.5 shrink-0" />
              {detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UpcomingSteps({
  steps,
  currentStepIndex,
}: {
  steps: GeneratedStep[];
  currentStepIndex: number;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-fg-muted uppercase tracking-wide font-medium">Coming up</p>
      {steps.slice(currentStepIndex + 1).map((s, i) => (
        <div key={s.id} className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-fg-muted">
          <div className="w-5 h-5 rounded-full bg-accent/5 flex items-center justify-center text-xs">
            {currentStepIndex + 2 + i}
          </div>
          <span>{s.title}</span>
          <span className="ml-auto text-xs text-fg-muted">{s.timeEstimate}</span>
        </div>
      ))}
    </div>
  );
}
