import type { GitHubInstallation, ProjectDetailResponse } from '@simple-agent-manager/shared';
import { Alert, PageLayout, Spinner } from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { Outlet, useLocation, useParams } from 'react-router';

import { useAppShell } from '../components/AppShell';
import { useAuth } from '../components/AuthProvider';
import { useIsMobile } from '../hooks/useIsMobile';
import {
  githubInstallationsQueryOptions,
  projectDetailQueryOptions,
  projectQueryKeys,
} from '../lib/query-options';
import { ProjectContext } from './ProjectContext';

export function Project() {
  const { id: projectId } = useParams<{ id: string }>();
  const location = useLocation();
  const isMobile = useIsMobile();
  const { setProjectName } = useAppShell();
  const { user } = useAuth();
  const queryScope = user?.id ?? '';
  const queryClient = useQueryClient();
  const projectQuery = useQuery({
    ...projectDetailQueryOptions(queryScope, projectId ?? ''),
    enabled: Boolean(projectId && queryScope),
  });
  const installationsQuery = useQuery({
    ...githubInstallationsQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });
  const project = (projectQuery.data ?? null) as ProjectDetailResponse | null;
  const installations = useMemo(
    () => (installationsQuery.data ?? []) as GitHubInstallation[],
    [installationsQuery.data]
  );
  const refetchProject = projectQuery.refetch;
  const projectLoading = Boolean(projectId) && projectQuery.isPending && project === null;
  const error =
    project === null
      ? projectQuery.error instanceof Error
        ? projectQuery.error.message
        : projectQuery.error
          ? 'Failed to load project'
          : null
      : null;

  // Chat routes get a full-bleed layout (no PageLayout wrapper)
  const isChatRoute = /\/(chat|agent)(\/|$)/.test(location.pathname);

  const loadProject = useCallback(async () => {
    await Promise.all([
      refetchProject(),
      queryClient.invalidateQueries({ queryKey: projectQueryKeys.lists(queryScope) }),
    ]);
  }, [queryClient, queryScope, refetchProject]);

  // Push project name up to AppShell for sidebar display
  useEffect(() => {
    setProjectName(project?.name);
    return () => setProjectName(undefined);
  }, [project?.name, setProjectName]);

  // Hooks must run unconditionally, so this memo is computed even on renders
  // where projectId is still undefined (before the "Project ID is missing"
  // guard below returns). The '' fallback is never actually consumed — every
  // code path that reads contextValue.projectId runs after that guard.
  const contextValue = useMemo(
    () => ({
      projectId: projectId ?? '',
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
        ) : !project ? (
          <div className="p-4">
            <Alert variant="error">{error ?? 'Project not found.'}</Alert>
          </div>
        ) : (
          <>
            {error && (
              <div className="p-4 pb-0">
                <Alert variant="error">{error}</Alert>
              </div>
            )}
            <ProjectContext.Provider value={contextValue}>
              <Outlet />
            </ProjectContext.Provider>
          </>
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
        style={
          isMobile
            ? { padding: 'var(--sam-space-3) var(--sam-space-3)' }
            : { padding: 'var(--sam-space-8) clamp(var(--sam-space-3), 3vw, var(--sam-space-4))' }
        }
      >
        {projectLoading ? (
          <div className="flex items-center gap-2 mt-4">
            <Spinner size="md" />
            <span>Loading project...</span>
          </div>
        ) : !project ? (
          <div className="mt-4">
            <Alert variant="error">{error ?? 'Project not found.'}</Alert>
          </div>
        ) : (
          /*
           * `min-w-0 [&>*]:max-w-full` is a structural guard, not cosmetic.
           * This is a COLUMN flex container, so a page root that uses `mx-auto`
           * (auto cross-axis margins) loses `align-items: stretch` and falls
           * back to fit-content sizing, which `min-width: auto` then floors at
           * the subtree's min-content width. A single `truncate`
           * (white-space: nowrap) heading makes that min-content the FULL
           * untruncated string, so one long name can push the page past the
           * viewport — where the ancestors' `overflow-x-hidden` silently clips
           * it instead of scrolling. Clamping children to this wrapper's width
           * stops any project page from shearing off-screen.
           */
          <div
            className={`flex flex-col flex-1 min-h-0 min-w-0 [&>*]:max-w-full ${isMobile ? 'mt-2' : 'mt-3'}`}
          >
            <ProjectContext.Provider value={contextValue}>
              <Outlet />
            </ProjectContext.Provider>
          </div>
        )}
      </main>
    </div>
  );
}
