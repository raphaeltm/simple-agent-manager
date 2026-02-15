import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../components/AuthProvider';
import { UserMenu } from '../components/UserMenu';
import { WorkspaceCard } from '../components/WorkspaceCard';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { listWorkspaces, stopWorkspace, restartWorkspace, deleteWorkspace } from '../lib/api';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';
import { PageLayout, Button, Alert, Spinner } from '@simple-agent-manager/ui';

/**
 * Dashboard page showing user profile and workspaces.
 */
export function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
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

  // Use setTimeout chain instead of setInterval so the poll rate
  // adapts immediately when workspaces enter/leave transitional states
  // without tearing down and recreating the interval on every data change.
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
    try {
      await stopWorkspace(id);
      await loadWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop workspace');
    }
  };

  const handleRestartWorkspace = async (id: string) => {
    try {
      await restartWorkspace(id);
      await loadWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart workspace');
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
    try {
      await deleteWorkspace(deleteTarget.id);
      setDeleteTarget(null);
      await loadWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete workspace');
      setDeleteTarget(null);
    } finally {
      setDeleteLoading(false);
    }
  };

  const activeCount = workspaces.filter(w => w.status === 'running').length;

  return (
    <PageLayout
      title="Simple Agent Manager"
      maxWidth="xl"
      headerRight={<UserMenu />}
    >
      {/* Welcome section */}
      <div style={{ marginBottom: 'var(--sam-space-8)' }}>
        <h2 style={{ fontSize: 'clamp(1.25rem, 3vw, 1.5rem)', fontWeight: 700, color: 'var(--sam-color-fg-primary)' }}>
          Welcome, {user?.name || user?.email}!
        </h2>
        <p style={{ color: 'var(--sam-color-fg-muted)', marginTop: 'var(--sam-space-1)' }}>
          Manage your AI coding workspaces
        </p>
      </div>

      <style>{`
        .sam-quick-actions { grid-template-columns: 1fr; }
        @media (min-width: 768px) { .sam-quick-actions { grid-template-columns: repeat(4, 1fr); } }
        .sam-workspace-grid { grid-template-columns: 1fr; }
        @media (min-width: 768px) { .sam-workspace-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (min-width: 1024px) { .sam-workspace-grid { grid-template-columns: repeat(3, 1fr); } }
      `}</style>
      {/* Quick actions */}
      <div className="sam-quick-actions" style={{ display: 'grid', gap: 'var(--sam-space-4)', marginBottom: 'var(--sam-space-8)' }}>
        <Button
          onClick={() => navigate('/workspaces/new')}
          size="lg"
          style={{ width: '100%', justifyContent: 'center', gap: '0.5rem' }}
        >
          <svg style={{ height: 20, width: 20 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          <span>New Workspace</span>
        </Button>
        <Button
          onClick={() => navigate('/nodes')}
          variant="secondary"
          size="lg"
          style={{ width: '100%', justifyContent: 'center', gap: '0.5rem' }}
        >
          <svg style={{ height: 20, width: 20 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 6h14M5 12h14M5 18h14" />
          </svg>
          <span>Nodes</span>
        </Button>
        <Button
          onClick={() => navigate('/settings')}
          variant="secondary"
          size="lg"
          style={{ width: '100%', justifyContent: 'center', gap: '0.5rem' }}
        >
          <svg style={{ height: 20, width: 20 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span>Settings</span>
        </Button>
        <div style={{
          padding: 'var(--sam-space-4)',
          backgroundColor: 'var(--sam-color-bg-surface)',
          border: '1px solid var(--sam-color-border-default)',
          borderRadius: 'var(--sam-radius-md)',
        }}>
          <div style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>Active Workspaces</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--sam-color-fg-primary)' }}>{activeCount}</div>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div style={{ marginBottom: 'var(--sam-space-6)' }}>
          <Alert variant="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        </div>
      )}

      {/* Workspaces section */}
      <div style={{ marginBottom: 'var(--sam-space-6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sam-space-4)' }}>
          <h3 style={{ fontSize: '1.125rem', fontWeight: 500, color: 'var(--sam-color-fg-primary)' }}>Your Workspaces</h3>
          {hasTransitionalWorkspaces && (
            <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)', display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
              <Spinner size="sm" />
              Updating...
            </span>
          )}
        </div>

        {loading ? (
          <div style={{ padding: 'var(--sam-space-8)', display: 'flex', justifyContent: 'center' }}>
            <Spinner size="lg" />
          </div>
        ) : workspaces.length === 0 ? (
          <div style={{
            backgroundColor: 'var(--sam-color-bg-surface)',
            borderRadius: 'var(--sam-radius-lg)',
            border: '1px solid var(--sam-color-border-default)',
            padding: 'var(--sam-space-8)',
            textAlign: 'center',
          }}>
            <svg style={{ margin: '0 auto', height: 48, width: 48, color: 'var(--sam-color-fg-muted)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            <p style={{ marginTop: 'var(--sam-space-4)', color: 'var(--sam-color-fg-muted)' }}>No workspaces yet.</p>
            <div style={{ marginTop: 'var(--sam-space-4)' }}>
              <Button onClick={() => navigate('/workspaces/new')}>
                Create your first workspace
              </Button>
            </div>
          </div>
        ) : (
          <div className="sam-workspace-grid" style={{ display: 'grid', gap: 'var(--sam-space-4)' }}>
            {workspaces.map((workspace) => (
              <WorkspaceCard
                key={workspace.id}
                workspace={workspace}
                onStop={handleStopWorkspace}
                onRestart={handleRestartWorkspace}
                onDelete={handleDeleteWorkspace}
              />
            ))}
          </div>
        )}
      </div>

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
