import { useCallback, useEffect, useState } from 'react';
import { Outlet, useParams } from 'react-router-dom';
import type { GitHubInstallation, ProjectDetailResponse } from '@simple-agent-manager/shared';
import { Alert, Breadcrumb, PageLayout, Spinner } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { SettingsDrawer } from '../components/project/SettingsDrawer';
import { ProjectInfoPanel } from '../components/project/ProjectInfoPanel';
import { useIsMobile } from '../hooks/useIsMobile';
import { getProject, listGitHubInstallations } from '../lib/api';
import { ProjectContext } from './ProjectContext';

export function Project() {
  const { id: projectId } = useParams<{ id: string }>();
  const isMobile = useIsMobile();

  const [project, setProject] = useState<ProjectDetailResponse | null>(null);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [projectLoading, setProjectLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [infoPanelOpen, setInfoPanelOpen] = useState(false);

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

  const iconButtonStyle = {
    background: 'none',
    border: '1px solid var(--sam-color-border-default)',
    borderRadius: 'var(--sam-radius-sm)',
    padding: 'var(--sam-space-1) var(--sam-space-2)',
    minHeight: isMobile ? '32px' : '36px',
    cursor: 'pointer',
    color: 'var(--sam-color-fg-muted)',
    fontSize: 'var(--sam-type-secondary-size)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sam-space-1)',
  } as const;

  return (
    <PageLayout
      title="Project"
      maxWidth="xl"
      headerRight={isMobile ? undefined : <UserMenu />}
      hideHeader={isMobile}
      compact={isMobile}
    >
      {/* Breadcrumb — compact on mobile */}
      <Breadcrumb
        segments={[
          { label: 'Dashboard', path: '/dashboard' },
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
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: isMobile ? 'var(--sam-space-2)' : 'var(--sam-space-3)',
          marginTop: isMobile ? 'var(--sam-space-2)' : 'var(--sam-space-3)',
          flex: 1,
          minHeight: 0,
        }}>
          {/* Project header */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sam-space-2)',
            minHeight: isMobile ? '28px' : '36px',
            flexWrap: 'nowrap',
          }}>
            <h1 style={{
              margin: 0,
              fontSize: 'var(--sam-type-body-size)',
              fontWeight: 600,
              color: 'var(--sam-color-fg-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
              flex: isMobile ? 1 : undefined,
            }}>
              {project.name}
            </h1>
            {!isMobile && (
              <a
                href={`https://github.com/${project.repository}`}
                target="_blank"
                rel="noopener noreferrer"
                className="sam-type-caption"
                style={{
                  color: 'var(--sam-color-fg-muted)',
                  textDecoration: 'none',
                }}
              >
                {project.repository}
              </a>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)', flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => setInfoPanelOpen(!infoPanelOpen)}
                title="Project status"
                aria-label="Project status"
                aria-expanded={infoPanelOpen}
                style={iconButtonStyle}
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
                style={iconButtonStyle}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                {!isMobile && 'Settings'}
              </button>
            </div>
          </div>

          {/* Chat-first content — fills remaining space */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <ProjectContext.Provider value={{ projectId, project, installations, reload: loadProject, settingsOpen, setSettingsOpen }}>
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
