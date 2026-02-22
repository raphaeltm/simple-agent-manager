import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Project } from '@simple-agent-manager/shared';
import { Alert, Button, EmptyState, PageLayout, Skeleton } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { listProjects } from '../lib/api';

export function Projects() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const projectResponse = await listProjects();
      setProjects(projectResponse.projects);
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
        <Button onClick={() => navigate('/projects/new')}>
          New Project
        </Button>
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--sam-space-3)' }}>
          <Alert variant="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        </div>
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
        <EmptyState
          heading="No projects yet"
          description="Create your first project to start organizing workspaces and tasks."
          action={{ label: 'New Project', onClick: () => navigate('/projects/new') }}
        />
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
              <span style={{ color: 'var(--sam-color-fg-muted)', fontSize: 'var(--sam-type-secondary-size)' }}>
                {project.repository}@{project.defaultBranch}
              </span>
              {project.description && (
                <span style={{ color: 'var(--sam-color-fg-muted)', fontSize: 'var(--sam-type-secondary-size)' }}>
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
