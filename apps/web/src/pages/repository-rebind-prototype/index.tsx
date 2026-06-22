import type {
  AddProjectRepositoryRequest,
  ProjectDetailResponse,
  ProjectRepository,
  ProjectRuntimeConfigResponse,
  UpdateProjectRequest,
} from '@simple-agent-manager/shared';
import { Alert, Button, Dialog, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  GitBranch,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { ProjectSettings } from '../ProjectSettings';
import { ProjectContext } from '../ProjectContext';
import {
  availableAdditionalRepositories,
  initialAdditionalRepositories,
  initialRepositoryStatus,
  mockAgents,
  mockCredentials,
  mockCurrentInstallationId,
  mockInstallations,
  mockProject,
  mockProjectAgentCredentials,
  mockProviderCatalog,
  mockRepositoryList,
  mockResolutionStatus,
  mockRuntimeConfig,
  mockUserAgentCredentials,
  repositoryChoices,
  submoduleSuggestions,
  type MockRepositoryChoice,
  type MockRepositoryStatus,
  type RepositoryHealth,
} from './mock-data';

function delay(ms = 240): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function notFoundResponse(pathname: string): Response {
  return jsonResponse(
    { error: 'NOT_FOUND', message: `Prototype endpoint not found: ${pathname}` },
    404
  );
}

function nextUpdatedAt(): string {
  return new Date().toISOString();
}

function normalizeRepository(repository: string): string {
  return repository.trim().toLowerCase();
}

function useProjectSettingsMockTransport({
  projectRef,
  additionalRepositoriesRef,
  runtimeConfigRef,
  setProject,
  setAdditionalRepositories,
  setRuntimeConfig,
}: {
  projectRef: MutableRefObject<ProjectDetailResponse>;
  additionalRepositoriesRef: MutableRefObject<ProjectRepository[]>;
  runtimeConfigRef: MutableRefObject<ProjectRuntimeConfigResponse>;
  setProject: Dispatch<SetStateAction<ProjectDetailResponse>>;
  setAdditionalRepositories: Dispatch<SetStateAction<ProjectRepository[]>>;
  setRuntimeConfig: Dispatch<SetStateAction<ProjectRuntimeConfigResponse>>;
}) {
  if (typeof window !== 'undefined') {
    const win = window as Window & {
      __repositoryRebindPrototypeOriginalFetch?: typeof window.fetch;
    };
    if (!win.__repositoryRebindPrototypeOriginalFetch) {
      win.__repositoryRebindPrototypeOriginalFetch = window.fetch.bind(window);
    }
    const originalFetch = win.__repositoryRebindPrototypeOriginalFetch;

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlText =
        typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
      const url = new URL(urlText, window.location.href);
      const path = url.pathname;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (!path.startsWith('/api/')) {
        return originalFetch(input, init);
      }

      await delay(method === 'GET' ? 180 : 420);

      if (path === '/api/providers/catalog' && method === 'GET') {
        return jsonResponse(mockProviderCatalog);
      }

      if (path === '/api/credentials' && method === 'GET') {
        return jsonResponse(mockCredentials);
      }

      if (path === '/api/credentials/resolution-status' && method === 'GET') {
        return jsonResponse(mockResolutionStatus);
      }

      if (path === '/api/agents' && method === 'GET') {
        return jsonResponse({ agents: mockAgents });
      }

      if (path === '/api/credentials/agent' && method === 'GET') {
        return jsonResponse({ credentials: mockUserAgentCredentials });
      }

      if (path.endsWith('/credentials') && path.startsWith('/api/projects/')) {
        if (method === 'GET') return jsonResponse({ credentials: mockProjectAgentCredentials });
        if (method === 'PUT') return jsonResponse(mockProjectAgentCredentials[0]);
      }

      const projectPath = `/api/projects/${encodeURIComponent(projectRef.current.id)}`;
      if (path === projectPath && method === 'PATCH') {
        const body = (await readJsonBody<UpdateProjectRequest>(init)) ?? {};
        const nextProject = {
          ...projectRef.current,
          ...body,
          updatedAt: nextUpdatedAt(),
        };
        setProject(nextProject);
        return jsonResponse(nextProject);
      }

      if (path === projectPath && method === 'DELETE') {
        return jsonResponse({ success: true });
      }

      if (path === `${projectPath}/repository-access/available` && method === 'GET') {
        const added = new Set(
          additionalRepositoriesRef.current.map((repo) => normalizeRepository(repo.repository))
        );
        const repositories = availableAdditionalRepositories.filter(
          (repo) => !added.has(normalizeRepository(repo.repository))
        );
        return jsonResponse({ repositories });
      }

      if (path === `${projectPath}/repository-access/discover` && method === 'GET') {
        return jsonResponse({ suggestions: submoduleSuggestions });
      }

      if (path === `${projectPath}/repository-access`) {
        if (method === 'GET') {
          return jsonResponse({
            primaryRepository: projectRef.current.repository,
            repositories: additionalRepositoriesRef.current,
          });
        }

        if (method === 'POST') {
          const body = await readJsonBody<AddProjectRepositoryRequest>(init);
          const repository = body?.repository?.trim() ?? '';
          if (!repository) {
            return jsonResponse({ error: 'BAD_REQUEST', message: 'Repository is required' }, 400);
          }
          const repo = {
            id: `repo-row-${Date.now()}`,
            repository,
            githubRepoId: 1400000000 + additionalRepositoriesRef.current.length,
            githubRepoNodeId: `R_kgDOPrototype${additionalRepositoriesRef.current.length}`,
            status: 'active' as const,
            createdAt: nextUpdatedAt(),
            updatedAt: nextUpdatedAt(),
          };
          setAdditionalRepositories((prev) => [...prev, repo]);
          return jsonResponse({
            primaryRepository: projectRef.current.repository,
            repositories: [...additionalRepositoriesRef.current, repo],
          });
        }
      }

      if (path.startsWith(`${projectPath}/repository-access/`) && method === 'DELETE') {
        const rowId = decodeURIComponent(path.slice(`${projectPath}/repository-access/`.length));
        const nextRepositories = additionalRepositoriesRef.current.filter(
          (repo) => repo.id !== rowId
        );
        setAdditionalRepositories(nextRepositories);
        return jsonResponse({
          primaryRepository: projectRef.current.repository,
          repositories: nextRepositories,
        });
      }

      if (path === `${projectPath}/runtime-config` && method === 'GET') {
        return jsonResponse(runtimeConfigRef.current);
      }

      if (path === `${projectPath}/runtime/env-vars` && method === 'POST') {
        const body = await readJsonBody<{ key: string; value: string; isSecret?: boolean }>(init);
        if (!body?.key?.trim()) {
          return jsonResponse({ error: 'BAD_REQUEST', message: 'Key is required' }, 400);
        }
        const nextConfig = {
          ...runtimeConfigRef.current,
          envVars: [
            ...runtimeConfigRef.current.envVars.filter((item) => item.key !== body.key.trim()),
            {
              key: body.key.trim(),
              value: body.isSecret ? null : body.value,
              isSecret: !!body.isSecret,
              hasValue: true,
              createdAt: nextUpdatedAt(),
              updatedAt: nextUpdatedAt(),
            },
          ],
        };
        setRuntimeConfig(nextConfig);
        return jsonResponse(nextConfig);
      }

      if (path.startsWith(`${projectPath}/runtime/env-vars/`) && method === 'DELETE') {
        const key = decodeURIComponent(path.slice(`${projectPath}/runtime/env-vars/`.length));
        const nextConfig = {
          ...runtimeConfigRef.current,
          envVars: runtimeConfigRef.current.envVars.filter((item) => item.key !== key),
        };
        setRuntimeConfig(nextConfig);
        return jsonResponse(nextConfig);
      }

      if (path === `${projectPath}/runtime/files` && method === 'POST') {
        const body = await readJsonBody<{ path: string; content: string; isSecret?: boolean }>(
          init
        );
        if (!body?.path?.trim()) {
          return jsonResponse({ error: 'BAD_REQUEST', message: 'Path is required' }, 400);
        }
        const nextConfig = {
          ...runtimeConfigRef.current,
          files: [
            ...runtimeConfigRef.current.files.filter((item) => item.path !== body.path.trim()),
            {
              path: body.path.trim(),
              content: body.isSecret ? null : body.content,
              isSecret: !!body.isSecret,
              hasValue: true,
              createdAt: nextUpdatedAt(),
              updatedAt: nextUpdatedAt(),
            },
          ],
        };
        setRuntimeConfig(nextConfig);
        return jsonResponse(nextConfig);
      }

      if (path === `${projectPath}/runtime/files` && method === 'DELETE') {
        const filePath = url.searchParams.get('path') ?? '';
        const nextConfig = {
          ...runtimeConfigRef.current,
          files: runtimeConfigRef.current.files.filter((item) => item.path !== filePath),
        };
        setRuntimeConfig(nextConfig);
        return jsonResponse(nextConfig);
      }

      if (path === `${projectPath}/deployment/gcp` && method === 'GET') {
        return jsonResponse({ connected: false });
      }

      if (path === `${projectPath}/deployment/gcp` && method === 'DELETE') {
        return jsonResponse({ success: true });
      }

      if (path === `${projectPath}/deployment/gcp/projects` && method === 'POST') {
        return jsonResponse({
          projects: [
            {
              projectId: 'smallpath-production',
              name: 'Smallpath Production',
              projectNumber: '112233445566',
            },
            {
              projectId: 'smallpath-preview',
              name: 'Smallpath Preview',
              projectNumber: '665544332211',
            },
          ],
        });
      }

      if (path === `${projectPath}/deployment/gcp/setup` && method === 'POST') {
        return jsonResponse({
          success: true,
          credential: {
            connected: true,
            provider: 'gcp',
            gcpProjectId: 'smallpath-production',
            serviceAccountEmail: 'sam-deploy@smallpath-production.iam.gserviceaccount.com',
            createdAt: nextUpdatedAt(),
          },
        });
      }

      if (path === '/api/github/repositories' && method === 'GET') {
        const installationId = url.searchParams.get('installation_id');
        return jsonResponse({
          repositories: installationId
            ? mockRepositoryList.filter((repo) => repo.installationId === installationId)
            : mockRepositoryList,
        });
      }

      if (path === '/api/github/branches' && method === 'GET') {
        const repository = url.searchParams.get('repository') ?? '';
        const choice = repositoryChoices.find(
          (repo) => normalizeRepository(repo.repository) === normalizeRepository(repository)
        );
        return jsonResponse({
          branches: (choice?.branches ?? ['main']).map((name) => ({
            name,
            isDefault: name === (choice?.defaultBranch ?? 'main'),
          })),
        });
      }

      if (path === '/api/t' || path === '/api/client-errors') {
        return jsonResponse({ success: true });
      }

      return notFoundResponse(path);
    };
  }
}

async function readJsonBody<T>(init?: RequestInit): Promise<T | null> {
  if (!init?.body || typeof init.body !== 'string') return null;
  try {
    return JSON.parse(init.body) as T;
  } catch {
    return null;
  }
}

export function RepositoryRebindPrototype() {
  const [project, setProject] = useState<ProjectDetailResponse>(mockProject);
  const [repositoryStatus, setRepositoryStatus] =
    useState<MockRepositoryStatus>(initialRepositoryStatus);
  const [additionalRepositories, setAdditionalRepositories] = useState<ProjectRepository[]>(
    initialAdditionalRepositories
  );
  const [runtimeConfig, setRuntimeConfig] =
    useState<ProjectRuntimeConfigResponse>(mockRuntimeConfig);

  const projectRef = useLatestRef(project);
  const additionalRepositoriesRef = useLatestRef(additionalRepositories);
  const runtimeConfigRef = useLatestRef(runtimeConfig);

  useProjectSettingsMockTransport({
    projectRef,
    additionalRepositoriesRef,
    runtimeConfigRef,
    setProject,
    setAdditionalRepositories,
    setRuntimeConfig,
  });

  const reload = useCallback(async () => {
    await delay(140);
  }, []);

  const rebindRepository = useCallback(
    async (choice: MockRepositoryChoice, branch: string) => {
      await delay(700);
      const storedRepository = normalizeRepository(choice.repository);
      setProject((prev) => ({
        ...prev,
        installationId: choice.installationId,
        repository: storedRepository,
        defaultBranch: branch,
        status: 'active',
        updatedAt: nextUpdatedAt(),
      }));
      setRepositoryStatus({
        health: 'active',
        storedRepository,
        liveRepository: choice.repository,
        installationAccount: choice.installationAccount,
        storedGitHubRepoId: choice.githubRepoId,
        liveGitHubRepoId: choice.githubRepoId,
        storedGitHubRepoNodeId: choice.githubRepoNodeId,
        liveGitHubRepoNodeId: choice.githubRepoNodeId,
        checkedAt: nextUpdatedAt(),
        message:
          'Repository access is verified through your GitHub authorization and the selected installation.',
        activeWorkspaces: 0,
        inProgressTasks: 0,
        activeTriggers: repositoryStatus.activeTriggers,
      });
    },
    [repositoryStatus.activeTriggers]
  );

  const contextValue = useMemo(
    () => ({
      projectId: project.id,
      project,
      installations: mockInstallations,
      reload,
    }),
    [project, reload]
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('section') !== 'repository') return;
    const scrollTimer = window.setTimeout(() => {
      document.getElementById('repository-identity-section')?.scrollIntoView({ block: 'start' });
    }, 700);
    return () => window.clearTimeout(scrollTimer);
  }, []);

  return (
    <div style={{ height: '100vh', overflow: 'auto' }}>
      <div className="min-h-screen min-w-0 overflow-x-hidden">
        <main
          aria-label={`${project.name} settings prototype`}
          className="max-w-[80rem] w-full mx-auto min-w-0 p-3 sm:px-4 sm:py-8"
        >
          <ProjectContext.Provider value={contextValue}>
            <div className="flex flex-col flex-1 min-h-0 mt-3">
              <ProjectSettings
                repositoryIdentitySection={
                  <RepositoryIdentitySection
                    project={project}
                    status={repositoryStatus}
                    additionalRepositoryCount={additionalRepositories.length}
                    onRefresh={() => {
                      setRepositoryStatus((prev) => ({
                        ...prev,
                        checkedAt: nextUpdatedAt(),
                      }));
                    }}
                    onRebind={rebindRepository}
                  />
                }
              />
            </div>
          </ProjectContext.Provider>
        </main>
      </div>
    </div>
  );
}

function RepositoryIdentitySection({
  project,
  status,
  additionalRepositoryCount,
  onRefresh,
  onRebind,
}: {
  project: ProjectDetailResponse;
  status: MockRepositoryStatus;
  additionalRepositoryCount: number;
  onRefresh: () => void;
  onRebind: (choice: MockRepositoryChoice, branch: string) => Promise<void>;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('modal') === '1') {
      setDialogOpen(true);
    }
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await delay(450);
    onRefresh();
    setRefreshing(false);
  };

  return (
    <section id="repository-identity-section" className="glass-surface rounded-lg p-4 grid gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="sam-type-section-heading m-0 text-fg-primary">Repository</h2>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            The primary GitHub repository used for new workspaces, tasks, branch defaults, and
            repository-scoped tokens.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
          >
            <span className="inline-flex items-center gap-1.5">
              {refreshing ? <Spinner size="sm" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Check
            </span>
          </Button>
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <span className="inline-flex items-center gap-1.5">
              <GitBranch className="h-3.5 w-3.5" />
              Change
            </span>
          </Button>
        </div>
      </div>

      <RepositoryHealthBanner status={status} />

      <div className="grid gap-2 sm:grid-cols-2">
        <RepositoryFact label="Stored repository" value={status.storedRepository} />
        <RepositoryFact label="GitHub reports" value={status.liveRepository} />
        <RepositoryFact label="Default branch" value={project.defaultBranch} />
        <RepositoryFact label="Installation" value={status.installationAccount} />
      </div>

      <details className="rounded-sm border border-border-default bg-inset">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-fg-secondary">
          Diagnostic details
        </summary>
        <div className="grid gap-2 border-t border-border-default px-3 py-2 text-xs text-fg-muted sm:grid-cols-2">
          <RepositoryFact
            label="Stored repo ID"
            value={String(status.storedGitHubRepoId)}
            compact
          />
          <RepositoryFact
            label="Live repo ID"
            value={status.liveGitHubRepoId?.toString() ?? 'Unavailable'}
            compact
          />
          <RepositoryFact
            label="Stored node ID"
            value={status.storedGitHubRepoNodeId ?? 'Not stored'}
            compact
          />
          <RepositoryFact
            label="Live node ID"
            value={status.liveGitHubRepoNodeId ?? 'Unavailable'}
            compact
          />
          <RepositoryFact label="Last checked" value={formatTimestamp(status.checkedAt)} compact />
          <RepositoryFact
            label="Additional repos"
            value={String(additionalRepositoryCount)}
            compact
          />
        </div>
      </details>

      <RepositoryRebindDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        project={project}
        status={status}
        additionalRepositoryCount={additionalRepositoryCount}
        onRebind={async (choice, branch) => {
          await onRebind(choice, branch);
          setDialogOpen(false);
        }}
      />
    </section>
  );
}

function RepositoryHealthBanner({ status }: { status: MockRepositoryStatus }) {
  if (status.health === 'active') {
    return (
      <div className="flex items-start gap-2 rounded-sm border border-success bg-[color-mix(in_srgb,var(--sam-color-success)_12%,transparent)] px-3 py-2">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg-primary">Access verified</span>
            <StatusBadge status="healthy" label="active" />
          </div>
          <p className="m-0 mt-1 text-xs text-fg-muted">{status.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-sm border border-warning bg-[color-mix(in_srgb,var(--sam-color-warning)_12%,transparent)] px-3 py-2">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-fg-primary">{healthLabel(status.health)}</span>
          <StatusBadge status="stale" label="needs review" />
        </div>
        <p className="m-0 mt-1 text-xs text-fg-muted">{status.message}</p>
      </div>
    </div>
  );
}

function RepositoryFact({
  label,
  value,
  compact,
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  return (
    <div
      className={compact ? 'min-w-0' : 'min-w-0 rounded-sm border border-border-default px-3 py-2'}
    >
      <div className="text-[0.6875rem] uppercase text-fg-muted">{label}</div>
      <code className="mt-0.5 block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] font-semibold text-fg-primary">
        {value}
      </code>
    </div>
  );
}

function RepositoryRebindDialog({
  isOpen,
  onClose,
  project,
  status,
  additionalRepositoryCount,
  onRebind,
}: {
  isOpen: boolean;
  onClose: () => void;
  project: ProjectDetailResponse;
  status: MockRepositoryStatus;
  additionalRepositoryCount: number;
  onRebind: (choice: MockRepositoryChoice, branch: string) => Promise<void>;
}) {
  const initialChoice =
    repositoryChoices.find((choice) => choice.recommended) ??
    repositoryChoices.find((choice) => !choice.disabledReason) ??
    repositoryChoices[0]!;
  const [installationId, setInstallationId] = useState(initialChoice.installationId);
  const [query, setQuery] = useState('');
  const [selectedChoice, setSelectedChoice] = useState(initialChoice);
  const [branch, setBranch] = useState(initialChoice.defaultBranch);
  const [confirmText, setConfirmText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setInstallationId(initialChoice.installationId);
    setSelectedChoice(initialChoice);
    setBranch(initialChoice.defaultBranch);
    setConfirmText('');
    setQuery('');
  }, [initialChoice, isOpen]);

  const filteredChoices = repositoryChoices.filter((choice) => {
    if (choice.installationId !== installationId) return false;
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return true;
    return (
      choice.repository.toLowerCase().includes(normalizedQuery) ||
      choice.description.toLowerCase().includes(normalizedQuery)
    );
  });

  const canSubmit =
    confirmText.trim() === selectedChoice.repository &&
    !selectedChoice.disabledReason &&
    !saving &&
    branch.trim().length > 0;

  const handleInstallationChange = (nextInstallationId: string) => {
    setInstallationId(nextInstallationId);
    const nextChoice =
      repositoryChoices.find(
        (choice) => choice.installationId === nextInstallationId && !choice.disabledReason
      ) ?? repositoryChoices.find((choice) => choice.installationId === nextInstallationId);
    if (nextChoice) {
      setSelectedChoice(nextChoice);
      setBranch(nextChoice.defaultBranch);
      setConfirmText('');
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await onRebind(selectedChoice, branch);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="lg"
      stickyHeader={
        <div className="flex items-start justify-between gap-3 border-b border-border-default px-5 py-4">
          <div className="min-w-0">
            <h2 id="dialog-title" className="m-0 text-base font-semibold text-fg-primary">
              Change Repository
            </h2>
            <p className="m-0 mt-1 text-xs text-fg-muted">
              Rebind this project to a verified GitHub repository.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-border-default bg-transparent text-fg-muted hover:text-fg-primary"
            aria-label="Close"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <div className="grid gap-4">
        <Alert variant={status.health === 'id-mismatch' ? 'warning' : 'info'}>
          {status.health === 'id-mismatch'
            ? 'The current repository name is visible through GitHub, but its repository ID no longer matches the project record.'
            : 'Only repositories visible through both your GitHub account and the selected GitHub App installation are selectable.'}
        </Alert>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(18rem,0.95fr)]">
          <div className="grid gap-4">
            <div className="grid gap-2">
              <h3 className="sam-type-card-title m-0 text-fg-primary">Installation</h3>
              <div className="grid gap-2">
                {mockInstallations.map((installation) => {
                  const active = installation.id === installationId;
                  return (
                    <button
                      key={installation.id}
                      type="button"
                      onClick={() => handleInstallationChange(installation.id)}
                      aria-pressed={active}
                      className={`grid min-w-0 gap-1 rounded-sm border px-3 py-2 text-left transition-colors ${
                        active
                          ? 'border-accent bg-accent-tint'
                          : 'border-border-default bg-inset hover:border-border-strong'
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-fg-primary">
                          {installation.accountName}
                        </span>
                        {installation.id === mockCurrentInstallationId && (
                          <span className="rounded-sm bg-inset px-1.5 py-px text-[0.6875rem] text-fg-muted">
                            current
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-fg-muted">
                        {installation.accountType} installation #{installation.installationId}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="sam-type-card-title m-0 text-fg-primary">Repository</h3>
                <span className="text-xs text-fg-muted">{filteredChoices.length} available</span>
              </div>
              <label className="relative block">
                <span className="sr-only">Search repositories</span>
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder="Search owner/repo"
                  className="block min-h-9 w-full rounded-sm border border-border-default bg-inset py-1.5 pl-8 pr-2.5 text-[0.8125rem] text-fg-primary"
                />
              </label>
              <div className="max-h-72 overflow-y-auto rounded-sm border border-border-default">
                {filteredChoices.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-fg-muted">
                    No repositories match this installation.
                  </div>
                ) : (
                  filteredChoices.map((choice, index) => (
                    <RepositoryChoiceButton
                      key={choice.repository}
                      choice={choice}
                      selected={choice.repository === selectedChoice.repository}
                      isLast={index === filteredChoices.length - 1}
                      onSelect={() => {
                        if (choice.disabledReason) return;
                        setSelectedChoice(choice);
                        setBranch(choice.defaultBranch);
                        setConfirmText('');
                      }}
                    />
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="grid content-start gap-4">
            <div className="grid gap-2">
              <h3 className="sam-type-card-title m-0 text-fg-primary">Default Branch</h3>
              <select
                value={branch}
                onChange={(event) => setBranch(event.currentTarget.value)}
                className="min-h-9 rounded-sm border border-border-default bg-inset px-2.5 py-1.5 text-[0.8125rem] text-fg-primary"
              >
                {selectedChoice.branches.map((branchName) => (
                  <option key={branchName} value={branchName}>
                    {branchName}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-3 rounded-sm border border-border-default px-3 py-3">
              <h3 className="sam-type-card-title m-0 text-fg-primary">Review</h3>
              <RepositoryReviewRow label="From" value={project.repository} />
              <div className="flex justify-center text-fg-muted">
                <ArrowRight className="h-4 w-4" />
              </div>
              <RepositoryReviewRow
                label="To"
                value={normalizeRepository(selectedChoice.repository)}
              />
              <RepositoryReviewRow
                label="Stored repo ID"
                value={String(status.storedGitHubRepoId)}
              />
              <RepositoryReviewRow
                label="Verified repo ID"
                value={String(selectedChoice.githubRepoId)}
              />
              <RepositoryReviewRow
                label="Installation"
                value={selectedChoice.installationAccount}
              />
            </div>

            <div className="grid gap-2 rounded-sm border border-border-default bg-inset px-3 py-3 text-xs text-fg-muted">
              <ImpactItem icon={<ShieldCheck className="h-3.5 w-3.5" />}>
                New workspace tokens will use the selected repository after confirmation.
              </ImpactItem>
              <ImpactItem icon={<GitBranch className="h-3.5 w-3.5" />}>
                {status.activeTriggers} GitHub triggers will match the new primary repository.
              </ImpactItem>
              <ImpactItem icon={<CheckCircle2 className="h-3.5 w-3.5" />}>
                {additionalRepositoryCount} additional repositories stay listed and will be
                rechecked.
              </ImpactItem>
              {status.activeWorkspaces > 0 || status.inProgressTasks > 0 ? (
                <ImpactItem icon={<AlertTriangle className="h-3.5 w-3.5" />}>
                  Running work should finish or stop before changing repository identity.
                </ImpactItem>
              ) : null}
            </div>

            <div className="grid gap-1.5">
              <label htmlFor="repository-confirm" className="text-xs font-medium text-fg-secondary">
                Type {selectedChoice.repository} to confirm
              </label>
              <input
                id="repository-confirm"
                value={confirmText}
                onChange={(event) => setConfirmText(event.currentTarget.value)}
                className="min-h-9 rounded-sm border border-border-default bg-inset px-2.5 py-1.5 text-[0.8125rem] text-fg-primary"
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit} loading={saving}>
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" />
              Change Repository
            </span>
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RepositoryChoiceButton({
  choice,
  selected,
  isLast,
  onSelect,
}: {
  choice: MockRepositoryChoice;
  selected: boolean;
  isLast: boolean;
  onSelect: () => void;
}) {
  const disabled = !!choice.disabledReason;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`grid w-full min-w-0 gap-1 bg-transparent px-3 py-2 text-left transition-colors ${
        !isLast ? 'border-b border-border-default' : ''
      } ${
        selected ? 'bg-accent-tint' : disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-inset'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] font-semibold text-fg-primary">
          {choice.repository}
        </code>
        {choice.recommended && (
          <span className="shrink-0 rounded-sm bg-[color-mix(in_srgb,var(--sam-color-success)_16%,transparent)] px-1.5 py-px text-[0.6875rem] text-success">
            recommended
          </span>
        )}
        <span className="ml-auto shrink-0 rounded-sm bg-inset px-1.5 py-px text-[0.6875rem] text-fg-muted">
          {choice.private ? 'private' : 'public'}
        </span>
      </div>
      <p className="m-0 line-clamp-2 text-xs text-fg-muted">
        {choice.disabledReason ?? choice.description}
      </p>
    </button>
  );
}

function RepositoryReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-[0.6875rem] uppercase text-fg-muted">{label}</span>
      <code className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] font-semibold text-fg-primary">
        {value}
      </code>
    </div>
  );
}

function ImpactItem({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 text-fg-muted">{icon}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function healthLabel(health: RepositoryHealth): string {
  if (health === 'id-mismatch') return 'Repository identity changed';
  if (health === 'access-revoked') return 'Repository access revoked';
  if (health === 'detached') return 'Repository detached';
  return 'Access verified';
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}
