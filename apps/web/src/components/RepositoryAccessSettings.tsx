import type {
  Project,
  ProjectRepository,
  ProjectRepositoryStatus,
  SubmoduleSuggestion,
} from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';

import { useToast } from '../hooks/useToast';
import {
  addProjectRepository,
  discoverSubmoduleRepos,
  listProjectRepositories,
  removeProjectRepository,
} from '../lib/api';
import { RepositoryAccessCombobox } from './RepositoryAccessCombobox';

const STATUS_META: Record<ProjectRepositoryStatus, { label: string; tone: string; title: string }> =
  {
    active: {
      label: 'active',
      tone: 'text-fg-muted bg-inset',
      title: 'Access verified through the project GitHub App installation.',
    },
    'access-revoked': {
      label: 'access revoked',
      tone: 'text-danger bg-[color-mix(in_srgb,var(--sam-color-danger)_15%,transparent)]',
      title:
        'This repository is no longer accessible through the installation. It will be excluded from workspace tokens until access is restored.',
    },
    'app-not-installed': {
      label: 'app not installed',
      tone: 'text-danger bg-[color-mix(in_srgb,var(--sam-color-danger)_15%,transparent)]',
      title: 'The GitHub App is not installed on this repository\u2019s owner.',
    },
    'unsupported-url': {
      label: 'unsupported',
      tone: 'text-fg-muted bg-inset',
      title: 'This submodule URL could not be parsed as a GitHub repository.',
    },
  };

function StatusBadge({ status }: { status: ProjectRepositoryStatus }) {
  const meta = STATUS_META[status] ?? {
    label: 'unknown',
    tone: 'text-fg-muted bg-inset',
    title: 'Repository access status is unknown.',
  };
  return (
    <span
      className={`text-[0.6875rem] px-1.5 py-px rounded-sm shrink-0 ${meta.tone}`}
      title={meta.title}
    >
      {meta.label}
    </span>
  );
}

/**
 * Repository Access — additional same-installation/same-org repositories whose
 * read/write access is included in this project's tightly scoped workspace
 * GitHub tokens. The primary project repository is always included implicitly.
 * Submodules declared in the primary repo's `.gitmodules` are suggested here.
 */
export function RepositoryAccessSettings({ project }: { project: Project }) {
  const toast = useToast();
  const projectId = project.id;
  const githubBacked = !project.repoProvider || project.repoProvider === 'github';

  const [loading, setLoading] = useState(true);
  const [primaryRepository, setPrimaryRepository] = useState(project.repository);
  const [repositories, setRepositories] = useState<ProjectRepository[]>([]);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const [suggestions, setSuggestions] = useState<SubmoduleSuggestion[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState(false);

  const load = useCallback(async () => {
    if (!githubBacked) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const response = await listProjectRepositories(projectId);
      setPrimaryRepository(response.primaryRepository);
      setRepositories(response.repositories);
    } catch {
      toast.error('Failed to load repository access');
    } finally {
      setLoading(false);
    }
  }, [githubBacked, projectId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async (repository: string) => {
    const trimmed = repository.trim();
    if (!trimmed) {
      toast.error('Repository is required');
      return;
    }
    try {
      setAdding(true);
      const response = await addProjectRepository(projectId, { repository: trimmed });
      setPrimaryRepository(response.primaryRepository);
      setRepositories(response.repositories);
      // Reflect the new membership in any visible discovery suggestions.
      setSuggestions((prev) =>
        prev.map((s) =>
          s.repository.toLowerCase() === trimmed.toLowerCase() ? { ...s, alreadyAdded: true } : s
        )
      );
      toast.success(`Added ${trimmed}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add repository');
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (repo: ProjectRepository) => {
    try {
      setRemovingId(repo.id);
      const response = await removeProjectRepository(projectId, repo.id);
      setPrimaryRepository(response.primaryRepository);
      setRepositories(response.repositories);
      setSuggestions((prev) =>
        prev.map((s) =>
          s.repository.toLowerCase() === repo.repository.toLowerCase()
            ? { ...s, alreadyAdded: false }
            : s
        )
      );
      toast.success(`Removed ${repo.repository}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove repository');
    } finally {
      setRemovingId(null);
    }
  };

  const handleDiscover = async () => {
    try {
      setDiscovering(true);
      const response = await discoverSubmoduleRepos(projectId);
      setSuggestions(response.suggestions);
      setDiscovered(true);
      if (response.suggestions.length === 0) {
        toast.success('No submodules found in the primary repository');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to discover submodules');
    } finally {
      setDiscovering(false);
    }
  };

  if (!githubBacked) {
    return null;
  }

  const addableSuggestions = suggestions.filter((s) => !s.alreadyAdded);

  return (
    <section className="glass-surface rounded-lg p-4 grid gap-3">
      <div>
        <h2 className="sam-type-section-heading m-0 text-fg-primary">Repository Access</h2>
        <p className="m-0 mt-1 text-xs text-fg-muted">
          Additional repositories from the same GitHub App installation whose access is included in
          this project&rsquo;s tightly scoped workspace tokens. The primary project repository is
          always included. Selected repositories inherit the active agent profile&rsquo;s GitHub
          permissions.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2">
          <Spinner size="sm" />
          <span className="text-xs text-fg-muted">Loading repository access&hellip;</span>
        </div>
      ) : (
        <div className="grid gap-4">
          {/* Primary (always included) */}
          <div className="grid gap-2">
            <h3 className="sam-type-card-title m-0 text-fg-primary">Primary Repository</h3>
            <div className="flex items-center gap-2 py-1.5 px-2 text-[0.8125rem] border border-border-default rounded-sm">
              <code className="font-semibold text-fg-primary text-[0.8125rem] overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
                {primaryRepository}
              </code>
              <span className="flex-1" />
              <span className="text-[0.6875rem] text-fg-muted bg-inset px-1.5 py-px rounded-sm shrink-0">
                always included
              </span>
            </div>
          </div>

          {/* Additional repositories */}
          <div className="grid gap-2">
            <h3 className="sam-type-card-title m-0 text-fg-primary">Additional Repositories</h3>

            <div className="flex gap-2 items-end flex-wrap">
              <RepositoryAccessCombobox
                projectId={projectId}
                disabled={adding}
                adding={adding}
                onAdd={handleAdd}
              />
            </div>

            {repositories.length === 0 ? (
              <div className="text-fg-muted text-xs py-1">
                No additional repositories. Workspace tokens are scoped to the primary repository
                only.
              </div>
            ) : (
              <div className="border border-border-default rounded-sm overflow-hidden">
                {repositories.map((repo, idx) => (
                  <div
                    key={repo.id}
                    className={`flex items-center gap-2 py-1.5 px-2 text-[0.8125rem] ${idx < repositories.length - 1 ? 'border-b border-border-default' : ''}`}
                  >
                    <code className="font-semibold text-fg-primary text-[0.8125rem] overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
                      {repo.repository}
                    </code>
                    <span className="flex-1" />
                    <StatusBadge status={repo.status} />
                    <button
                      onClick={() => void handleRemove(repo)}
                      disabled={removingId === repo.id}
                      className="bg-transparent border-none cursor-pointer text-fg-muted p-1 rounded-sm inline-flex items-center justify-center shrink-0 transition-colors hover:text-danger"
                      aria-label={`Remove ${repo.repository}`}
                      title={`Remove ${repo.repository}`}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Submodule discovery */}
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h3 className="sam-type-card-title m-0 text-fg-primary">Submodules</h3>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleDiscover()}
                loading={discovering}
                disabled={discovering}
                style={{ minHeight: '36px' }}
              >
                {discovered ? 'Re-scan .gitmodules' : 'Discover from .gitmodules'}
              </Button>
            </div>
            <p className="m-0 text-xs text-fg-muted">
              Scan the primary repository&rsquo;s <code>.gitmodules</code> for same-org repositories
              to add.
            </p>

            {discovered && suggestions.length === 0 && (
              <div className="text-fg-muted text-xs py-1">
                No submodules declared in the primary repository.
              </div>
            )}

            {addableSuggestions.length > 0 && (
              <div className="border border-border-default rounded-sm overflow-hidden">
                {addableSuggestions.map((suggestion, idx) => (
                  <div
                    key={`${suggestion.repository}:${suggestion.path}`}
                    className={`flex items-center gap-2 py-1.5 px-2 text-[0.8125rem] ${idx < addableSuggestions.length - 1 ? 'border-b border-border-default' : ''}`}
                  >
                    <code className="font-semibold text-fg-primary text-[0.8125rem] overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
                      {suggestion.repository}
                    </code>
                    <span className="text-fg-muted text-[0.6875rem] shrink-0">
                      {suggestion.path}
                    </span>
                    <span className="flex-1" />
                    {suggestion.accessible ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void handleAdd(suggestion.repository)}
                        loading={adding}
                        disabled={adding}
                        style={{ minHeight: '32px' }}
                      >
                        Add
                      </Button>
                    ) : (
                      <span
                        className="text-[0.6875rem] text-danger bg-[color-mix(in_srgb,var(--sam-color-danger)_15%,transparent)] px-1.5 py-px rounded-sm shrink-0"
                        title="This repository is not accessible through the project's GitHub App installation."
                      >
                        no access
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
