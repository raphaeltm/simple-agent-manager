import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation, useParams } from 'react-router-dom';
import type { GitHubInstallation, ProjectDetailResponse } from '@simple-agent-manager/shared';
import { Alert, PageLayout, Spinner } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { SettingsDrawer } from '../components/project/SettingsDrawer';
import { ProjectInfoPanel } from '../components/project/ProjectInfoPanel';
import { useIsMobile } from '../hooks/useIsMobile';
import { getProject, listGitHubInstallations } from '../lib/api';
import { ProjectContext } from './ProjectContext';

export function Project() {
  const { id: projectId } = useParams<{ id: string }>();
  const location = useLocation();
  const isMobile = useIsMobile();

  const [project, setProject] = useState<ProjectDetailResponse | null>(null);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [projectLoading, setProjectLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [infoPanelOpen, setInfoPanelOpen] = useState(false);

  // Chat routes get a full-bleed layout (no PageLayout wrapper)
  const isChatRoute = /\/chat(\/|$)/.test(location.pathname);

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

  const contextValue = {
    projectId: projectId!,
    project,
    installations,
    reload: loadProject,
    settingsOpen,
    setSettingsOpen,
    infoPanelOpen,
    setInfoPanelOpen,
  };

  if (!projectId) {
    return (
      <PageLayout title="Project" maxWidth="xl" headerRight={<UserMenu />}>
        <Alert variant="error">Project ID is missing.</Alert>
      </PageLayout>
    );
  }

  // ---------------------------------------------------------------------------
  // Chat route: full-bleed layout (no PageLayout, no max-width, no padding)
  // ---------------------------------------------------------------------------
  if (isChatRoute) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        {projectLoading ? (
          <div className="flex items-center justify-center flex-1 gap-2">
            <Spinner size="md" />
            <span className="text-fg-muted text-sm">Loading project...</span>
          </div>
        ) : error ? (
          <div className="p-4">
            <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
          </div>
        ) : !project ? (
          <div className="p-4">
            <Alert variant="error">Project not found.</Alert>
          </div>
        ) : (
          <ProjectContext.Provider value={contextValue}>
            <Outlet />
            <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
            <ProjectInfoPanel projectId={projectId} open={infoPanelOpen} onClose={() => setInfoPanelOpen(false)} />
          </ProjectContext.Provider>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Non-chat routes: PageLayout wrapper
  // ---------------------------------------------------------------------------
  return (
    <PageLayout
      title={project?.name ?? 'Project'}
      maxWidth="xl"
      headerRight={<UserMenu />}
      compact={isMobile}
    >
      {error && (
        <div className="mt-3">
          <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}

      {projectLoading ? (
        <div className="flex items-center gap-2 mt-4">
          <Spinner size="md" />
          <span>Loading project...</span>
        </div>
      ) : !project ? (
        <div className="mt-4">
          <Alert variant="error">Project not found.</Alert>
        </div>
      ) : (
        <div className={`flex flex-col flex-1 min-h-0 ${isMobile ? 'mt-2' : 'mt-3'}`}>
          <ProjectContext.Provider value={contextValue}>
            <Outlet />
          </ProjectContext.Provider>
        </div>
      )}
    </PageLayout>
  );
}
