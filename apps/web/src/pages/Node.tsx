import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Event, NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import { Alert, Button, PageLayout, Skeleton, StatusBadge } from '@simple-agent-manager/ui';
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
  const [eventsError, setEventsError] = useState<string | null>(null);
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
    const interval = window.setInterval(() => {
      void loadNode();
    }, 10000);
    return () => window.clearInterval(interval);
  }, [loadNode]);

  // Fetch node events via control plane proxy (vm-* DNS records lack SSL termination)
  useEffect(() => {
    if (!id || !node || node.status !== 'running') {
      return;
    }

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
          {/* Node info skeleton */}
          <div
            aria-hidden="true"
            style={{
              border: '1px solid var(--sam-color-border-default)',
              borderRadius: 'var(--sam-radius-md)',
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
            <div style={{ borderTop: '1px solid var(--sam-color-border-default)', paddingTop: 'var(--sam-space-4)', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 'var(--sam-space-4)' }}>
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i}>
                  <Skeleton width="50%" height="0.75rem" style={{ marginBottom: 'var(--sam-space-1)' }} />
                  <Skeleton width="70%" height="0.875rem" />
                </div>
              ))}
            </div>
          </div>
          {/* Workspaces skeleton */}
          <div>
            <Skeleton width="120px" height="1.125rem" style={{ marginBottom: 'var(--sam-space-3)' }} />
            <Skeleton width="60%" height="0.875rem" />
          </div>
        </div>
      ) : !node ? (
        <Alert variant="error">Node not found</Alert>
      ) : (
        <>
          <section
            style={{
              border: '1px solid var(--sam-color-border-default)',
              borderRadius: 'var(--sam-radius-md)',
              padding: 'var(--sam-space-6)',
              background: 'var(--sam-color-bg-surface)',
              marginBottom: 'var(--sam-space-6)',
              display: 'grid',
              gap: 'var(--sam-space-4)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--sam-space-3)' }}>
              <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>{node.name}</h2>
              <div style={{ display: 'flex', gap: 'var(--sam-space-2)', alignItems: 'center' }}>
                <StatusBadge status={node.status} />
                <StatusBadge status={node.healthStatus || 'stale'} />
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: 'var(--sam-space-4)',
                borderTop: '1px solid var(--sam-color-border-default)',
                paddingTop: 'var(--sam-space-4)',
              }}
            >
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', marginBottom: 'var(--sam-space-1)' }}>Size</div>
                <div style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-primary)', fontWeight: 500 }}>{node.vmSize}</div>
              </div>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', marginBottom: 'var(--sam-space-1)' }}>Location</div>
                <div style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-primary)', fontWeight: 500 }}>{node.vmLocation}</div>
              </div>
              {node.ipAddress && (
                <div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', marginBottom: 'var(--sam-space-1)' }}>IP Address</div>
                  <div style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-primary)', fontFamily: 'monospace' }}>{node.ipAddress}</div>
                </div>
              )}
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', marginBottom: 'var(--sam-space-1)' }}>Last Heartbeat</div>
                <div style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-primary)' }}>{formatTimestamp(node.lastHeartbeatAt)}</div>
              </div>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', marginBottom: 'var(--sam-space-1)' }}>Created</div>
                <div style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-primary)' }}>{new Date(node.createdAt).toLocaleString()}</div>
              </div>
            </div>

            {node.errorMessage && (
              <div
                style={{
                  padding: 'var(--sam-space-3)',
                  backgroundColor: 'rgba(248, 113, 113, 0.1)',
                  borderRadius: 'var(--sam-radius-sm)',
                  border: '1px solid rgba(248, 113, 113, 0.3)',
                  fontSize: '0.875rem',
                  color: '#f87171',
                }}
              >
                {node.errorMessage}
              </div>
            )}
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
            {eventsError ? (
              <div
                style={{
                  padding: 'var(--sam-space-3)',
                  backgroundColor: 'rgba(248, 113, 113, 0.1)',
                  borderRadius: 'var(--sam-radius-sm)',
                  border: '1px solid rgba(248, 113, 113, 0.3)',
                  fontSize: '0.875rem',
                  color: '#f87171',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span>Failed to load events</span>
                <button
                  onClick={() => {
                    setEventsError(null);
                    void listNodeEvents(id!, 50).then((data) => {
                      setEvents(data.events || []);
                    }).catch((err) => {
                      setEventsError(err instanceof Error ? err.message : 'Failed to load events');
                    });
                  }}
                  style={{
                    background: 'none',
                    border: '1px solid rgba(248, 113, 113, 0.5)',
                    borderRadius: 'var(--sam-radius-sm)',
                    color: '#f87171',
                    cursor: 'pointer',
                    padding: '4px 12px',
                    fontSize: '0.8125rem',
                  }}
                >
                  Retry
                </button>
              </div>
            ) : events.length === 0 ? (
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
