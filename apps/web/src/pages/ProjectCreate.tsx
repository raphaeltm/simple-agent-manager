import type { GitHubInstallation } from '@simple-agent-manager/shared';
import { Alert, Breadcrumb, PageLayout, Skeleton } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { ProjectForm, type ProjectFormValues } from '../components/project/ProjectForm';
import { UserMenu } from '../components/UserMenu';
import { useToast } from '../hooks/useToast';
import { createProject, listGitHubInstallations } from '../lib/api';
import { API_URL } from '../lib/api/client';

export function ProjectCreate() {
  const navigate = useNavigate();
  const toast = useToast();
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [artifactsEnabled, setArtifactsEnabled] = useState(false);
  const [artifactsLoading, setArtifactsLoading] = useState(true);

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

  // Check if artifacts provider is enabled
  useEffect(() => {
    const checkArtifacts = async () => {
      try {
        const resp = await fetch(`${API_URL}/api/config/artifacts-enabled`, { credentials: 'include' });
        if (resp.ok) {
          const data = await resp.json() as { enabled: boolean };
          setArtifactsEnabled(data.enabled);
        }
      } catch {
        // Artifacts check is best-effort — if it fails, GitHub-only mode
      } finally {
        setArtifactsLoading(false);
      }
    };
    void checkArtifacts();
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
        ...(values.repoProvider === 'artifacts'
          ? { repoProvider: 'artifacts' }
          : {
              repoProvider: 'github',
              installationId: values.installationId,
              repository: values.repository,
              defaultBranch: values.defaultBranch,
              githubRepoId: values.githubRepoId,
            }),
      });
      toast.success('Project created');
      navigate(`/projects/${project.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setSubmitting(false);
    }
  };

  const isLoading = loading || artifactsLoading;
  const canShowForm = installations.length > 0 || artifactsEnabled;

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
        {isLoading ? (
          <div className="grid gap-3">
            <Skeleton width="30%" height="0.875rem" />
            <Skeleton width="100%" height="2.5rem" borderRadius="var(--sam-radius-md)" />
            <Skeleton width="30%" height="0.875rem" />
            <Skeleton width="100%" height="2.5rem" borderRadius="var(--sam-radius-md)" />
          </div>
        ) : !canShowForm ? (
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
            artifactsEnabled={artifactsEnabled}
          />
        )}
      </div>
    </PageLayout>
  );
}
