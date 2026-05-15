import type { FC } from 'react';

import { useDevcontainerConfigs } from '../../hooks/useDevcontainerConfigs';

interface DevcontainerConfigSelectProps {
  projectId: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Compact pill style for mobile layouts */
  compact?: boolean;
  /** HTML id for label association */
  id?: string;
  /** CSS class name override */
  className?: string;
}

/**
 * Dropdown for selecting a devcontainer config from the project's repository.
 * Always includes "Auto-detect" as the first option.
 * If the current value is not found in discovered configs, shows it as "(saved, not found)".
 * Gracefully handles loading, errors, and unsupported providers.
 */
export const DevcontainerConfigSelect: FC<DevcontainerConfigSelectProps> = ({
  projectId,
  value,
  onChange,
  disabled = false,
  compact = false,
  id,
  className,
}) => {
  const { configs, loading, error } = useDevcontainerConfigs(projectId, true);

  // Check if the current value exists in discovered configs
  const valueInConfigs = !value || configs.some((c) => c.name === value);

  const selectClass = className ?? (compact
    ? 'min-w-0 flex-1 px-2 py-1.5 min-h-[44px] border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]'
    : 'px-2 py-1 border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]');

  return (
    <div className={compact ? 'min-w-0 flex-1' : undefined}>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label="Devcontainer config"
        className={selectClass}
      >
        <option value="">Auto-detect</option>
        {configs.map((config) => (
          <option key={config.name} value={config.name}>
            {config.name}
          </option>
        ))}
        {/* Show saved value that's not in the discovered list */}
        {value && !valueInConfigs && (
          <option value={value}>
            {value} (saved, not found)
          </option>
        )}
      </select>
      {loading && (
        <span className="text-fg-muted text-xs ml-1" aria-live="polite">Loading...</span>
      )}
      {error && !loading && (
        <span className="text-danger text-xs ml-1" title={error} aria-live="polite">Discovery failed</span>
      )}
    </div>
  );
};
