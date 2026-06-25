import type { NodeContainerLogTarget, NodeLogLevel,NodeLogSource } from '@simple-agent-manager/shared';
import { type FC, useRef,useState } from 'react';

interface LogFiltersProps {
  source: NodeLogSource;
  level: NodeLogLevel;
  search: string;
  container: string;
  containers: NodeContainerLogTarget[];
  containersLoading?: boolean;
  onSourceChange: (source: NodeLogSource) => void;
  onLevelChange: (level: NodeLogLevel) => void;
  onSearchChange: (search: string) => void;
  onContainerChange: (container: string) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

export const LogFilters: FC<LogFiltersProps> = ({
  source,
  level,
  search,
  container,
  containers,
  containersLoading = false,
  onSourceChange,
  onLevelChange,
  onSearchChange,
  onContainerChange,
}) => {
  const [localSearch, setLocalSearch] = useState(search);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Track the last search prop we synced so we can update localSearch when the
  // parent resets it externally (e.g. a clear button) without running an Effect.
  const prevSearchPropRef = useRef(search);
  if (prevSearchPropRef.current !== search) {
    prevSearchPropRef.current = search;
    setLocalSearch(search);
  }

  const handleSearchChange = (value: string) => {
    setLocalSearch(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSearchChange(value), SEARCH_DEBOUNCE_MS);
  };

  return (
    <div className="flex gap-3 items-end flex-wrap">
      <div className="flex flex-col">
        <label htmlFor="node-log-source" className="text-fg-muted font-semibold uppercase tracking-wide mb-0.5" style={{ fontSize: '0.625rem', letterSpacing: '0.05em' }}>Source</label>
        <select
          id="node-log-source"
          className="px-2 py-1 rounded-sm text-fg-primary outline-none"
          style={{ fontSize: 'var(--sam-type-caption-size, 0.75rem)' }}
          value={source}
          onChange={(e) => onSourceChange(e.target.value as NodeLogSource)}
        >
          <option value="all">All sources</option>
          <option value="agent">Agent</option>
          <option value="cloud-init">Cloud-init</option>
          <option value="docker">Docker</option>
          <option value="systemd">Systemd</option>
        </select>
      </div>

      <div className="flex flex-col">
        <label htmlFor="node-log-level" className="text-fg-muted font-semibold uppercase tracking-wide mb-0.5" style={{ fontSize: '0.625rem', letterSpacing: '0.05em' }}>Level</label>
        <select
          id="node-log-level"
          className="px-2 py-1 rounded-sm text-fg-primary outline-none"
          style={{ fontSize: 'var(--sam-type-caption-size, 0.75rem)' }}
          value={level}
          onChange={(e) => onLevelChange(e.target.value as NodeLogLevel)}
        >
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
      </div>

      {(source === 'docker' || source === 'all') && (
        <div className="flex flex-col min-w-[140px]">
          <label htmlFor="node-log-container" className="text-fg-muted font-semibold uppercase tracking-wide mb-0.5" style={{ fontSize: '0.625rem', letterSpacing: '0.05em' }}>Container</label>
          <select
            id="node-log-container"
            value={container}
            onChange={(e) => onContainerChange(e.target.value)}
            className="px-2 py-1 rounded-sm text-fg-primary outline-none min-w-[120px]"
            style={{ fontSize: 'var(--sam-type-caption-size, 0.75rem)' }}
            disabled={containersLoading}
          >
            <option value="">{containersLoading ? 'Loading containers...' : 'All containers'}</option>
            {containers.map((target) => (
              <option key={target.name} value={target.name}>
                {target.name}
              </option>
            ))}
            {container && !containers.some((target) => target.name === container) && (
              <option value={container}>{container}</option>
            )}
          </select>
        </div>
      )}

      <div className="flex flex-col flex-1 min-w-40">
        <label htmlFor="node-log-search" className="text-fg-muted font-semibold uppercase tracking-wide mb-0.5" style={{ fontSize: '0.625rem', letterSpacing: '0.05em' }}>Search</label>
        <input
          id="node-log-search"
          type="text"
          placeholder="Search logs..."
          value={localSearch}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="px-2 py-1 rounded-sm text-fg-primary outline-none min-w-[120px]"
          style={{ fontSize: 'var(--sam-type-caption-size, 0.75rem)' }}
        />
      </div>
    </div>
  );
};
