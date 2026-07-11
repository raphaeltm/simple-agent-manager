import type { CredentialProvider,NodeResponse, ProviderCatalog, VMSize, WorkspaceResponse } from '@simple-agent-manager/shared';
import { DEFAULT_VM_LOCATION,PROVIDER_LABELS } from '@simple-agent-manager/shared';
import { Alert, Button, EmptyState, PageLayout, Select, SkeletonCard, Spinner } from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Server } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { NodeCard } from '../components/node/NodeCard';
import { VmSizeCard } from '../components/vm/VmSizeCard';
import { createNode, deleteNode, getProviderCatalog, listNodes, listWorkspaces, stopNode } from '../lib/api';
import { workspacesKeys } from './Workspaces';

/** Stable query key factory for node-related queries. */
export const nodesKeys = {
  all: ['nodes'] as const,
  list: () => ['nodes', 'list'] as const,
  catalog: () => ['nodes', 'catalog'] as const,
};

export function Nodes() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newNodeSize, setNewNodeSize] = useState<VMSize>('medium');
  const [newNodeLocation, setNewNodeLocation] = useState(DEFAULT_VM_LOCATION);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [error, setError] = useState<string | null>(null);

  // --- Data fetching via TanStack Query ---

  const {
    data: nodes,
    isLoading: nodesLoading,
    isFetching: nodesFetching,
    isError: nodesError,
    error: nodesQueryError,
  } = useQuery<NodeResponse[]>({
    queryKey: nodesKeys.list(),
    queryFn: listNodes,
    refetchInterval: 10_000,
  });

  const { data: workspaces } = useQuery<WorkspaceResponse[]>({
    queryKey: workspacesKeys.list(undefined),
    queryFn: () => listWorkspaces(),
    refetchInterval: 10_000,
  });

  const { data: catalogData } = useQuery<{ catalogs: ProviderCatalog[] }>({
    queryKey: nodesKeys.catalog(),
    queryFn: getProviderCatalog,
    staleTime: 60_000, // catalog rarely changes; keep longer
  });

  const catalogs = catalogData?.catalogs ?? [];

  // Auto-select first provider once catalog loads, if nothing selected yet
  const effectiveProvider = selectedProvider || catalogs[0]?.provider || '';
  const activeCatalog = catalogs.find((c) => c.provider === effectiveProvider);

  // --- Derived state ---

  const isLoading = nodesLoading;
  const isRefreshing = nodesFetching && !!nodes;

  const sortedNodes = useMemo(
    () => [...(nodes ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [nodes]
  );

  const workspacesByNode = useMemo(() => {
    const map = new Map<string, WorkspaceResponse[]>();
    for (const ws of (workspaces ?? [])) {
      if (ws.nodeId) {
        const existing = map.get(ws.nodeId) ?? [];
        existing.push(ws);
        map.set(ws.nodeId, existing);
      }
    }
    return map;
  }, [workspaces]);

  // --- Mutation handlers ---

  const handleCreateNode = async () => {
    try {
      setCreating(true);
      setError(null);
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').toLowerCase();
      const provider = effectiveProvider;
      const created = await createNode({
        name: `node-${timestamp}`,
        vmSize: newNodeSize,
        vmLocation: newNodeLocation,
        ...(provider ? { provider: provider as CredentialProvider } : {}),
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
      void queryClient.invalidateQueries({ queryKey: nodesKeys.all });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop node');
    }
  };

  const handleDeleteNode = async (id: string) => {
    const targetNode = (nodes ?? []).find((n) => n.id === id);
    if (targetNode?.nodeRole === 'deployment') {
      const envs = targetNode.deploymentEnvironments ?? [];
      const envSummary = envs.length > 0
        ? `${envs.length} deployment environment${envs.length === 1 ? '' : 's'}: ${envs.map((env) => env.name).join(', ')}`
        : 'deployment environments currently listed on this node';
      const confirmed = window.confirm(
        `"${targetNode.name}" is a deployment node hosting ${envSummary}. Deleting it here destroys the node infrastructure and affects ALL hosted environments, but it does not perform each environment's volume teardown.\n\nFor full per-environment teardown, use Destroy on the project Deployments page.\n\nContinue with node-only deletion?`
      );
      if (!confirmed) return;
    }
    try {
      await deleteNode(id);
      void queryClient.invalidateQueries({ queryKey: nodesKeys.all });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete node');
    }
  };

  const handleCreateWorkspace = (nodeId: string) => {
    navigate(`/nodes/${nodeId}`);
  };

  return (
    <PageLayout title="Nodes" maxWidth="xl">
      <div className="flex justify-between items-center mb-6 gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <p className="sam-type-secondary m-0 text-fg-muted">
            Nodes host workspaces or project deployment environments.
          </p>
          {isRefreshing && <Spinner size="sm" />}
        </div>
        <Button onClick={() => setShowCreateForm((v) => !v)} disabled={creating}>
          {showCreateForm ? 'Cancel' : 'Create Node'}
        </Button>
      </div>

      {showCreateForm && (
        <div className="mb-4 glass-surface rounded-md p-4 grid gap-4">
          {catalogs.length > 1 && (
            <div>
              <label htmlFor="node-provider" className="block text-fg-muted font-medium mb-1" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>Cloud Provider</label>
              <Select id="node-provider" value={effectiveProvider} onChange={(e) => {
                const p = e.target.value;
                setSelectedProvider(p);
                const cat = catalogs.find((c) => c.provider === p);
                if (cat) setNewNodeLocation(cat.defaultLocation);
              }}>
                {catalogs.map((cat) => (
                  <option key={cat.provider} value={cat.provider}>
                    {PROVIDER_LABELS[cat.provider] ?? cat.provider}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div>
            <label className="block text-fg-muted font-medium mb-2" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>Node Size</label>
            <div className="grid grid-cols-3 gap-3">
              {(['small', 'medium', 'large'] as VMSize[]).map((size) => (
                <VmSizeCard
                  key={size}
                  size={size}
                  sizeInfo={activeCatalog?.sizes[size] ?? null}
                  selected={newNodeSize === size}
                  onClick={() => setNewNodeSize(size)}
                />
              ))}
            </div>
          </div>
          {activeCatalog && (
            <div>
              <label htmlFor="node-location" className="block text-fg-muted font-medium mb-1" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>Location</label>
              <Select id="node-location" value={newNodeLocation} onChange={(e) => setNewNodeLocation(e.target.value)}>
                {activeCatalog.locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>{loc.name}, {loc.country}</option>
                ))}
              </Select>
            </div>
          )}
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

      {isLoading && !((nodes ?? []).length > 0) ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <SkeletonCard key={i} lines={3} />
          ))}
        </div>
      ) : nodesError && sortedNodes.length === 0 ? (
        // Initial load failed with no cached data: surface the error instead of
        // a misleading "No nodes yet" empty state. A background refetch failure
        // while stale data is present keeps the data mounted (below).
        <Alert variant="error">
          {nodesQueryError instanceof Error ? nodesQueryError.message : 'Failed to load nodes'}
        </Alert>
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
              catalogs={catalogs}
            />
          ))}
        </div>
      )}
    </PageLayout>
  );
}
