import type { Project, UpdateProjectRequest } from '@simple-agent-manager/shared';
import { SCALING_PARAMS, type ScalingParamMeta } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useId, useState } from 'react';

import { useToast } from '../hooks/useToast';
import { updateProject } from '../lib/api';

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
  const fieldId = useId();

  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor={fieldId}
        className="text-xs text-fg-muted flex-1 min-w-0"
        title={`Env: ${meta.envVar}`}
      >
        {meta.label}
      </label>
      <input
        id={fieldId}
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

  // Scaling params state
  const [scalingValues, setScalingValues] = useState<Record<string, number | null>>(() => {
    const initial: Record<string, number | null> = {};
    for (const p of SCALING_PARAMS) {
      initial[p.key] = (project[p.key as keyof Project] as number | null) ?? null;
    }
    return initial;
  });
  const [savingScaling, setSavingScaling] = useState(false);

  // Sync from project prop
  useEffect(() => {
    const updated: Record<string, number | null> = {};
    for (const p of SCALING_PARAMS) {
      updated[p.key] = (project[p.key as keyof Project] as number | null) ?? null;
    }
    setScalingValues(updated);
  }, [project]);

  const handleSaveScaling = useCallback(async () => {
    setSavingScaling(true);
    try {
      const update: UpdateProjectRequest = { ...scalingValues };
      await updateProject(projectId, update);
      await reload();
      toast.success('Scaling settings saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSavingScaling(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toast removed per stale-while-revalidate rule
  }, [projectId, scalingValues, reload]);

  // Task limit params
  const taskParams = SCALING_PARAMS.filter((p) =>
    [
      'taskExecutionTimeoutMs',
      'maxConcurrentTasks',
      'maxDispatchDepth',
      'maxSubTasksPerTask',
      'maxTriggers',
    ].includes(p.key)
  );
  // Node scheduling params
  const nodeParams = SCALING_PARAMS.filter((p) =>
    ['warmNodeTimeoutMs', 'nodeCpuThresholdPercent', 'nodeMemoryThresholdPercent'].includes(p.key)
  );

  return (
    <section className="glass-surface rounded-lg p-4 grid gap-4">
      <div>
        <h2 className="sam-type-section-heading m-0 text-fg-primary">Scaling & Scheduling</h2>
        <p className="m-0 mt-1 text-xs text-fg-muted">
          Override platform defaults for this project. Empty fields use the platform default shown
          as placeholder.
        </p>
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
      </div>

      <Button variant="primary" size="sm" onClick={handleSaveScaling} disabled={savingScaling}>
        {savingScaling ? 'Saving...' : 'Save Scaling Settings'}
      </Button>
    </section>
  );
}
