import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NodeResponse, WorkspaceResponse, VMSize, VMLocation } from '@simple-agent-manager/shared';
import { Alert, Button, PageLayout, Select, SkeletonCard, EmptyState, Spinner } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { NodeCard } from '../components/node/NodeCard';
import { createNode, listNodes, listWorkspaces, deleteNode, stopNode } from '../lib/api';
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

export function Nodes() {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<NodeResponse[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newNodeSize, setNewNodeSize] = useState<VMSize>('medium');
  const [newNodeLocation, setNewNodeLocation] = useState<VMLocation>('nbg1');
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const loadData = useCallback(async () => {
    if (hasLoadedRef.current) {
      setIsRefreshing(true);
    }
    try {
      setError(null);
      const [nodesResponse, workspacesResponse] = await Promise.all([
        listNodes(),
        listWorkspaces(),
      ]);
      setNodes(nodesResponse);
      setWorkspaces(workspacesResponse);
      hasLoadedRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load nodes');
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
    const interval = window.setInterval(() => {
      void loadData();
    }, 10000);
    return () => window.clearInterval(interval);
  }, [loadData]);

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
      void loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop node');
    }
  };

  const handleDeleteNode = async (id: string) => {
    try {
      await deleteNode(id);
      void loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete node');
    }
  };

  const handleCreateWorkspace = (nodeId: string) => {
    navigate(`/nodes/${nodeId}`);
  };

  const sortedNodes = useMemo(
    () => [...nodes].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [nodes]
  );

  const workspacesByNode = useMemo(() => {
    const map = new Map<string, WorkspaceResponse[]>();
    for (const ws of workspaces) {
      if (ws.nodeId) {
        const existing = map.get(ws.nodeId) ?? [];
        existing.push(ws);
        map.set(ws.nodeId, existing);
      }
    }
    return map;
  }, [workspaces]);

  return (
    <PageLayout title="Nodes" maxWidth="xl" headerRight={<UserMenu />}>
      <div className="flex justify-between items-center mb-6 gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <p className="sam-type-secondary m-0 text-fg-muted">
            Nodes host one or more workspaces.
          </p>
          {isRefreshing && <Spinner size="sm" />}
        </div>
        <Button onClick={() => setShowCreateForm((v) => !v)} disabled={creating}>
          {showCreateForm ? 'Cancel' : 'Create Node'}
        </Button>
      </div>

      {showCreateForm && (
        <div className="mb-4 border border-border-default rounded-md bg-surface p-4 grid gap-4">
          <div>
            <label className="block text-fg-muted font-medium mb-2" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>Node Size</label>
            <div className="grid grid-cols-3 gap-3">
              {VM_SIZES.map((size) => (
                <button
                  key={size.value}
                  type="button"
                  aria-pressed={newNodeSize === size.value}
                  onClick={() => setNewNodeSize(size.value)}
                  className={`p-3 rounded-md text-left cursor-pointer text-fg-primary transition-all duration-150 ${
                    newNodeSize === size.value
                      ? 'border-2 border-accent bg-accent-tint'
                      : 'border border-border-default bg-inset'
                  }`}
                >
                  <div className="font-medium">{size.label}</div>
                  <div className="text-fg-muted mt-0.5" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
                    {size.description}
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor="node-location" className="block text-fg-muted font-medium mb-1" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>Location</label>
            <Select id="node-location" value={newNodeLocation} onChange={(e) => setNewNodeLocation(e.target.value as VMLocation)}>
              {VM_LOCATIONS.map((loc) => (
                <option key={loc.value} value={loc.value}>{loc.label}</option>
              ))}
            </Select>
          </div>
          <div className="flex justify-end">
            <Button onClick={handleCreateNode} disabled={creating} loading={creating}>
              Create Node
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4">
          <Alert variant="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        </div>
      )}

      {loading && nodes.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <SkeletonCard key={i} lines={3} />
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          {sortedNodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              workspaces={workspacesByNode.get(node.id) ?? []}
              onStop={handleStopNode}
              onDelete={handleDeleteNode}
              onCreateWorkspace={handleCreateWorkspace}
            />
          ))}
        </div>
      )}
    </PageLayout>
  );
}
