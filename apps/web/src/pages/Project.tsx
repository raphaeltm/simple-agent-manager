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
  // Non-chat routes: PageLayout with project header
  // ---------------------------------------------------------------------------
  return (
    <PageLayout
      title="Project"
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
        <div className={`flex flex-col ${isMobile ? 'gap-2 mt-2' : 'gap-3 mt-3'} flex-1 min-h-0`}>
          {/* Project header */}
          <div className="flex items-center gap-2 min-h-9 flex-nowrap">
            <h1 className={`m-0 text-base font-semibold text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap min-w-0 ${isMobile ? 'flex-1' : ''}`}>
              {project.name}
            </h1>
            {!isMobile && (
              <a
                href={`https://github.com/${project.repository}`}
                target="_blank"
                rel="noopener noreferrer"
                className="sam-type-caption text-fg-muted no-underline"
              >
                {project.repository}
              </a>
            )}
            <div className="ml-auto flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setInfoPanelOpen(!infoPanelOpen)}
                title="Project status"
                aria-label="Project status"
                aria-expanded={infoPanelOpen}
                className={`bg-transparent border border-border-default rounded-sm ${isMobile ? 'py-1 px-2 min-h-11' : 'py-1 px-2 min-h-9'} cursor-pointer text-fg-muted text-sm flex items-center gap-1`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                </svg>
                {!isMobile && 'Status'}
              </button>
              <button
                type="button"
                onClick={() => setSettingsOpen(!settingsOpen)}
                title="Project settings"
                aria-label="Project settings"
                className={`bg-transparent border border-border-default rounded-sm ${isMobile ? 'py-1 px-2 min-h-11' : 'py-1 px-2 min-h-9'} cursor-pointer text-fg-muted text-sm flex items-center gap-1`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                {!isMobile && 'Settings'}
              </button>
            </div>
          </div>

          {/* Content — fills remaining space */}
          <div className="flex-1 min-h-0 flex flex-col">
            <ProjectContext.Provider value={contextValue}>
              <Outlet />
              <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
              <ProjectInfoPanel projectId={projectId} open={infoPanelOpen} onClose={() => setInfoPanelOpen(false)} />
            </ProjectContext.Provider>
          </div>
        </div>
      )}
    </PageLayout>
  );
}
