import { useCallback, useEffect, useState } from 'react';
import { Outlet, useParams } from 'react-router-dom';
import type { GitHubInstallation, ProjectDetailResponse } from '@simple-agent-manager/shared';
import { Alert, Breadcrumb, PageLayout, Spinner, Tabs } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { getProject, listGitHubInstallations } from '../lib/api';
import { ProjectContext } from './ProjectContext';

const PROJECT_TABS = [
  { id: 'overview', label: 'Overview', path: 'overview' },
  { id: 'chat', label: 'Chat', path: 'chat' },
  { id: 'tasks', label: 'Tasks', path: 'tasks' },
  { id: 'sessions', label: 'Sessions', path: 'sessions' },
  { id: 'settings', label: 'Settings', path: 'settings' },
  { id: 'activity', label: 'Activity', path: 'activity' },
];

export function Project() {
  const { id: projectId } = useParams<{ id: string }>();

  const [project, setProject] = useState<ProjectDetailResponse | null>(null);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [projectLoading, setProjectLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProject = useCallback(async () => {
    if (!projectId) return;
    try {
      setError(null);
      setProjectLoading(true);
      setProject(await getProject(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project');
    } finally {
      setProjectLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadProject(); }, [loadProject]);

  useEffect(() => {
    void listGitHubInstallations()
      .then((response) => setInstallations(response))
      .catch(() => setInstallations([]));
  }, []);

  if (!projectId) {
    return (
      <PageLayout title="Project" maxWidth="xl" headerRight={<UserMenu />}>
        <Alert variant="error">Project ID is missing.</Alert>
      </PageLayout>
    );
  }

  return (
    <PageLayout title="Project" maxWidth="xl" headerRight={<UserMenu />}>
      {/* Breadcrumb */}
      <Breadcrumb
        segments={[
          { label: 'Dashboard', path: '/dashboard' },
          { label: 'Projects', path: '/projects' },
          { label: project?.name || 'Project' },
        ]}
      />

      {error && (
        <div style={{ marginTop: 'var(--sam-space-3)' }}>
          <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}

      {projectLoading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)', marginTop: 'var(--sam-space-4)' }}>
          <Spinner size="md" />
          <span>Loading project...</span>
        </div>
      ) : !project ? (
        <div style={{ marginTop: 'var(--sam-space-4)' }}>
          <Alert variant="error">Project not found.</Alert>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--sam-space-4)', marginTop: 'var(--sam-space-4)' }}>
          {/* Project header */}
          <div style={{ display: 'grid', gap: '0.25rem' }}>
            <h1 className="sam-type-page-title" style={{ margin: 0, color: 'var(--sam-color-fg-primary)' }}>
              {project.name}
            </h1>
            <div className="sam-type-secondary" style={{ color: 'var(--sam-color-fg-muted)' }}>
              {project.repository}@{project.defaultBranch}
            </div>
            {project.description && (
              <p className="sam-type-secondary" style={{ margin: 0, color: 'var(--sam-color-fg-muted)' }}>
                {project.description}
              </p>
            )}
          </div>

          {/* Tab navigation */}
          <Tabs tabs={PROJECT_TABS} basePath={`/projects/${projectId}`} />

          {/* Sub-route content */}
          <ProjectContext.Provider value={{ projectId, project, installations, reload: loadProject }}>
            <Outlet />
          </ProjectContext.Provider>
        </div>
      )}
    </PageLayout>
  );
}
