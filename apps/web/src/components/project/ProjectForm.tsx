import type { GitHubInstallation, RepoProvider } from '@simple-agent-manager/shared';
import { Button, Input } from '@simple-agent-manager/ui';
import { type FormEvent, useCallback, useMemo, useState } from 'react';

import { listBranches } from '../../lib/api';
import { BranchSelector } from '../BranchSelector';
import { RepoSelector } from '../RepoSelector';

export interface ProjectFormValues {
  name: string;
  description: string;
  installationId: string;
  repository: string;
  defaultBranch: string;
  githubRepoId?: number;
  repoProvider?: RepoProvider;
}

interface ProjectFormProps {
  mode: 'create' | 'edit';
  installations: GitHubInstallation[];
  initialValues?: Partial<ProjectFormValues>;
  submitting?: boolean;
  onSubmit: (values: ProjectFormValues) => Promise<void> | void;
  onCancel?: () => void;
  submitLabel?: string;
  artifactsEnabled?: boolean;
}

function normalizeRepository(value: string): string {
  let repository = value.trim();

  if (repository.startsWith('https://github.com/')) {
    repository = repository.replace('https://github.com/', '');
  } else if (repository.startsWith('git@github.com:')) {
    repository = repository.replace('git@github.com:', '');
  }

  return repository.replace(/\.git$/, '');
}

export function ProjectForm({
  mode,
  installations,
  initialValues,
  submitting = false,
  onSubmit,
  onCancel,
  submitLabel,
  artifactsEnabled = false,
}: ProjectFormProps) {
  const defaultInstallationId = useMemo(() => {
    if (initialValues?.installationId) {
      return initialValues.installationId;
    }
    return installations[0]?.id ?? '';
  }, [initialValues?.installationId, installations]);

  const [repoProvider, setRepoProvider] = useState<RepoProvider>(
    initialValues?.repoProvider ?? 'github'
  );
  const [values, setValues] = useState<ProjectFormValues>({
    name: initialValues?.name ?? '',
    description: initialValues?.description ?? '',
    installationId: defaultInstallationId,
    repository: initialValues?.repository ?? '',
    defaultBranch: initialValues?.defaultBranch ?? 'main',
  });
  const [branches, setBranches] = useState<Array<{ name: string }>>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [repoDefaultBranch, setRepoDefaultBranch] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const isEditMode = mode === 'edit';
  const isArtifacts = repoProvider === 'artifacts';

  const fetchBranches = useCallback(async (repository: string, installationId: string, defBranch?: string) => {
    setBranchesLoading(true);
    setBranches([]);
    setBranchesError(null);

    try {
      const result = await listBranches(repository, installationId || undefined, defBranch);
      setBranches(result);

      if (result.length === 0) {
        setBranches([{ name: 'main' }, { name: 'master' }]);
        setBranchesError('Could not fetch branches, showing common defaults');
      }
    } catch {
      setBranches([{ name: 'main' }, { name: 'master' }, { name: 'develop' }]);
      setBranchesError('Unable to fetch branches. Common branch names provided.');
    } finally {
      setBranchesLoading(false);
    }
  }, []);

  const handleChange = (field: keyof ProjectFormValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  const handleRepositoryChange = (value: string) => {
    setBranches([]);
    setBranchesError(null);
    handleChange('repository', value);
  };

  const handleRepoSelect = useCallback(
    (repo: { fullName: string; defaultBranch: string; githubRepoId?: number } | null) => {
      if (!repo) {
        setBranches([]);
        setBranchesError(null);
        setRepoDefaultBranch(undefined);
        return;
      }

      setRepoDefaultBranch(repo.defaultBranch);
      setValues((current) => ({ ...current, defaultBranch: repo.defaultBranch, githubRepoId: repo.githubRepoId }));
      void fetchBranches(repo.fullName, values.installationId, repo.defaultBranch);
    },
    [fetchBranches, values.installationId]
  );

  const handleInstallationChange = (installationId: string) => {
    if (isEditMode) {
      handleChange('installationId', installationId);
      return;
    }

    // Clear repo selection when installation changes — repos differ per installation
    setValues((current) => ({
      ...current,
      installationId,
      repository: '',
      defaultBranch: 'main',
      githubRepoId: undefined,
    }));
    setBranches([]);
    setBranchesError(null);
    setRepoDefaultBranch(undefined);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!values.name.trim()) {
      setError('Project name is required');
      return;
    }

    if (isArtifacts) {
      // Artifacts path: only name is required, repo is auto-created
      await onSubmit({
        name: values.name.trim(),
        description: values.description.trim(),
        installationId: '',
        repository: '',
        defaultBranch: 'main',
        repoProvider: 'artifacts',
      });
      return;
    }

    // GitHub path: full validation
    if (!values.defaultBranch.trim()) {
      setError('Default branch is required');
      return;
    }

    if (!values.repository.trim()) {
      setError('Repository is required');
      return;
    }

    if (!values.installationId.trim()) {
      setError('Installation is required');
      return;
    }

    await onSubmit({
      name: values.name.trim(),
      description: values.description.trim(),
      installationId: values.installationId,
      repository: normalizeRepository(values.repository),
      defaultBranch: values.defaultBranch.trim(),
      githubRepoId: values.githubRepoId,
      repoProvider: 'github',
    });
  };

  return (
    <form onSubmit={handleSubmit} className="grid gap-3">
      {/* Provider toggle — only shown in create mode when artifacts is enabled */}
      {!isEditMode && artifactsEnabled && (
        <fieldset className="grid gap-1.5">
          <legend className="text-sm text-fg-muted">Repository Provider</legend>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setRepoProvider('artifacts')}
              disabled={submitting}
              className={`flex-1 rounded-md border py-2 px-3 text-sm font-medium transition-colors ${
                isArtifacts
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border-default bg-surface text-fg-muted hover:border-fg-muted'
              }`}
            >
              SAM Git
            </button>
            <button
              type="button"
              onClick={() => setRepoProvider('github')}
              disabled={submitting}
              className={`flex-1 rounded-md border py-2 px-3 text-sm font-medium transition-colors ${
                !isArtifacts
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border-default bg-surface text-fg-muted hover:border-fg-muted'
              }`}
            >
              GitHub
            </button>
          </div>
          {isArtifacts && (
            <p className="text-xs text-fg-muted">
              A Git repository will be created automatically. No GitHub account needed.
            </p>
          )}
        </fieldset>
      )}

      <label className="grid gap-1.5">
        <span className="text-sm text-fg-muted">Name</span>
        <Input
          value={values.name}
          onChange={(event) => handleChange('name', event.currentTarget.value)}
          placeholder="Project name"
          disabled={submitting}
        />
      </label>

      <label className="grid gap-1.5">
        <span className="text-sm text-fg-muted">Description</span>
        <textarea
          value={values.description}
          onChange={(event) => handleChange('description', event.currentTarget.value)}
          rows={3}
          disabled={submitting}
          className="w-full rounded-md border border-border-default bg-surface text-fg-primary py-2.5 px-3 resize-y"
        />
      </label>

      {/* GitHub-specific fields — hidden for Artifacts provider */}
      {!isArtifacts && (
        <>
          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Installation</span>
            <select
              value={values.installationId}
              onChange={(event) => handleInstallationChange(event.currentTarget.value)}
              disabled={submitting || isEditMode}
              className="w-full rounded-md border border-border-default bg-surface text-fg-primary py-2.5 px-3 min-h-11"
            >
              {installations.length === 0 ? (
                <option value="">No installations</option>
              ) : (
                installations.map((installation) => (
                  <option key={installation.id} value={installation.id}>
                    {installation.accountName} ({installation.accountType})
                  </option>
                ))
              )}
            </select>
          </label>

          <label htmlFor="project-repository" className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Repository</span>
            {isEditMode ? (
              <Input
                id="project-repository"
                value={values.repository}
                onChange={(event) => handleChange('repository', event.currentTarget.value)}
                placeholder="owner/repo"
                disabled
              />
            ) : (
              <RepoSelector
                id="project-repository"
                value={values.repository}
                onChange={handleRepositoryChange}
                onRepoSelect={handleRepoSelect}
                installationId={values.installationId}
                disabled={submitting}
                required
              />
            )}
          </label>

          <label htmlFor="project-default-branch" className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Default branch</span>
            <BranchSelector
              id="project-default-branch"
              branches={branches}
              value={values.defaultBranch}
              onChange={(val) => handleChange('defaultBranch', val)}
              defaultBranch={repoDefaultBranch}
              loading={!isEditMode && branchesLoading}
              error={!isEditMode ? branchesError : null}
              disabled={submitting}
            />
          </label>
        </>
      )}

      {error && (
        <div className="text-danger text-sm" role="alert">
          {error}
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving...' : (submitLabel ?? (isEditMode ? 'Update Project' : 'Create Project'))}
        </Button>
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
