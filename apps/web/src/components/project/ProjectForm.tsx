import { useMemo, useState, type FormEvent } from 'react';
import type { GitHubInstallation } from '@simple-agent-manager/shared';
import { Button, Input } from '@simple-agent-manager/ui';

export interface ProjectFormValues {
  name: string;
  description: string;
  installationId: string;
  repository: string;
  defaultBranch: string;
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
  const [error, setError] = useState<string | null>(null);

  const isEditMode = mode === 'edit';

  const handleChange = (field: keyof ProjectFormValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
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
      repository: values.repository.trim(),
      defaultBranch: values.defaultBranch.trim(),
    });
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
      <label style={{ display: 'grid', gap: '0.375rem' }}>
        <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>Name</span>
        <Input
          value={values.name}
          onChange={(event) => handleChange('name', event.currentTarget.value)}
          placeholder="Project name"
          disabled={submitting}
        />
      </label>

      <label style={{ display: 'grid', gap: '0.375rem' }}>
        <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>Description</span>
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
        <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>Installation</span>
        <select
          value={values.installationId}
          onChange={(event) => handleChange('installationId', event.currentTarget.value)}
          disabled={submitting || isEditMode}
          style={{
            width: '100%',
            borderRadius: 'var(--sam-radius-md)',
            border: '1px solid var(--sam-color-border-default)',
            background: 'var(--sam-color-bg-surface)',
            color: 'var(--sam-color-fg-primary)',
            padding: '0.625rem 0.75rem',
            minHeight: '2.75rem',
          }}
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

      <label style={{ display: 'grid', gap: '0.375rem' }}>
        <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>Repository</span>
        <Input
          value={values.repository}
          onChange={(event) => handleChange('repository', event.currentTarget.value)}
          placeholder="owner/repo"
          disabled={submitting || isEditMode}
        />
      </label>

      <label style={{ display: 'grid', gap: '0.375rem' }}>
        <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>Default branch</span>
        <Input
          value={values.defaultBranch}
          onChange={(event) => handleChange('defaultBranch', event.currentTarget.value)}
          placeholder="main"
          disabled={submitting}
        />
      </label>

      {error && (
        <div style={{ color: 'var(--sam-color-danger)', fontSize: '0.875rem' }} role="alert">
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
