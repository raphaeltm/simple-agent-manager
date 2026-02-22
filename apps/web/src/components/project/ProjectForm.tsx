import { useCallback, useMemo, useState, type FormEvent } from 'react';
import type { GitHubInstallation } from '@simple-agent-manager/shared';
import { Button, Input, Spinner } from '@simple-agent-manager/ui';
import { listBranches } from '../../lib/api';
import { RepoSelector } from '../RepoSelector';

export interface ProjectFormValues {
  name: string;
  description: string;
  installationId: string;
  repository: string;
  defaultBranch: string;
  githubRepoId?: number;
}

interface ProjectFormProps {
  mode: 'create' | 'edit';
  installations: GitHubInstallation[];
  initialValues?: Partial<ProjectFormValues>;
  submitting?: boolean;
  onSubmit: (values: ProjectFormValues) => Promise<void> | void;
  onCancel?: () => void;
  submitLabel?: string;
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
}: ProjectFormProps) {
  const defaultInstallationId = useMemo(() => {
    if (initialValues?.installationId) {
      return initialValues.installationId;
    }
    return installations[0]?.id ?? '';
  }, [initialValues?.installationId, installations]);

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
  const [error, setError] = useState<string | null>(null);

  const isEditMode = mode === 'edit';

  const fetchBranches = useCallback(async (repository: string, installationId: string) => {
    setBranchesLoading(true);
    setBranches([]);
    setBranchesError(null);

    try {
      const result = await listBranches(repository, installationId || undefined);
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
        return;
      }

      setValues((current) => ({ ...current, defaultBranch: repo.defaultBranch, githubRepoId: repo.githubRepoId }));
      void fetchBranches(repo.fullName, values.installationId);
    },
    [fetchBranches, values.installationId]
  );

  const handleInstallationChange = (installationId: string) => {
    handleChange('installationId', installationId);

    if (isEditMode) {
      return;
    }

    const normalizedRepository = normalizeRepository(values.repository);
    if (!normalizedRepository || !normalizedRepository.includes('/')) {
      setBranches([]);
      setBranchesError(null);
      return;
    }

    void fetchBranches(normalizedRepository, installationId);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!values.name.trim()) {
      setError('Project name is required');
      return;
    }

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
    });
  };

  const selectStyle = {
    width: '100%',
    borderRadius: 'var(--sam-radius-md)',
    border: '1px solid var(--sam-color-border-default)',
    background: 'var(--sam-color-bg-surface)',
    color: 'var(--sam-color-fg-primary)',
    padding: '0.625rem 0.75rem',
    minHeight: '2.75rem',
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
      <label style={{ display: 'grid', gap: '0.375rem' }}>
        <span style={{ fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)' }}>Name</span>
        <Input
          value={values.name}
          onChange={(event) => handleChange('name', event.currentTarget.value)}
          placeholder="Project name"
          disabled={submitting}
        />
      </label>

      <label style={{ display: 'grid', gap: '0.375rem' }}>
        <span style={{ fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)' }}>Description</span>
        <textarea
          value={values.description}
          onChange={(event) => handleChange('description', event.currentTarget.value)}
          rows={3}
          disabled={submitting}
          style={{
            width: '100%',
            borderRadius: 'var(--sam-radius-md)',
            border: '1px solid var(--sam-color-border-default)',
            background: 'var(--sam-color-bg-surface)',
            color: 'var(--sam-color-fg-primary)',
            padding: '0.625rem 0.75rem',
            resize: 'vertical',
          }}
        />
      </label>

      <label style={{ display: 'grid', gap: '0.375rem' }}>
        <span style={{ fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)' }}>Installation</span>
        <select
          value={values.installationId}
          onChange={(event) => handleInstallationChange(event.currentTarget.value)}
          disabled={submitting || isEditMode}
          style={selectStyle}
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

      <label htmlFor="project-repository" style={{ display: 'grid', gap: '0.375rem' }}>
        <span style={{ fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)' }}>Repository</span>
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
            disabled={submitting}
            required
          />
        )}
      </label>

      <label htmlFor="project-default-branch" style={{ display: 'grid', gap: '0.375rem' }}>
        <span style={{ fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)' }}>Default branch</span>
        <div style={{ position: 'relative' }}>
          {!isEditMode && branches.length > 0 ? (
            <select
              id="project-default-branch"
              value={values.defaultBranch}
              onChange={(event) => handleChange('defaultBranch', event.currentTarget.value)}
              disabled={submitting}
              style={selectStyle}
            >
              {branches.map((branch) => (
                <option key={branch.name} value={branch.name}>
                  {branch.name}
                </option>
              ))}
            </select>
          ) : (
            <Input
              id="project-default-branch"
              value={values.defaultBranch}
              onChange={(event) => handleChange('defaultBranch', event.currentTarget.value)}
              placeholder="main"
              disabled={submitting}
            />
          )}
          {!isEditMode && branchesLoading && (
            <div style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)' }}>
              <Spinner size="sm" />
            </div>
          )}
        </div>
        {!isEditMode && branchesError && (
          <span style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>
            {branchesError}
          </span>
        )}
      </label>

      {error && (
        <div style={{ color: 'var(--sam-color-danger)', fontSize: 'var(--sam-type-secondary-size)' }} role="alert">
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
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
