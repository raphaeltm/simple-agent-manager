import type { GitHubInstallation, ProjectDetailResponse } from '@simple-agent-manager/shared';
import { Alert, PageLayout, Spinner } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useParams } from 'react-router';

import { useAppShell } from '../components/AppShell';
import { useIsMobile } from '../hooks/useIsMobile';
import { getProject, listGitHubInstallations } from '../lib/api';
import { ProjectContext } from './ProjectContext';

export function Project() {
  const { id: projectId } = useParams<{ id: string }>();
  const location = useLocation();
  const isMobile = useIsMobile();
  const { setProjectName } = useAppShell();

  const [project, setProject] = useState<ProjectDetailResponse | null>(null);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [projectLoading, setProjectLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Chat routes get a full-bleed layout (no PageLayout wrapper)
  const isChatRoute = /\/(chat|agent)(\/|$)/.test(location.pathname);

  // Track whether we have successfully loaded data at least once for the
  // current projectId. After the first load, reloads (e.g. after saving
  // settings) skip the loading spinner so the existing Outlet tree stays
  // mounted (stale-while-revalidate).
  const hasLoadedForIdRef = useRef<string | null>(null);

  const loadProject = useCallback(async () => {
    if (!projectId) return;
    try {
      setError(null);
      // Only show the full-screen spinner on the very first load for this
      // projectId. Subsequent reloads keep existing content visible.
      if (hasLoadedForIdRef.current !== projectId) {
        setProjectLoading(true);
      }
      setProject(await getProject(projectId));
      hasLoadedForIdRef.current = projectId;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project');
      hasLoadedForIdRef.current = projectId;
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

  // Push project name up to AppShell for sidebar display
  useEffect(() => {
    setProjectName(project?.name);
    return () => setProjectName(undefined);
  }, [project?.name, setProjectName]);

  const contextValue = useMemo(
    () => ({
      projectId: projectId!,
      project,
      installations,
      reload: loadProject,
    }),
    [projectId, project, installations, loadProject]
  );

  if (!projectId) {
    return (
      <PageLayout title="Project" maxWidth="xl">
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
          </ProjectContext.Provider>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Non-chat routes: content with max-width and padding (no desktop header bar)
  // ---------------------------------------------------------------------------
  return (
    <div className={`min-h-screen min-w-0 overflow-x-hidden ${isMobile ? 'flex flex-col' : ''}`}>
      <main
        aria-label={project?.name ? `${project.name} — Project` : 'Project'}
        className={`max-w-[80rem] w-full mx-auto min-w-0 ${isMobile ? 'flex flex-col flex-1 min-h-0' : ''}`}
        style={isMobile
          ? { padding: 'var(--sam-space-3) var(--sam-space-3)' }
          : { padding: 'var(--sam-space-8) clamp(var(--sam-space-3), 3vw, var(--sam-space-4))' }
        }
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
      </main>
    </div>
  );
}
