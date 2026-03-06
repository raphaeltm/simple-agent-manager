import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Project } from '@simple-agent-manager/shared';
import { Alert, Button, EmptyState, PageLayout, Skeleton, Spinner } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { listProjects } from '../lib/api';

export function Projects() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      if (hasLoadedRef.current) {
        setIsRefreshing(true);
      }
      const projectResponse = await listProjects();
      setProjects(projectResponse.projects);
      hasLoadedRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
      setIsRefreshing(false);
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
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <p className="m-0 text-fg-muted flex items-center gap-2">
          Projects are repository-backed planning spaces for backlog tasks and delegation.
          {isRefreshing && <Spinner size="sm" />}
        </p>
        <Button onClick={() => navigate('/projects/new')}>
          New Project
        </Button>
      </div>

      {error && (
        <div className="mb-3">
          <Alert variant="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        </div>
      )}

      {loading && projects.length === 0 ? (
        <div className="grid gap-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div
              key={index}
              className="border border-border-default rounded-md p-4 bg-surface grid gap-2"
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
        <div className="grid gap-3">
          {sortedProjects.map((project) => (
            <button
              key={project.id}
              onClick={() => navigate(`/projects/${project.id}`)}
              className="text-left border border-border-default rounded-md bg-surface p-4 text-fg-primary cursor-pointer grid gap-2"
            >
              <strong>{project.name}</strong>
              <span className="text-fg-muted text-sm">
                {project.repository}@{project.defaultBranch}
              </span>
              {project.description && (
                <span className="text-fg-muted text-sm">
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
