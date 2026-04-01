import type { GitHubInstallation } from '@simple-agent-manager/shared';
import { Alert, Breadcrumb, PageLayout, Skeleton } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { ProjectForm, type ProjectFormValues } from '../components/project/ProjectForm';
import { UserMenu } from '../components/UserMenu';
import { useToast } from '../hooks/useToast';
import { createProject, listGitHubInstallations } from '../lib/api';

export function ProjectCreate() {
  const navigate = useNavigate();
  const toast = useToast();
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await listGitHubInstallations();
      setInstallations(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load installations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (values: ProjectFormValues) => {
    try {
      setSubmitting(true);
      const project = await createProject({
        name: values.name,
        description: values.description || undefined,
        installationId: values.installationId,
        repository: values.repository,
        defaultBranch: values.defaultBranch,
        githubRepoId: values.githubRepoId,
      });
      toast.success('Project created');
      navigate(`/projects/${project.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageLayout title="New Project" maxWidth="xl" headerRight={<UserMenu />}>
      <Breadcrumb
        segments={[
          { label: 'Home', path: '/dashboard' },
          { label: 'Projects', path: '/projects' },
          { label: 'New Project' },
        ]}
      />

      {error && (
        <div className="mt-3">
          <Alert variant="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        </div>
      )}

      <div className="mt-4 border border-border-default rounded-md bg-surface p-4">
        {loading ? (
          <div className="grid gap-3">
            <Skeleton width="30%" height="0.875rem" />
            <Skeleton width="100%" height="2.5rem" borderRadius="var(--sam-radius-md)" />
            <Skeleton width="30%" height="0.875rem" />
            <Skeleton width="100%" height="2.5rem" borderRadius="var(--sam-radius-md)" />
          </div>
        ) : installations.length === 0 ? (
          <Alert variant="warning">
            Install the GitHub App first in Settings before creating projects.
          </Alert>
        ) : (
          <ProjectForm
            mode="create"
            installations={installations}
            submitting={submitting}
            onSubmit={handleCreate}
            onCancel={() => navigate('/projects')}
          />
        )}
      </div>
    </PageLayout>
  );
}
