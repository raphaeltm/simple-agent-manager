import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NodeResponse, VMSize, VMLocation } from '@simple-agent-manager/shared';
import { Alert, Button, PageLayout, Select, Skeleton, StatusBadge, EmptyState } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { DropdownMenu, type DropdownMenuItem } from '@simple-agent-manager/ui';
import { createNode, listNodes, deleteNode, stopNode } from '../lib/api';
import { Server } from 'lucide-react';

const VM_SIZES: { value: VMSize; label: string; description: string }[] = [
  { value: 'small', label: 'Small', description: '2 vCPUs, 4 GB RAM' },
  { value: 'medium', label: 'Medium', description: '4 vCPUs, 8 GB RAM' },
  { value: 'large', label: 'Large', description: '8 vCPUs, 16 GB RAM' },
];

const VM_LOCATIONS: { value: VMLocation; label: string }[] = [
  { value: 'nbg1', label: 'Nuremberg, DE' },
  { value: 'fsn1', label: 'Falkenstein, DE' },
  { value: 'hel1', label: 'Helsinki, FI' },
];

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
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newNodeSize, setNewNodeSize] = useState<VMSize>('medium');
  const [newNodeLocation, setNewNodeLocation] = useState<VMLocation>('nbg1');
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
      const created = await createNode({
        name: `node-${timestamp}`,
        vmSize: newNodeSize,
        vmLocation: newNodeLocation,
      });
      setShowCreateForm(false);
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
        <Button onClick={() => setShowCreateForm((v) => !v)} disabled={creating}>
          {showCreateForm ? 'Cancel' : 'Create Node'}
        </Button>
      </div>

      {showCreateForm && (
        <div
          style={{
            marginBottom: 'var(--sam-space-4)',
            border: '1px solid var(--sam-color-border-default)',
            borderRadius: 'var(--sam-radius-md)',
            background: 'var(--sam-color-bg-surface)',
            padding: 'var(--sam-space-4)',
            display: 'grid',
            gap: 'var(--sam-space-4)',
          }}
        >
          <div>
            <label style={{ display: 'block', fontSize: 'var(--sam-type-secondary-size)', fontWeight: 500, color: 'var(--sam-color-fg-muted)', marginBottom: '0.5rem' }}>Node Size</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--sam-space-3)' }}>
              {VM_SIZES.map((size) => (
                <button
                  key={size.value}
                  type="button"
                  onClick={() => setNewNodeSize(size.value)}
                  style={{
                    padding: 'var(--sam-space-3)',
                    border: newNodeSize === size.value
                      ? '2px solid var(--sam-color-accent-primary)'
                      : '1px solid var(--sam-color-border-default)',
                    borderRadius: 'var(--sam-radius-md)',
                    textAlign: 'left',
                    cursor: 'pointer',
                    backgroundColor: newNodeSize === size.value
                      ? 'var(--sam-color-accent-primary-tint)'
                      : 'var(--sam-color-bg-inset)',
                    color: 'var(--sam-color-fg-primary)',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <div style={{ fontWeight: 500 }}>{size.label}</div>
                  <div style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)', marginTop: '0.125rem' }}>
                    {size.description}
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor="node-location" style={{ display: 'block', fontSize: 'var(--sam-type-secondary-size)', fontWeight: 500, color: 'var(--sam-color-fg-muted)', marginBottom: '0.25rem' }}>Location</label>
            <Select id="node-location" value={newNodeLocation} onChange={(e) => setNewNodeLocation(e.target.value as VMLocation)}>
              {VM_LOCATIONS.map((loc) => (
                <option key={loc.value} value={loc.value}>{loc.label}</option>
              ))}
            </Select>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={handleCreateNode} disabled={creating} loading={creating}>
              Create Node
            </Button>
          </div>
        </div>
      )}

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
          action={{ label: 'Create Node', onClick: () => setShowCreateForm(true) }}
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
