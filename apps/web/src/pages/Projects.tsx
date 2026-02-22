import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GitHubInstallation, Project } from '@simple-agent-manager/shared';
import { Alert, Button, PageLayout, Skeleton } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { ProjectForm, type ProjectFormValues } from '../components/project/ProjectForm';
import { createProject, listGitHubInstallations, listProjects } from '../lib/api';
import { useToast } from '../hooks/useToast';

export function Projects() {
  const navigate = useNavigate();
  const toast = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [projectResponse, installationResponse] = await Promise.all([
        listProjects(),
        listGitHubInstallations(),
      ]);
      setProjects(projectResponse.projects);
      setInstallations(installationResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [projects]
  );

  const handleCreate = async (values: ProjectFormValues) => {
    try {
      setSubmitting(true);
      await createProject({
        name: values.name,
        description: values.description || undefined,
        installationId: values.installationId,
        repository: values.repository,
        defaultBranch: values.defaultBranch,
        githubRepoId: values.githubRepoId,
      });
      toast.success('Project created');
      setShowCreateForm(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageLayout title="Projects" maxWidth="xl" headerRight={<UserMenu />}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--sam-space-3)',
          flexWrap: 'wrap',
          marginBottom: 'var(--sam-space-4)',
        }}
      >
        <p style={{ margin: 0, color: 'var(--sam-color-fg-muted)' }}>
          Projects are repository-backed planning spaces for backlog tasks and delegation.
        </p>
        <Button onClick={() => setShowCreateForm((current) => !current)}>
          {showCreateForm ? 'Close' : 'New Project'}
        </Button>
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--sam-space-3)' }}>
          <Alert variant="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        </div>
      )}

      {showCreateForm && (
        <section
          style={{
            border: '1px solid var(--sam-color-border-default)',
            borderRadius: 'var(--sam-radius-md)',
            background: 'var(--sam-color-bg-surface)',
            padding: 'var(--sam-space-4)',
            marginBottom: 'var(--sam-space-4)',
            display: 'grid',
            gap: 'var(--sam-space-3)',
          }}
        >
          <h2 style={{ margin: 0, fontSize: '1rem', color: 'var(--sam-color-fg-primary)' }}>Create project</h2>
          {installations.length === 0 ? (
            <Alert variant="warning">
              Install the GitHub App first in Settings before creating projects.
            </Alert>
          ) : (
            <ProjectForm
              mode="create"
              installations={installations}
              submitting={submitting}
              onSubmit={handleCreate}
              onCancel={() => setShowCreateForm(false)}
            />
          )}
        </section>
      )}

      {loading ? (
        <div style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
          {Array.from({ length: 3 }, (_, index) => (
            <div
              key={index}
              style={{
                border: '1px solid var(--sam-color-border-default)',
                borderRadius: 'var(--sam-radius-md)',
                padding: 'var(--sam-space-4)',
                background: 'var(--sam-color-bg-surface)',
                display: 'grid',
                gap: 'var(--sam-space-2)',
              }}
            >
              <Skeleton width="40%" height="1rem" />
              <Skeleton width="60%" height="0.875rem" />
            </div>
          ))}
        </div>
      ) : sortedProjects.length === 0 ? (
        <div
          style={{
            border: '1px solid var(--sam-color-border-default)',
            borderRadius: 'var(--sam-radius-md)',
            background: 'var(--sam-color-bg-surface)',
            padding: 'var(--sam-space-6)',
            color: 'var(--sam-color-fg-muted)',
          }}
        >
          No projects yet.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
          {sortedProjects.map((project) => (
            <button
              key={project.id}
              onClick={() => navigate(`/projects/${project.id}`)}
              style={{
                textAlign: 'left',
                border: '1px solid var(--sam-color-border-default)',
                borderRadius: 'var(--sam-radius-md)',
                background: 'var(--sam-color-bg-surface)',
                padding: 'var(--sam-space-4)',
                color: 'var(--sam-color-fg-primary)',
                cursor: 'pointer',
                display: 'grid',
                gap: '0.5rem',
              }}
            >
              <strong>{project.name}</strong>
              <span style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.875rem' }}>
                {project.repository}@{project.defaultBranch}
              </span>
              {project.description && (
                <span style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.875rem' }}>
                  {project.description}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </PageLayout>
  );
}
