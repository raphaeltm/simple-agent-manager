import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NodeResponse } from '@simple-agent-manager/shared';
import { Alert, Button, PageLayout, Skeleton, StatusBadge, EmptyState } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { DropdownMenu, type DropdownMenuItem } from '@simple-agent-manager/ui';
import { createNode, listNodes, deleteNode, stopNode } from '../lib/api';
import { Server } from 'lucide-react';

function formatHeartbeat(value: string | null): string {
  if (!value) return 'No heartbeat yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Invalid heartbeat timestamp';
  return date.toLocaleDateString();
}

function getNodeActions(
  node: NodeResponse,
  handlers: { onStop: (id: string) => void; onDelete: (id: string) => void },
): DropdownMenuItem[] {
  const items: DropdownMenuItem[] = [];
  const isTransitional = node.status === 'creating' || node.status === 'stopping';

  if (node.status === 'running') {
    items.push({
      id: 'stop',
      label: 'Stop',
      onClick: () => handlers.onStop(node.id),
    });
  }

  items.push({
    id: 'delete',
    label: 'Delete',
    variant: 'danger',
    onClick: () => handlers.onDelete(node.id),
    disabled: isTransitional,
    disabledReason: 'Cannot delete while node is transitioning',
  });

  return items;
}

export function Nodes() {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<NodeResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadNodes = useCallback(async () => {
    try {
      setError(null);
      const response = await listNodes();
      setNodes(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load nodes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNodes();
    const interval = window.setInterval(() => {
      void loadNodes();
    }, 10000);
    return () => window.clearInterval(interval);
  }, [loadNodes]);

  const handleCreateNode = async () => {
    try {
      setCreating(true);
      setError(null);
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').toLowerCase();
      const created = await createNode({ name: `node-${timestamp}` });
      navigate(`/nodes/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create node');
    } finally {
      setCreating(false);
    }
  };

  const handleStopNode = async (id: string) => {
    try {
      await stopNode(id);
      void loadNodes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop node');
    }
  };

  const handleDeleteNode = async (id: string) => {
    try {
      await deleteNode(id);
      void loadNodes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete node');
    }
  };

  const sortedNodes = useMemo(
    () => [...nodes].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [nodes]
  );

  return (
    <PageLayout title="Nodes" maxWidth="xl" headerRight={<UserMenu />}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--sam-space-6)',
          gap: 'var(--sam-space-3)',
          flexWrap: 'wrap',
        }}
      >
        <p className="sam-type-secondary" style={{ margin: 0, color: 'var(--sam-color-fg-muted)' }}>
          Nodes host one or more workspaces.
        </p>
        <Button onClick={handleCreateNode} disabled={creating}>
          {creating ? 'Creating...' : 'Create Node'}
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
        <div style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              aria-hidden="true"
              style={{
                border: '1px solid var(--sam-color-border-default)',
                borderRadius: 'var(--sam-radius-md)',
                padding: 'var(--sam-space-4)',
                background: 'var(--sam-color-bg-surface)',
                display: 'grid',
                gap: 'var(--sam-space-2)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Skeleton width="40%" height="1.125rem" />
                <Skeleton width="60px" height="1.25rem" borderRadius="9999px" />
              </div>
              <Skeleton width="50%" height="0.875rem" />
            </div>
          ))}
        </div>
      ) : sortedNodes.length === 0 ? (
        <EmptyState
          icon={<Server size={48} />}
          heading="No nodes yet"
          description="Create your first node to start hosting workspaces."
          action={{ label: 'Create Node', onClick: handleCreateNode }}
        />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
          {sortedNodes.map((node) => {
            const overflowItems = getNodeActions(node, {
              onStop: handleStopNode,
              onDelete: handleDeleteNode,
            });
            return (
              <div
                key={node.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--sam-space-3)',
                  border: '1px solid var(--sam-color-border-default)',
                  borderRadius: 'var(--sam-radius-md)',
                  padding: 'var(--sam-space-3) var(--sam-space-4)',
                  background: 'var(--sam-color-bg-surface)',
                }}
              >
                <StatusBadge status={node.status} />

                <button
                  onClick={() => navigate(`/nodes/${node.id}`)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: 'left',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--sam-color-fg-primary)',
                    padding: 0,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sam-space-2)' }}>
                    <span className="sam-type-card-title">{node.name}</span>
                    <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)' }}>
                      {node.vmSize} &middot; {node.vmLocation}
                    </span>
                  </div>
                  <div className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)', marginTop: 2 }}>
                    {formatHeartbeat(node.lastHeartbeatAt)}
                  </div>
                </button>

                <StatusBadge status={node.healthStatus || 'stale'} />

                {overflowItems.length > 0 && (
                  <DropdownMenu items={overflowItems} aria-label={`Actions for ${node.name}`} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </PageLayout>
  );
}
