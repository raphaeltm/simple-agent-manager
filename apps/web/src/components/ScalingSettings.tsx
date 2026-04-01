import type { CredentialProvider,Project } from '@simple-agent-manager/shared';
import {
  DEFAULT_NODE_WARM_TIMEOUT_MS,
  MAX_NODE_IDLE_TIMEOUT_MS,
  MIN_NODE_IDLE_TIMEOUT_MS,
  PROVIDER_DEFAULT_LOCATIONS,
  PROVIDER_LABELS,
  PROVIDER_LOCATIONS,
  SCALING_PARAMS,
  type ScalingParamMeta,
} from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useCallback,useEffect, useState } from 'react';

import { useToast } from '../hooks/useToast';
import { listCredentials,updateProject } from '../lib/api';

/** Format milliseconds as a human-readable duration. */
function formatMs(ms: number): string {
  if (ms >= 60 * 60 * 1000) {
    const h = ms / (60 * 60 * 1000);
    return `${h % 1 === 0 ? h : h.toFixed(1)}h`;
  }
  return `${Math.round(ms / (60 * 1000))}m`;
}

/** A single scaling parameter row with label, input, placeholder, and reset button. */
function ScalingField({
  meta,
  value,
  onChange,
  disabled,
}: {
  meta: ScalingParamMeta;
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
}) {
  const placeholderText =
    meta.unit === 'ms'
      ? formatMs(meta.defaultValue)
      : meta.unit === 'percent'
        ? `${meta.defaultValue}%`
        : String(meta.defaultValue);

  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-fg-muted flex-1 min-w-0" title={`Env: ${meta.envVar}`}>
        {meta.label}
      </label>
      <input
        type="number"
        min={meta.min}
        max={meta.max}
        placeholder={placeholderText}
        value={value ?? ''}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') {
            onChange(null);
          } else {
            const n = Number(raw);
            if (Number.isFinite(n)) onChange(n);
          }
        }}
        disabled={disabled}
        className="w-24 py-1 px-2 border border-border-default rounded-sm bg-inset text-fg-primary text-xs font-[inherit] tabular-nums text-right"
      />
      {meta.unit === 'ms' && value != null && (
        <span className="text-xs text-fg-muted min-w-[3rem]">{formatMs(value)}</span>
      )}
      {meta.unit === 'percent' && <span className="text-xs text-fg-muted">%</span>}
      {value != null && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-xs text-fg-muted hover:text-fg-primary underline"
          title="Reset to platform default"
        >
          Reset
        </button>
      )}
    </div>
  );
}

export function ScalingSettings({
  projectId,
  project,
  reload,
}: {
  projectId: string;
  project: Project;
  reload: () => Promise<void>;
}) {
  const toast = useToast();

  // Provider & Location state
  const [selectedProvider, setSelectedProvider] = useState<CredentialProvider | null>(
    project.defaultProvider ?? null
  );
  const [selectedLocation, setSelectedLocation] = useState<string | null>(
    project.defaultLocation ?? null
  );
  const [configuredProviders, setConfiguredProviders] = useState<CredentialProvider[]>([]);
  const [savingLocation, setSavingLocation] = useState(false);

  // Scaling params state
  const [scalingValues, setScalingValues] = useState<Record<string, number | null>>(() => {
    const initial: Record<string, number | null> = {};
    for (const p of SCALING_PARAMS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      initial[p.key] = (project as any)[p.key] as number | null ?? null;
    }
    return initial;
  });
  const [nodeIdleTimeoutMs, setNodeIdleTimeoutMs] = useState<number | null>(
    project.nodeIdleTimeoutMs ?? null
  );
  const [savingScaling, setSavingScaling] = useState(false);

  // Fetch configured providers
  useEffect(() => {
    listCredentials()
      .then((creds) => {
        const providers = [...new Set(
          creds
            .filter((c) => c.connected)
            .map((c) => c.provider)
        )];
        setConfiguredProviders(providers);
      })
      .catch(() => {});
  }, []);

  // Sync from project prop
  useEffect(() => {
    setSelectedProvider(project.defaultProvider ?? null);
    setSelectedLocation(project.defaultLocation ?? null);
    const updated: Record<string, number | null> = {};
    for (const p of SCALING_PARAMS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updated[p.key] = (project as any)[p.key] as number | null ?? null;
    }
    setScalingValues(updated);
    setNodeIdleTimeoutMs(project.nodeIdleTimeoutMs ?? null);
  }, [project]);

  const handleSaveProviderLocation = useCallback(async () => {
    setSavingLocation(true);
    try {
      await updateProject(projectId, {
        defaultProvider: selectedProvider,
        defaultLocation: selectedLocation,
      });
      await reload();
      toast.success('Provider & location saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSavingLocation(false);
    }
  }, [projectId, selectedProvider, selectedLocation, reload, toast]);

  const handleSaveScaling = useCallback(async () => {
    setSavingScaling(true);
    try {
      const update: Record<string, number | null> = { ...scalingValues };
      update.nodeIdleTimeoutMs = nodeIdleTimeoutMs;
      await updateProject(projectId, update as Parameters<typeof updateProject>[1]);
      await reload();
      toast.success('Scaling settings saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSavingScaling(false);
    }
  }, [projectId, scalingValues, nodeIdleTimeoutMs, reload, toast]);

  const locations = selectedProvider ? (PROVIDER_LOCATIONS[selectedProvider] ?? []) : [];

  // Task limit params
  const taskParams = SCALING_PARAMS.filter((p) =>
    ['taskExecutionTimeoutMs', 'maxConcurrentTasks', 'maxDispatchDepth', 'maxSubTasksPerTask'].includes(p.key)
  );
  // Node scheduling params
  const nodeParams = SCALING_PARAMS.filter((p) =>
    ['warmNodeTimeoutMs', 'maxWorkspacesPerNode', 'nodeCpuThresholdPercent', 'nodeMemoryThresholdPercent'].includes(p.key)
  );

  return (
    <section className="border border-border-default rounded-md bg-surface p-4 grid gap-4">
      <div>
        <h2 className="sam-type-section-heading m-0 text-fg-primary">Scaling & Scheduling</h2>
        <p className="m-0 mt-1 text-xs text-fg-muted">
          Override platform defaults for this project. Empty fields use the platform default shown as placeholder.
        </p>
      </div>

      {/* Provider & Location */}
      <div className="grid gap-3">
        <h3 className="sam-type-card-title m-0 text-fg-primary">Provider & Location</h3>
        <div className="flex gap-3 flex-wrap">
          <div className="flex-1 min-w-[140px]">
            <label htmlFor="scaling-provider" className="block text-xs text-fg-muted mb-0.5">
              Default Provider
            </label>
            <select
              id="scaling-provider"
              value={selectedProvider ?? ''}
              onChange={(e) => {
                const p = (e.target.value || null) as CredentialProvider | null;
                setSelectedProvider(p);
                // Reset location when provider changes
                if (p) {
                  setSelectedLocation(PROVIDER_DEFAULT_LOCATIONS[p] ?? null);
                } else {
                  setSelectedLocation(null);
                }
              }}
              className="w-full py-1.5 px-2 border border-border-default rounded-sm bg-inset text-fg-primary text-xs"
            >
              <option value="">System picks</option>
              {configuredProviders.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p] ?? p}
                </option>
              ))}
            </select>
          </div>
          {selectedProvider && locations.length > 0 && (
            <div className="flex-1 min-w-[140px]">
              <label htmlFor="scaling-location" className="block text-xs text-fg-muted mb-0.5">
                Default Location
              </label>
              <select
                id="scaling-location"
                value={selectedLocation ?? ''}
                onChange={(e) => setSelectedLocation(e.target.value || null)}
                className="w-full py-1.5 px-2 border border-border-default rounded-sm bg-inset text-fg-primary text-xs"
              >
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}, {loc.country}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSaveProviderLocation}
          disabled={savingLocation}
        >
          {savingLocation ? 'Saving...' : 'Save Provider & Location'}
        </Button>
      </div>

      {/* Task Limits */}
      <div className="grid gap-2">
        <h3 className="sam-type-card-title m-0 text-fg-primary">Task Limits</h3>
        {taskParams.map((meta) => (
          <ScalingField
            key={meta.key}
            meta={meta}
            value={scalingValues[meta.key] ?? null}
            onChange={(v) => setScalingValues((prev) => ({ ...prev, [meta.key]: v }))}
            disabled={savingScaling}
          />
        ))}
      </div>

      {/* Node Scheduling */}
      <div className="grid gap-2">
        <h3 className="sam-type-card-title m-0 text-fg-primary">Node Scheduling</h3>
        {nodeParams.map((meta) => (
          <ScalingField
            key={meta.key}
            meta={meta}
            value={scalingValues[meta.key] ?? null}
            onChange={(v) => setScalingValues((prev) => ({ ...prev, [meta.key]: v }))}
            disabled={savingScaling}
          />
        ))}
        {/* Node Idle Timeout — existing dead column, now wired up */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-fg-muted flex-1 min-w-0">
            Node Idle Timeout
          </label>
          <input
            type="number"
            min={MIN_NODE_IDLE_TIMEOUT_MS}
            max={MAX_NODE_IDLE_TIMEOUT_MS}
            placeholder={formatMs(DEFAULT_NODE_WARM_TIMEOUT_MS)}
            value={nodeIdleTimeoutMs ?? ''}
            onChange={(e) => {
              const raw = e.target.value;
              setNodeIdleTimeoutMs(raw === '' ? null : Number(raw));
            }}
            disabled={savingScaling}
            className="w-24 py-1 px-2 border border-border-default rounded-sm bg-inset text-fg-primary text-xs font-[inherit] tabular-nums text-right"
          />
          {nodeIdleTimeoutMs != null && (
            <>
              <span className="text-xs text-fg-muted min-w-[3rem]">{formatMs(nodeIdleTimeoutMs)}</span>
              <button
                type="button"
                onClick={() => setNodeIdleTimeoutMs(null)}
                className="text-xs text-fg-muted hover:text-fg-primary underline"
              >
                Reset
              </button>
            </>
          )}
        </div>
      </div>

      <Button
        variant="primary"
        size="sm"
        onClick={handleSaveScaling}
        disabled={savingScaling}
      >
        {savingScaling ? 'Saving...' : 'Save Scaling Settings'}
      </Button>
    </section>
  );
}
