import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Event, NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import { Alert, Button, PageLayout, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { deleteNode, getNode, listNodeEvents, listWorkspaces, stopNode } from '../lib/api';

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'No heartbeat yet';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Invalid timestamp';
  }
  return date.toLocaleString();
}

export function Node() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  const [node, setNode] = useState<NodeResponse | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadNode = useCallback(async () => {
    if (!id) {
      return;
    }

    try {
      setError(null);
      const [nodeResponse, workspaceResponse, eventsResponse] = await Promise.all([
        getNode(id),
        listWorkspaces(undefined, id),
        listNodeEvents(id, 50),
      ]);
      setNode(nodeResponse);
      setWorkspaces(workspaceResponse);
      setEvents(eventsResponse.events || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load node');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadNode();
    const interval = window.setInterval(() => {
      void loadNode();
    }, 10000);
    return () => window.clearInterval(interval);
  }, [loadNode]);

  const handleStop = async () => {
    if (!id || !node) {
      return;
    }

    const confirmed = window.confirm(
      `Stop node "${node.name}"? This stops all workspaces and agent sessions on the node.`
    );
    if (!confirmed) {
      return;
    }

    try {
      setStopping(true);
      await stopNode(id);
      await loadNode();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop node');
    } finally {
      setStopping(false);
    }
  };

  const handleDelete = async () => {
    if (!id || !node) {
      return;
    }

    const confirmed = window.confirm(
      `Delete node "${node.name}"? This permanently deletes the node and all attached workspaces/sessions.`
    );
    if (!confirmed) {
      return;
    }

    try {
      setDeleting(true);
      await deleteNode(id);
      navigate('/nodes');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete node');
      setDeleting(false);
    }
  };

  return (
    <PageLayout title="Node" maxWidth="xl" headerRight={<UserMenu />}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sam-space-3)',
          marginBottom: 'var(--sam-space-6)',
          flexWrap: 'wrap',
        }}
      >
        <Button variant="secondary" onClick={() => navigate('/nodes')}>
          Back to Nodes
        </Button>
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
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-8)' }}>
          <Spinner size="lg" />
        </div>
      ) : !node ? (
        <Alert variant="error">Node not found</Alert>
      ) : (
        <>
          <section
            style={{
              border: '1px solid var(--sam-color-border-default)',
              borderRadius: 'var(--sam-radius-md)',
              padding: 'var(--sam-space-5)',
              background: 'var(--sam-color-bg-surface)',
              marginBottom: 'var(--sam-space-6)',
              display: 'grid',
              gap: 'var(--sam-space-2)',
            }}
          >
            <h2 style={{ marginTop: 0, marginBottom: 'var(--sam-space-2)' }}>{node.name}</h2>
            <div style={{ display: 'flex', gap: 'var(--sam-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
              <StatusBadge status={node.status} />
              <StatusBadge status={node.healthStatus || 'stale'} />
              <span style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.875rem' }}>
                Last heartbeat: {formatTimestamp(node.lastHeartbeatAt)}
              </span>
            </div>
          </section>

          <section style={{ marginBottom: 'var(--sam-space-6)' }}>
            <h3 style={{ marginTop: 0 }}>Workspaces</h3>
            {workspaces.length === 0 ? (
              <p style={{ color: 'var(--sam-color-fg-muted)' }}>No workspaces on this node yet.</p>
            ) : (
              <ul style={{ paddingLeft: '1rem', margin: 0 }}>
                {workspaces.map((workspace) => (
                  <li key={workspace.id}>
                    <button
                      onClick={() => navigate(`/workspaces/${workspace.id}`)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--sam-color-accent-primary)',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    >
                      {workspace.displayName || workspace.name}
                    </button>
                    <span style={{ color: 'var(--sam-color-fg-muted)' }}> · {workspace.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 style={{ marginTop: 0 }}>Node Events</h3>
            {events.length === 0 ? (
              <p style={{ color: 'var(--sam-color-fg-muted)' }}>No events yet.</p>
            ) : (
              <div
                style={{
                  border: '1px solid var(--sam-color-border-default)',
                  borderRadius: 'var(--sam-radius-md)',
                  background: 'var(--sam-color-bg-surface)',
                  maxHeight: 280,
                  overflow: 'auto',
                }}
              >
                {events.map((event) => (
                  <div
                    key={event.id}
                    style={{
                      borderBottom: '1px solid var(--sam-color-border-default)',
                      padding: 'var(--sam-space-3)',
                      fontSize: '0.875rem',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--sam-space-2)' }}>
                      <strong>{event.type}</strong>
                      <span style={{ color: 'var(--sam-color-fg-muted)' }}>
                        {new Date(event.createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <div style={{ color: 'var(--sam-color-fg-muted)' }}>{event.message}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </PageLayout>
  );
}
