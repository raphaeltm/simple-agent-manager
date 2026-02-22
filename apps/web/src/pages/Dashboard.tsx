import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../components/AuthProvider';
import { UserMenu } from '../components/UserMenu';
import { WorkspaceCard } from '../components/WorkspaceCard';
import { ProjectSummaryCard } from '../components/ProjectSummaryCard';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../hooks/useToast';
import { useProjectList } from '../hooks/useProjectData';
import { listWorkspaces, stopWorkspace, restartWorkspace, deleteWorkspace } from '../lib/api';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';
import { OnboardingChecklist } from '../components/OnboardingChecklist';
import { PageLayout, Button, Alert, EmptyState, Spinner, SkeletonCard } from '@simple-agent-manager/ui';

export function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceResponse | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const hasTransitionalWorkspaces = useMemo(() => {
    return workspaces.some(w =>
      w.status === 'creating' || w.status === 'stopping'
    );
  }, [workspaces]);

  const loadWorkspaces = useCallback(async () => {
    try {
      setError(null);
      const data = await listWorkspaces();
      setWorkspaces(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspaces');
    } finally {
      setLoading(false);
    }
  }, []);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    const pollMs = hasTransitionalWorkspaces ? 5000 : 30000;
    timerRef.current = setTimeout(function tick() {
      loadWorkspaces().finally(() => {
        timerRef.current = setTimeout(tick, pollMs);
      });
    }, pollMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [loadWorkspaces, hasTransitionalWorkspaces]);

  const handleStopWorkspace = async (id: string) => {
    const prev = workspaces;
    setWorkspaces(ws => ws.map(w => w.id === id ? { ...w, status: 'stopping' as const } : w));
    try {
      await stopWorkspace(id);
      toast.success('Workspace stopping');
    } catch (err) {
      setWorkspaces(prev);
      toast.error(err instanceof Error ? err.message : 'Failed to stop workspace');
    }
  };

  const handleRestartWorkspace = async (id: string) => {
    const prev = workspaces;
    setWorkspaces(ws => ws.map(w => w.id === id ? { ...w, status: 'creating' as const } : w));
    try {
      await restartWorkspace(id);
      toast.success('Workspace restarting');
    } catch (err) {
      setWorkspaces(prev);
      toast.error(err instanceof Error ? err.message : 'Failed to restart workspace');
    }
  };

  const handleDeleteWorkspace = (id: string) => {
    const workspace = workspaces.find(w => w.id === id);
    if (workspace) {
      setDeleteTarget(workspace);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;

    setDeleteLoading(true);
    const prev = workspaces;
    const targetId = deleteTarget.id;
    setWorkspaces(ws => ws.filter(w => w.id !== targetId));
    setDeleteTarget(null);
    try {
      await deleteWorkspace(targetId);
      toast.success('Workspace deleted');
    } catch (err) {
      setWorkspaces(prev);
      toast.error(err instanceof Error ? err.message : 'Failed to delete workspace');
    } finally {
      setDeleteLoading(false);
    }
  };

  const { projects, loading: projectsLoading } = useProjectList({ sort: 'last_activity', limit: 20 });

  // Group workspaces by projectId
  const { linkedWorkspaces, unlinkedWorkspaces } = useMemo(() => {
    const linked = new Map<string, WorkspaceResponse[]>();
    const unlinked: WorkspaceResponse[] = [];
    for (const ws of workspaces) {
      if (ws.projectId) {
        const list = linked.get(ws.projectId) ?? [];
        list.push(ws);
        linked.set(ws.projectId, list);
      } else {
        unlinked.push(ws);
      }
    }
    return { linkedWorkspaces: linked, unlinkedWorkspaces: unlinked };
  }, [workspaces]);

  return (
    <PageLayout
      title="Simple Agent Manager"
      maxWidth="xl"
      headerRight={<UserMenu />}
    >
      {/* Welcome section */}
      <div style={{ marginBottom: 'var(--sam-space-6)' }}>
        <h2 style={{ fontSize: 'var(--sam-type-page-title-size)', fontWeight: 'var(--sam-type-page-title-weight)' as unknown as number, lineHeight: 'var(--sam-type-page-title-line-height)', color: 'var(--sam-color-fg-primary)' }}>
          Welcome, {user?.name || user?.email}!
        </h2>
        <p style={{ color: 'var(--sam-color-fg-muted)', marginTop: 'var(--sam-space-1)' }}>
          Manage your AI coding workspaces
        </p>
      </div>

      {/* Onboarding checklist — shown for new users */}
      <OnboardingChecklist />

      <style>{`
        .sam-project-grid { grid-template-columns: 1fr; }
        @media (min-width: 768px) { .sam-project-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (min-width: 1024px) { .sam-project-grid { grid-template-columns: repeat(3, 1fr); } }
        .sam-workspace-grid { grid-template-columns: 1fr; }
        @media (min-width: 768px) { .sam-workspace-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (min-width: 1024px) { .sam-workspace-grid { grid-template-columns: repeat(3, 1fr); } }
      `}</style>

      {/* Error message */}
      {error && (
        <div style={{ marginBottom: 'var(--sam-space-4)' }}>
          <Alert variant="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        </div>
      )}

      {/* Projects section — primary content */}
      <div style={{ marginBottom: 'var(--sam-space-8)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sam-space-4)' }}>
          <h3 style={{ margin: 0, fontSize: 'var(--sam-type-section-heading-size)', fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number, color: 'var(--sam-color-fg-primary)' }}>Projects</h3>
          <Button variant="ghost" size="sm" onClick={() => navigate('/projects')}>
            View all
          </Button>
        </div>

        {projectsLoading ? (
          <div className="sam-project-grid" style={{ display: 'grid', gap: 'var(--sam-space-4)' }}>
            {Array.from({ length: 3 }, (_, i) => (
              <SkeletonCard key={i} lines={2} />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <EmptyState
            heading="No projects yet"
            description="Create your first project to start organizing your workspaces."
            action={{ label: 'Create Project', onClick: () => navigate('/projects/new') }}
          />
        ) : (
          <div style={{ display: 'grid', gap: 'var(--sam-space-4)' }}>
            {projects.map((project) => {
              const projectWorkspaces = linkedWorkspaces.get(project.id) ?? [];
              return (
                <div key={project.id}>
                  <ProjectSummaryCard project={project} />
                  {projectWorkspaces.length > 0 && (
                    <div
                      className="sam-workspace-grid"
                      style={{
                        display: 'grid',
                        gap: 'var(--sam-space-3)',
                        marginTop: 'var(--sam-space-2)',
                        paddingLeft: 'var(--sam-space-4)',
                        borderLeft: '2px solid var(--sam-color-border-default)',
                      }}
                    >
                      {projectWorkspaces.map((ws) => (
                        <WorkspaceCard
                          key={ws.id}
                          workspace={ws}
                          onStop={handleStopWorkspace}
                          onRestart={handleRestartWorkspace}
                          onDelete={handleDeleteWorkspace}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Unlinked workspaces section */}
      {!loading && unlinkedWorkspaces.length > 0 && (
        <div style={{ marginBottom: 'var(--sam-space-6)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sam-space-4)' }}>
            <h3 style={{ margin: 0, fontSize: 'var(--sam-type-section-heading-size)', fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number, color: 'var(--sam-color-fg-primary)' }}>Unlinked Workspaces</h3>
            {hasTransitionalWorkspaces && (
              <span style={{ fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)', display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
                <Spinner size="sm" />
                Updating...
              </span>
            )}
          </div>
          <p style={{ margin: '0 0 var(--sam-space-3)', color: 'var(--sam-color-fg-muted)', fontSize: 'var(--sam-type-secondary-size)' }}>
            These workspaces are not linked to any project. Consider linking them for better organization.
          </p>
          <div className="sam-workspace-grid" style={{ display: 'grid', gap: 'var(--sam-space-4)' }}>
            {unlinkedWorkspaces.map((workspace) => (
              <WorkspaceCard
                key={workspace.id}
                workspace={workspace}
                onStop={handleStopWorkspace}
                onRestart={handleRestartWorkspace}
                onDelete={handleDeleteWorkspace}
              />
            ))}
          </div>
        </div>
      )}

      {/* Loading skeleton for workspaces when still loading and no unlinked shown */}
      {loading && (
        <div style={{ marginBottom: 'var(--sam-space-6)' }}>
          <h3 style={{ margin: '0 0 var(--sam-space-4)', fontSize: 'var(--sam-type-section-heading-size)', fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number, color: 'var(--sam-color-fg-primary)' }}>Workspaces</h3>
          <div className="sam-workspace-grid" style={{ display: 'grid', gap: 'var(--sam-space-4)' }}>
            {Array.from({ length: 3 }, (_, i) => (
              <SkeletonCard key={i} lines={2} />
            ))}
          </div>
        </div>
      )}

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="Delete Workspace"
        message={
          <p>
            Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This action cannot be undone and all associated resources will be destroyed.
          </p>
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        loading={deleteLoading}
      />
    </PageLayout>
  );
}
