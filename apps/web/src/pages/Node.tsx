import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Event, NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import { Alert, Button, PageLayout, Skeleton } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { useToast } from '../hooks/useToast';
import { useNodeSystemInfo } from '../hooks/useNodeSystemInfo';
import { deleteNode, getNode, listNodeEvents, listWorkspaces, stopNode } from '../lib/api';
import { NodeOverviewSection } from '../components/node/NodeOverviewSection';
import { SystemResourcesSection } from '../components/node/SystemResourcesSection';
import { DockerSection } from '../components/node/DockerSection';
import { SoftwareSection } from '../components/node/SoftwareSection';
import { NodeWorkspacesSection } from '../components/node/NodeWorkspacesSection';
import { NodeEventsSection } from '../components/node/NodeEventsSection';

export function Node() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const toast = useToast();

  const [node, setNode] = useState<NodeResponse | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { systemInfo, loading: sysInfoLoading } = useNodeSystemInfo(id, node?.status);

  const loadNode = useCallback(async () => {
    if (!id) return;

    try {
      setError(null);
      const [nodeResponse, workspaceResponse] = await Promise.all([
        getNode(id),
        listWorkspaces(undefined, id),
      ]);
      setNode(nodeResponse);
      setWorkspaces(workspaceResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load node');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadNode();
    const interval = window.setInterval(() => void loadNode(), 10000);
    return () => window.clearInterval(interval);
  }, [loadNode]);

  // Fetch node events via control plane proxy (vm-* DNS records lack SSL termination)
  useEffect(() => {
    if (!id || !node || node.status !== 'running') return;

    const fetchEvents = async () => {
      try {
        const data = await listNodeEvents(id, 50);
        setEvents(data.events || []);
        setEventsError(null);
      } catch (err) {
        setEventsError(err instanceof Error ? err.message : 'Failed to load events');
      }
    };

    void fetchEvents();
    const interval = window.setInterval(() => void fetchEvents(), 10000);
    return () => window.clearInterval(interval);
  }, [id, node?.status]);

  const handleStop = async () => {
    if (!id || !node) return;

    const confirmed = window.confirm(
      `Stop node "${node.name}"? This stops all workspaces and agent sessions on the node.`
    );
    if (!confirmed) return;

    const prevNode = node;
    const prevWorkspaces = workspaces;
    setNode({ ...node, status: 'stopping' });
    setWorkspaces(ws => ws.map(w =>
      w.status === 'running' ? { ...w, status: 'stopping' as const } : w
    ));
    setStopping(true);
    try {
      await stopNode(id);
      toast.success('Node stopping');
    } catch (err) {
      setNode(prevNode);
      setWorkspaces(prevWorkspaces);
      toast.error(err instanceof Error ? err.message : 'Failed to stop node');
    } finally {
      setStopping(false);
    }
  };

  const handleDelete = async () => {
    if (!id || !node) return;

    const confirmed = window.confirm(
      `Delete node "${node.name}"? This permanently deletes the node and all attached workspaces/sessions.`
    );
    if (!confirmed) return;

    try {
      setDeleting(true);
      await deleteNode(id);
      toast.success('Node deleted');
      navigate('/nodes');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete node');
      setDeleting(false);
    }
  };

  const handleRetryEvents = () => {
    if (!id) return;
    setEventsError(null);
    void listNodeEvents(id, 50).then((data) => {
      setEvents(data.events || []);
    }).catch((err) => {
      setEventsError(err instanceof Error ? err.message : 'Failed to load events');
    });
  };

  return (
    <PageLayout title="Node" maxWidth="xl" headerRight={<UserMenu />}>
      {/* Breadcrumb navigation */}
      <nav
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sam-space-2)',
          marginBottom: 'var(--sam-space-4)',
          fontSize: '0.875rem',
          color: 'var(--sam-color-fg-muted)',
        }}
      >
        <button
          onClick={() => navigate('/dashboard')}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--sam-color-accent-primary)',
            cursor: 'pointer',
            padding: 0,
            fontSize: 'inherit',
          }}
        >
          Dashboard
        </button>
        <span>/</span>
        <button
          onClick={() => navigate('/nodes')}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--sam-color-accent-primary)',
            cursor: 'pointer',
            padding: 0,
            fontSize: 'inherit',
          }}
        >
          Nodes
        </button>
        <span>/</span>
        <span style={{ color: 'var(--sam-color-fg-primary)' }}>{node?.name || 'Loading...'}</span>
      </nav>

      {/* Action buttons */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sam-space-3)',
          marginBottom: 'var(--sam-space-6)',
          flexWrap: 'wrap',
        }}
      >
        <Button onClick={() => navigate('/workspaces/new', { state: id ? { nodeId: id } : undefined })}>
          Create Workspace
        </Button>
        <Button
          variant="secondary"
          onClick={handleStop}
          disabled={stopping || deleting || !node || node.status === 'stopped'}
        >
          {stopping ? 'Stopping...' : 'Stop Node'}
        </Button>
        <Button
          variant="secondary"
          onClick={handleDelete}
          disabled={stopping || deleting || !node}
          style={{ borderColor: 'var(--sam-color-danger)', color: 'var(--sam-color-danger)' }}
        >
          {deleting ? 'Deleting...' : 'Delete Node'}
        </Button>
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--sam-space-4)' }}>
          <Alert variant="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-6)' }}>
          <div
            aria-hidden="true"
            style={{
              border: '1px solid var(--sam-color-border-default)',
              borderRadius: 'var(--sam-radius-lg)',
              padding: 'var(--sam-space-6)',
              background: 'var(--sam-color-bg-surface)',
              display: 'grid',
              gap: 'var(--sam-space-4)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Skeleton width="40%" height="1.25rem" />
              <div style={{ display: 'flex', gap: 'var(--sam-space-2)' }}>
                <Skeleton width="60px" height="1.25rem" borderRadius="9999px" />
                <Skeleton width="60px" height="1.25rem" borderRadius="9999px" />
              </div>
            </div>
            <div
              style={{
                borderTop: '1px solid var(--sam-color-border-default)',
                paddingTop: 'var(--sam-space-4)',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: 'var(--sam-space-4)',
              }}
            >
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i}>
                  <Skeleton width="50%" height="0.75rem" style={{ marginBottom: 'var(--sam-space-1)' }} />
                  <Skeleton width="70%" height="0.875rem" />
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : !node ? (
        <Alert variant="error">Node not found</Alert>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-6)' }}>
          <NodeOverviewSection node={node} systemInfo={systemInfo} />

          {node.status === 'running' && (
            <>
              <SystemResourcesSection
                systemInfo={systemInfo}
                fallbackMetrics={node.lastMetrics}
                loading={sysInfoLoading}
              />
              <DockerSection docker={systemInfo?.docker} loading={sysInfoLoading} />
              <SoftwareSection
                software={systemInfo?.software}
                agent={systemInfo?.agent}
                loading={sysInfoLoading}
              />
            </>
          )}

          <NodeWorkspacesSection
            workspaces={workspaces}
            onNavigate={(wsId) => navigate(`/workspaces/${wsId}`)}
            onCreateWorkspace={() => navigate('/workspaces/new', { state: id ? { nodeId: id } : undefined })}
          />

          <NodeEventsSection
            events={events}
            error={eventsError}
            onRetry={handleRetryEvents}
            nodeStatus={node.status}
          />
        </div>
      )}
    </PageLayout>
  );
}
