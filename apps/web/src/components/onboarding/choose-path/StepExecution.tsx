import type { AgentType, Repository } from '@simple-agent-manager/shared';
import { Alert, Button } from '@simple-agent-manager/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Github } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import {
  createAgentProfile,
  getGitHubInstallUrl,
  listGitHubInstallations,
  listRepositories,
} from '../../../lib/api';
import { createProject } from '../../../lib/api/projects';
import { CloudProviderConnectFlow } from '../../CloudProviderConnectFlow';
import { AgentStep } from './AgentStep';
import { FieldLabel, SamSays, StepRail, WELL_INPUT_CLASS } from './OnboardingParts';
import type { GeneratedStep } from './path-generator';
import { ProjectSelector } from './ProjectSelector';
import type { RuntimeChoice } from './questions';
import {
  firstProfileRequest,
  INITIAL_FORM,
  saveAgentConnection,
  type StepFormState,
} from './step-actions';

const GITHUB_POLL_INTERVAL_MS = 3_000;
const GITHUB_POLL_TIMEOUT_MS = 300_000; // 5 minutes

interface StepExecutionProps {
  steps: GeneratedStep[];
  /** Where agents run; decides the first profile's runtime. */
  runtime: RuntimeChoice | undefined;
  /** The project step creates a SAM-hosted repository rather than picking a GitHub one. */
  hostedRepo: boolean;
  /** SAM-managed AI is enabled on this installation. */
  samAvailable: boolean;
  /** Every step is done; `projectId` is the project created here, if any. */
  onComplete: (projectId: string | null) => void;
}

export function StepExecution({
  steps,
  runtime,
  hostedRepo,
  samAvailable,
  onComplete,
}: StepExecutionProps) {
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<StepFormState>(INITIAL_FORM);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [reposLoading, setReposLoading] = useState(false);

  const step = steps[index];
  const abortRef = useRef(new AbortController());
  const githubPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const githubTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Move focus to the heading on every step, so keyboard and screen-reader users follow along.
  const headingRef = useCallback(
    (el: HTMLHeadingElement | null) => el?.focus(),
    [index] // eslint-disable-line react-hooks/exhaustive-deps -- index re-creates the ref callback so React re-focuses on each step
  );

  // Abort in-flight requests and clear timers when the steps unmount.
  const cleanupRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) {
      abortRef.current.abort();
      abortRef.current = new AbortController();
      if (githubPollRef.current) clearInterval(githubPollRef.current);
      if (githubTimeoutRef.current) clearTimeout(githubTimeoutRef.current);
    }
  }, []);

  const queryClient = useQueryClient();
  const next = useCallback(
    (projectId: string | null = null) => {
      setError(null);
      // Each step changed what the app knows (credentials, installations, projects, profiles);
      // refresh what is cached so setup status and the first chat see it.
      void queryClient.invalidateQueries();
      if (index >= steps.length - 1) onComplete(projectId);
      else setIndex((i) => i + 1);
    },
    [index, steps.length, onComplete, queryClient]
  );

  /* ─── Agent ─── */

  const saveAgent = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await saveAgentConnection(form);
      if (abortRef.current.signal.aborted) return;
      setForm((prev) => ({ ...prev, apiKey: '', oauthToken: '' }));
      next();
    } catch (err) {
      if (!abortRef.current.signal.aborted)
        setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      if (!abortRef.current.signal.aborted) setLoading(false);
    }
  }, [form, next]);

  // The guided sign-in saved the credential itself. Drop anything typed into the manual fields
  // too, as a manual save does.
  const agentConnected = useCallback(() => {
    setForm((prev) => ({ ...prev, apiKey: '', oauthToken: '' }));
    next();
  }, [next]);

  /* ─── GitHub App installation (opens a tab, polls for completion) ─── */

  const clearGitHubTimers = useCallback(() => {
    if (githubPollRef.current) clearInterval(githubPollRef.current);
    if (githubTimeoutRef.current) clearTimeout(githubTimeoutRef.current);
    githubPollRef.current = null;
    githubTimeoutRef.current = null;
  }, []);

  const installGitHub = useCallback(async () => {
    setLoading(true);
    setError(null);
    clearGitHubTimers();
    try {
      const { url } = await getGitHubInstallUrl();
      if (abortRef.current.signal.aborted) return;
      // Open only GitHub: the URL comes from the server, so check it before following it.
      if (new URL(url).origin !== 'https://github.com') {
        throw new Error('Unexpected installation URL from server');
      }
      window.open(url, '_blank', 'noopener');
      githubPollRef.current = setInterval(async () => {
        try {
          if ((await listGitHubInstallations()).length > 0) {
            clearGitHubTimers();
            setLoading(false);
            next();
          }
        } catch {
          // Keep polling through transient failures.
        }
      }, GITHUB_POLL_INTERVAL_MS);
      githubTimeoutRef.current = setTimeout(() => {
        clearGitHubTimers();
        setLoading(false);
        setError("I didn't see the installation finish. If you completed it, try once more.");
      }, GITHUB_POLL_TIMEOUT_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get the install link');
      setLoading(false);
    }
  }, [next, clearGitHubTimers]);

  /* ─── Project ─── */

  const loadRepos = useCallback(async () => {
    setReposLoading(true);
    try {
      const installations = await listGitHubInstallations();
      if (abortRef.current.signal.aborted) return;
      const lists = await Promise.all(
        installations.map((inst) => listRepositories(inst.id).then((r) => r.repositories))
      );
      if (!abortRef.current.signal.aborted) setRepos(lists.flat());
    } catch {
      if (!abortRef.current.signal.aborted) setRepos([]);
    } finally {
      if (!abortRef.current.signal.aborted) setReposLoading(false);
    }
  }, []);

  const createFirstProject = useCallback(async () => {
    let request: Parameters<typeof createProject>[0];
    if (hostedRepo) {
      const name = form.hostedProjectName.trim();
      if (!name) {
        setError('Give your project a name');
        return;
      }
      // SAM creates the repository on Cloudflare Artifacts; no GitHub involved.
      request = { name, repoProvider: 'artifacts', defaultBranch: 'main' };
    } else {
      const repo = repos.find((r) => r.fullName === form.selectedRepoName);
      if (!repo) {
        setError('Pick a repository');
        return;
      }
      request = {
        name: repo.name,
        repository: repo.fullName,
        installationId: repo.installationId,
        githubRepoId: repo.id,
        defaultBranch: repo.defaultBranch,
      };
    }
    setLoading(true);
    setError(null);
    try {
      const project = await createProject(request);
      if (abortRef.current.signal.aborted) return;
      // Give the project a profile for the agent and runtime chosen here, so its first chat
      // starts straight away. If that fails, the chat's own profile wizard still covers it.
      if (form.selectedAgent && runtime) {
        try {
          await createAgentProfile(
            project.id,
            firstProfileRequest(form.selectedAgent as AgentType, runtime)
          );
        } catch (err) {
          console.warn('Onboarding could not create the first profile', {
            projectId: project.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (!abortRef.current.signal.aborted) next(project.id);
    } catch (err) {
      if (!abortRef.current.signal.aborted)
        setError(err instanceof Error ? err.message : 'Failed to create the project');
    } finally {
      if (!abortRef.current.signal.aborted) setLoading(false);
    }
  }, [hostedRepo, form, repos, runtime, next]);

  if (!step) return null;

  return (
    <div ref={cleanupRef}>
      <StepRail labels={steps.map((s) => s.label)} current={index} />
      <SamSays title={step.title} headingRef={headingRef}>
        {step.id === 'project' && hostedRepo
          ? "Name it and I'll create its Git repository for you. No GitHub needed."
          : step.description}
      </SamSays>

      {error && (
        <div className="mb-4">
          <Alert variant="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        </div>
      )}

      {step.id === 'agent' && (
        <AgentStep
          form={form}
          setForm={setForm}
          samAvailable={samAvailable}
          saving={loading}
          onSave={() => void saveAgent()}
          onConnected={agentConnected}
        />
      )}

      {step.id === 'cloud' && <CloudProviderConnectFlow onConnected={() => next()} />}

      {step.id === 'github' && (
        <div>
          <Button
            variant="accent"
            size="lg"
            className="w-full sm:w-auto"
            onClick={() => void installGitHub()}
            loading={loading}
          >
            <Github className="h-4 w-4" aria-hidden="true" />
            Install the GitHub app
          </Button>
          {loading && (
            <p role="status" className="mb-0 mt-3 text-sm text-fg-muted">
              Finish in the new tab. I&apos;ll notice when it&apos;s done.
            </p>
          )}
        </div>
      )}

      {step.id === 'project' && hostedRepo && (
        <div>
          <FieldLabel htmlFor="onboarding-hosted-project-name">Project name</FieldLabel>
          <input
            id="onboarding-hosted-project-name"
            value={form.hostedProjectName}
            maxLength={100}
            autoComplete="off"
            onChange={(e) => setForm((prev) => ({ ...prev, hostedProjectName: e.target.value }))}
            placeholder="my-first-project"
            className={WELL_INPUT_CLASS}
          />
          <Button
            variant="accent"
            size="lg"
            className="mt-4 w-full sm:w-auto"
            onClick={() => void createFirstProject()}
            disabled={!form.hostedProjectName.trim()}
            loading={loading}
          >
            Create project
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      )}

      {step.id === 'project' && !hostedRepo && (
        <ProjectSelector
          repos={repos}
          reposLoading={reposLoading}
          onLoadRepos={() => void loadRepos()}
          form={form}
          setForm={setForm}
          loading={loading}
          onCreateProject={() => void createFirstProject()}
        />
      )}
    </div>
  );
}
