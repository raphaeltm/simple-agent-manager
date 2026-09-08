import type { CredentialProvider, VMSize, WorkspaceResponse } from '@simple-agent-manager/shared';
import { PROVIDER_LABELS, VM_SIZE_LABELS } from '@simple-agent-manager/shared';
import {
  Alert,
  Button,
  EmptyState,
  PageLayout,
  Select,
  SkeletonCard,
  Spinner,
} from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Server } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { nodeCreationCatalogs } from '../components/node/node-creation-catalogs';
import { NodeCard } from '../components/node/NodeCard';
import { useQueryScope } from '../hooks/useQueryScope';
import { createNode, deleteNode, stopNode } from '../lib/api';
import { NODE_LIST_POLL_MS, WORKSPACE_LIST_POLL_MS } from '../lib/poll-intervals';
import {
  nodeListQueryOptions,
  nodeQueryKeys,
  providerCatalogQueryOptions,
  workspaceListQueryOptions,
} from '../lib/query-options';
import { userDefaultCapacityPoolsQueryOptions } from '../lib/query-options/capacity-pools';

export function Nodes() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queryScope = useQueryScope();

  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newNodeLocation, setNewNodeLocation] = useState('');
  const [newNodeVmSize, setNewNodeVmSize] = useState<VMSize>('medium');
  const [nativeInstanceType, setNativeInstanceType] = useState('');
  const [useLegacyPreset, setUseLegacyPreset] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [error, setError] = useState<string | null>(null);

  // --- Data fetching via TanStack Query ---

  const {
    data: nodes,
    isLoading: nodesLoading,
    isFetching: nodesFetching,
    isError: nodesError,
    error: nodesQueryError,
  } = useQuery({
    ...nodeListQueryOptions(queryScope),
    enabled: Boolean(queryScope),
    refetchInterval: NODE_LIST_POLL_MS > 0 ? NODE_LIST_POLL_MS : false,
  });

  const { data: workspaces } = useQuery({
    ...workspaceListQueryOptions(queryScope),
    enabled: Boolean(queryScope),
    refetchInterval: WORKSPACE_LIST_POLL_MS > 0 ? WORKSPACE_LIST_POLL_MS : false,
  });

  const { data: catalogData } = useQuery({
    ...providerCatalogQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });

  const { data: poolResponse, isPending: poolLoading, isError: poolError } = useQuery({
    ...userDefaultCapacityPoolsQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });
  const poolSummary = poolResponse?.effectiveSummary;
  const catalogs = nodeCreationCatalogs(catalogData ?? [], poolSummary);

  // Auto-select first provider once catalog loads, if nothing selected yet
  const effectiveProvider = selectedProvider || catalogs[0]?.provider || '';
  const activeCatalog = catalogs.find((c) => c.provider === effectiveProvider);
  const legacySizes = activeCatalog?.sizes;
  const nodeLocation = newNodeLocation || activeCatalog?.defaultLocation || '';
  const nativeOfferings = (activeCatalog?.offerings ?? []).filter(
    (offering) =>
      offering.provider === effectiveProvider && offering.location === nodeLocation
      && offering.available !== false && !offering.stale
  );
  const selectedOffering = nativeOfferings.find(
    (offering) => offering.providerInstanceType === nativeInstanceType
  );
  // An absent field identifies an older catalog contract. A modern empty catalog
  // must never silently fall back to a legacy preset.
  const legacyCatalog = activeCatalog?.sizes !== undefined && activeCatalog.offerings === undefined;
  const validLocation = activeCatalog?.locations.some((location) => location.id === nodeLocation);
  const canCreateNode = Boolean(validLocation && (
    selectedOffering || (legacyCatalog && useLegacyPreset && activeCatalog?.sizes?.[newNodeVmSize])
  ));

  // --- Derived state ---

  const isLoading = nodesLoading;
  const isRefreshing = nodesFetching && !!nodes;

  const sortedNodes = useMemo(
    () => [...(nodes ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [nodes]
  );

  const workspacesByNode = useMemo(() => {
    const map = new Map<string, WorkspaceResponse[]>();
    for (const ws of workspaces ?? []) {
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
    if (!canCreateNode) return;
    try {
      setCreating(true);
      setError(null);
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').toLowerCase();
      const provider = effectiveProvider;
      const created = await createNode({
        name: `node-${timestamp}`,
        ...(selectedOffering
          ? { providerInstanceType: selectedOffering.providerInstanceType }
          : { vmSize: newNodeVmSize }),
        vmLocation: nodeLocation,
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
      void queryClient.invalidateQueries({ queryKey: nodeQueryKeys.all(queryScope) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop node');
    }
  };

  const handleDeleteNode = async (id: string) => {
    const targetNode = (nodes ?? []).find((n) => n.id === id);
    if (targetNode?.nodeRole === 'deployment') {
      const envs = targetNode.deploymentEnvironments ?? [];
      const envSummary =
        envs.length > 0
          ? `${envs.length} deployment environment${envs.length === 1 ? '' : 's'}: ${envs.map((env) => env.name).join(', ')}`
          : 'deployment environments currently listed on this node';
      const confirmed = window.confirm(
        `"${targetNode.name}" is a deployment node hosting ${envSummary}. Deleting it here destroys the node infrastructure and affects ALL hosted environments, but it does not perform each environment's volume teardown.\n\nFor full per-environment teardown, use Destroy on the project Deployments page.\n\nContinue with node-only deletion?`
      );
      if (!confirmed) return;
    }
    try {
      await deleteNode(id);
      void queryClient.invalidateQueries({ queryKey: nodeQueryKeys.all(queryScope) });
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
        <Button onClick={() => setShowCreateForm((v) => !v)} disabled={creating} variant={showCreateForm ? 'secondary' : 'primary'}>
          {showCreateForm ? 'Cancel' : 'Create Node'}
        </Button>
      </div>

      {showCreateForm && (
        <div className="mb-4 glass-surface rounded-md p-4 grid gap-4 min-w-0">
          {poolSummary?.scope === 'installation' && (
            <p className="sam-type-secondary text-fg-muted m-0">Installation-funded compute</p>
          )}
          {(poolLoading || poolError || catalogs.length === 0) && (
            <p className="sam-type-secondary text-fg-muted m-0" role="status">
              {poolLoading ? 'Loading available compute…' : poolError
                ? 'Unable to load available compute. Please retry.'
                : poolSummary?.state === 'migration-pending'
                  ? 'Compute pool migration is in progress. Please retry shortly.'
                  : 'No available native offerings in the current compute pool.'}
            </p>
          )}
          {catalogs.length > 0 && (
            <div>
              <label
                htmlFor="node-provider"
                className="block text-fg-muted font-medium mb-1"
                style={{ fontSize: 'var(--sam-type-secondary-size)' }}
              >
                Cloud Provider
              </label>
              <Select
                id="node-provider"
                value={activeCatalog ? effectiveProvider : ''}
                onChange={(e) => {
                  const p = e.target.value;
                  setSelectedProvider(p);
                  setNativeInstanceType('');
                  setUseLegacyPreset(false);
                  const cat = catalogs.find((c) => c.provider === p);
                  if (cat) setNewNodeLocation(cat.defaultLocation);
                }}
              >
                {!activeCatalog && <option value="" disabled>Choose a provider</option>}
                {catalogs.map((cat) => (
                  <option key={cat.provider} value={cat.provider}>
                    {PROVIDER_LABELS[cat.provider] ?? cat.provider}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {activeCatalog && (
            <div className="min-w-0">
              <label
                htmlFor="node-location"
                className="block text-fg-muted font-medium mb-1"
                style={{ fontSize: 'var(--sam-type-secondary-size)' }}
              >
                Location
              </label>
              <Select
                id="node-location"
                value={nodeLocation}
                onChange={(e) => {
                  setNewNodeLocation(e.target.value);
                  setNativeInstanceType('');
                }}
              >
                {activeCatalog.locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}, {loc.country}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {activeCatalog && !legacyCatalog && (
            <div className="min-w-0">
              <label
                htmlFor="node-offering"
                className="block text-fg-muted font-medium mb-1"
                style={{ fontSize: 'var(--sam-type-secondary-size)' }}
              >
                Native offering
              </label>
              <Select
                id="node-offering"
                className="min-w-0 max-w-full"
                value={selectedOffering?.providerInstanceType ?? ''}
                onChange={(e) => {
                  setSelectedProvider(effectiveProvider);
                  setNewNodeLocation(nodeLocation);
                  setNativeInstanceType(e.target.value);
                }}
                disabled={nativeOfferings.length === 0}
                aria-describedby="node-offering-help"
              >
                <option value="">Choose an offering</option>
                {nativeOfferings.map((offering) => (
                  <option key={offering.providerInstanceType} value={offering.providerInstanceType}>
                    {offering.providerInstanceType}
                    {offering.displayName && offering.displayName.toLowerCase() !== offering.providerInstanceType.toLowerCase()
                      ? ` (${offering.displayName})` : ''} — {offering.vcpu ?? '?'} vCPU,
                    {' '}{offering.memoryMb == null ? '?' : offering.memoryMb / 1024} GB
                    {offering.price ? ` · ${offering.price}` : ''}
                  </option>
                ))}
              </Select>
              {selectedOffering && (
                <p className="sam-type-secondary text-fg-muted mt-2 mb-0 [overflow-wrap:anywhere]" aria-label="Selected offering resources">
                  {selectedOffering.vcpu ?? '?'} vCPU · {selectedOffering.memoryMb == null ? '?' : selectedOffering.memoryMb / 1024} GB memory
                  {selectedOffering.diskGb == null ? '' : ` · ${selectedOffering.diskGb} GB disk`}
                  {selectedOffering.price ? ` · ${selectedOffering.price}` : ''}
                </p>
              )}
              <p id="node-offering-help" className="sam-type-secondary text-fg-muted mt-2 mb-0 break-words">
                {nativeOfferings.length === 0
                  ? 'No available native offerings in this location.'
                  : 'Choose the provider instance to create. Your compute pool must allow this offering.'}
              </p>
            </div>
          )}
          {legacyCatalog && (
            <div>
              <p className="sam-type-secondary text-fg-muted mt-0 mb-2">
                This older catalog does not list native offerings. A compatibility preset is a request estimate;
                your compute pool determines the actual instance.
              </p>
              <label className="flex items-center gap-2 sam-type-secondary">
                <input
                  type="checkbox"
                  checked={useLegacyPreset}
                  onChange={(e) => setUseLegacyPreset(e.target.checked)}
                />
                Use a legacy compatibility preset
              </label>
            </div>
          )}
          {legacyCatalog && useLegacyPreset && legacySizes && (
            <div>
              <label
                htmlFor="node-size"
                className="block text-fg-muted font-medium mb-1"
                style={{ fontSize: 'var(--sam-type-secondary-size)' }}
              >
                Compatibility preset
              </label>
              <Select
                id="node-size"
                value={newNodeVmSize}
                onChange={(e) => setNewNodeVmSize(e.target.value as VMSize)}
              >
                {(Object.keys(legacySizes) as VMSize[]).map((size) => {
                  const info = legacySizes[size];
                  const label = VM_SIZE_LABELS[size];
                  return (
                    <option key={size} value={size}>
                      {label?.label ?? size} — {info?.vcpu ?? '?'} vCPU, {info?.ramGb ?? '?'} GB
                      {info?.price ? ` · ${info.price}` : ''}
                    </option>
                  );
                })}
              </Select>
            </div>
          )}
          <div className="flex justify-end">
            <Button onClick={handleCreateNode} disabled={creating || !canCreateNode} loading={creating}>
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
          {(nodesQueryError instanceof Error && nodesQueryError.message) || 'Failed to load nodes'}
        </Alert>
      ) : sortedNodes.length === 0 ? (
        !showCreateForm && <EmptyState
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
              catalogs={catalogData ?? []}
            />
          ))}
        </div>
      )}
    </PageLayout>
  );
}
