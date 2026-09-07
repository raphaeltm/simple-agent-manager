import type { FC } from 'react';

import type { ResourceRequirementsFormState } from './resource-requirements-utils';
import {
  EMPTY_RESOURCE_STATE,
  formatLegacyVmSize,
  hasAnyResourceValue,
} from './resource-requirements-utils';

const INPUT_CLASSES =
  'w-full rounded-md border border-border-default bg-surface px-2.5 py-1.5 text-sm text-fg-primary min-h-9 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]';

interface ResourceRequirementsInputProps {
  value: ResourceRequirementsFormState;
  onChange: (next: ResourceRequirementsFormState) => void;
  onInherit?: () => void;
  disabled?: boolean;
  legacyVmSize?: string | null;
  inheritLabel?: string;
  hideInherit?: boolean;
  hideDisk?: boolean;
}

export const ResourceRequirementsInput: FC<ResourceRequirementsInputProps> = ({
  value,
  onChange,
  onInherit,
  disabled = false,
  legacyVmSize,
  inheritLabel = 'default',
  hideInherit = false,
  hideDisk = false,
}) => {
  const legacyLabel = formatLegacyVmSize(legacyVmSize);
  const hasValues = hasAnyResourceValue(value);
  const hasAnything = hasValues || !!legacyVmSize;

  const handleInherit = () => {
    onChange({ ...EMPTY_RESOURCE_STATE });
    onInherit?.();
  };

  const update = (patch: Partial<ResourceRequirementsFormState>) => {
    onChange({ ...value, ...patch });
  };

  return (
    <fieldset className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <legend className="text-sm text-fg-muted">Resources</legend>
        {!hideInherit && hasAnything && (
          <button
            type="button"
            onClick={handleInherit}
            disabled={disabled}
            className="text-xs text-accent hover:underline disabled:opacity-50"
          >
            Inherit {inheritLabel}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label className="grid gap-0.5">
          <span className="text-xs text-fg-muted">vCPU</span>
          <input
            type="number"
            min={1}
            step={1}
            value={value.minVcpu}
            onChange={(e) => update({ minVcpu: e.target.value })}
            placeholder="Auto"
            disabled={disabled}
            className={INPUT_CLASSES}
          />
        </label>
        <label className="grid gap-0.5">
          <span className="text-xs text-fg-muted">Memory (GB)</span>
          <input
            type="number"
            min={1}
            step={1}
            value={value.minMemoryGb}
            onChange={(e) => update({ minMemoryGb: e.target.value })}
            placeholder="Auto"
            disabled={disabled}
            className={INPUT_CLASSES}
          />
        </label>
        {!hideDisk && (
          <label className="grid gap-0.5">
            <span className="text-xs text-fg-muted">Disk (GB)</span>
            <input
              type="number"
              min={1}
              step={1}
              value={value.minDiskGb}
              onChange={(e) => update({ minDiskGb: e.target.value })}
              placeholder="Auto"
              disabled={disabled}
              className={INPUT_CLASSES}
            />
          </label>
        )}
      </div>

      <label className="flex items-center gap-2 py-0.5">
        <input
          type="checkbox"
          checked={value.exclusiveNode === true}
          ref={(el) => {
            if (el) el.indeterminate = value.exclusiveNode === undefined;
          }}
          onChange={() => {
            if (value.exclusiveNode === undefined) {
              update({ exclusiveNode: true });
            } else if (value.exclusiveNode === true) {
              update({ exclusiveNode: false, maxCoTenants: '' });
            } else {
              update({ exclusiveNode: undefined });
            }
          }}
          disabled={disabled}
          className="h-3.5 w-3.5 rounded border-border-default accent-[var(--sam-color-focus-ring)]"
        />
        <span className="text-xs text-fg-muted">Exclusive node</span>
      </label>

      {legacyLabel && !hasValues && (
        <div className="flex items-center gap-1.5 text-xs text-fg-muted">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-warning" />
          Legacy: {legacyLabel}
        </div>
      )}
    </fieldset>
  );
};
