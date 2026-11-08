import type { CredentialProvider, NodeResponse, VMSize } from '@simple-agent-manager/shared';
import { PROVIDER_LABELS, VM_SIZE_LABELS } from '@simple-agent-manager/shared';
import { Button, Pane, Select } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { createNode } from '../../lib/api';
import { providerCatalogQueryOptions } from '../../lib/query-options';
import { userDefaultCapacityPoolsQueryOptions } from '../../lib/query-options/capacity-pools';
import { nodeCreationCatalogs } from './node-creation-catalogs';

const labelClass = 'block text-fg-muted font-medium mb-1';
const labelStyle = { fontSize: 'var(--sam-type-secondary-size)' } as const;

/** The Nodes page's "Create Node" form: provider, location and offering from the compute pool. */
export function CreateNodeForm({
  creating,
  onCreatingChange,
  onCreated,
  onError,
}: {
  /** Owned by the page so it outlives the form; see `Nodes.tsx`. */
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
  onCreated: (node: NodeResponse) => void;
  onError: (message: string | null) => void;
}) {
  const queryScope = useQueryScope();
  const [newNodeLocation, setNewNodeLocation] = useState('');
  const [newNodeVmSize, setNewNodeVmSize] = useState<VMSize>('medium');
  const [nativeInstanceType, setNativeInstanceType] = useState('');
  const [useLegacyPreset, setUseLegacyPreset] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState('');

  const { data: catalogData } = useQuery({
    ...providerCatalogQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });
  const {
    data: poolResponse,
    isPending: poolLoading,
    isError: poolError,
  } = useQuery({
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
      offering.provider === effectiveProvider &&
      offering.location === nodeLocation &&
      offering.available !== false &&
      !offering.stale
  );
  const selectedOffering = nativeOfferings.find(
    (offering) => offering.providerInstanceType === nativeInstanceType
  );
  // An absent field identifies an older catalog contract. A modern empty catalog
  // must never silently fall back to a legacy preset.
  const legacyCatalog = activeCatalog?.sizes !== undefined && activeCatalog.offerings === undefined;
  const validLocation = activeCatalog?.locations.some((location) => location.id === nodeLocation);
  const canCreateNode = Boolean(
    validLocation &&
    (selectedOffering ||
      (legacyCatalog && useLegacyPreset && activeCatalog?.sizes?.[newNodeVmSize]))
  );

  const handleCreateNode = async () => {
    if (!canCreateNode || creating) return;
    try {
      onCreatingChange(true);
      onError(null);
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
      onCreated(created);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to create node');
    } finally {
      onCreatingChange(false);
    }
  };

  return (
    <Pane as="div" className="grid min-w-0 gap-4 p-4">
      {poolSummary?.scope === 'installation' && (
        <p className="sam-type-secondary m-0 text-fg-muted">Installation-funded compute</p>
      )}
      {(poolLoading || poolError || catalogs.length === 0) && (
        <p className="sam-type-secondary m-0 text-fg-muted" role="status">
          {poolLoading
            ? 'Loading available compute…'
            : poolError
              ? 'Unable to load available compute. Please retry.'
              : poolSummary?.state === 'migration-pending'
                ? 'Compute pool migration is in progress. Please retry shortly.'
                : 'No available native offerings in the current compute pool.'}
        </p>
      )}
      {catalogs.length > 0 && (
        <div>
          <label htmlFor="node-provider" className={labelClass} style={labelStyle}>
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
            {!activeCatalog && (
              <option value="" disabled>
                Choose a provider
              </option>
            )}
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
          <label htmlFor="node-location" className={labelClass} style={labelStyle}>
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
          <label htmlFor="node-offering" className={labelClass} style={labelStyle}>
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
                {offering.displayName &&
                offering.displayName.toLowerCase() !== offering.providerInstanceType.toLowerCase()
                  ? ` (${offering.displayName})`
                  : ''}{' '}
                — {offering.vcpu ?? '?'} vCPU,{' '}
                {offering.memoryMb == null ? '?' : offering.memoryMb / 1024} GB
                {offering.price ? ` · ${offering.price}` : ''}
              </option>
            ))}
          </Select>
          {selectedOffering && (
            <p
              className="sam-type-secondary mt-2 mb-0 text-fg-muted [overflow-wrap:anywhere]"
              aria-label="Selected offering resources"
            >
              {selectedOffering.vcpu ?? '?'} vCPU ·{' '}
              {selectedOffering.memoryMb == null ? '?' : selectedOffering.memoryMb / 1024} GB memory
              {selectedOffering.diskGb == null ? '' : ` · ${selectedOffering.diskGb} GB disk`}
              {selectedOffering.price ? ` · ${selectedOffering.price}` : ''}
            </p>
          )}
          <p
            id="node-offering-help"
            className="sam-type-secondary mt-2 mb-0 break-words text-fg-muted"
          >
            {nativeOfferings.length === 0
              ? 'No available native offerings in this location.'
              : 'Choose the provider instance to create. Your compute pool must allow this offering.'}
          </p>
        </div>
      )}
      {legacyCatalog && (
        <div>
          <p className="sam-type-secondary mt-0 mb-2 text-fg-muted">
            This older catalog does not list native offerings. A compatibility preset is a request
            estimate; your compute pool determines the actual instance.
          </p>
          <label className="sam-type-secondary flex items-center gap-2">
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
          <label htmlFor="node-size" className={labelClass} style={labelStyle}>
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
    </Pane>
  );
}
