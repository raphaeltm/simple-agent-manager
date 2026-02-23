import { type FC, useState, useEffect, useRef } from 'react';
import type { NodeLogSource, NodeLogLevel } from '@simple-agent-manager/shared';

interface LogFiltersProps {
  source: NodeLogSource;
  level: NodeLogLevel;
  search: string;
  container: string;
  onSourceChange: (source: NodeLogSource) => void;
  onLevelChange: (level: NodeLogLevel) => void;
  onSearchChange: (search: string) => void;
  onContainerChange: (container: string) => void;
}

const selectStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 'var(--sam-type-caption-size, 0.75rem)',
  borderRadius: 'var(--sam-radius-sm, 4px)',
  border: '1px solid var(--sam-color-border-default)',
  backgroundColor: 'var(--sam-color-bg-surface)',
  color: 'var(--sam-color-fg-primary)',
  outline: 'none',
};

const labelStyle: React.CSSProperties = {
  fontSize: '0.625rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--sam-color-fg-muted)',
  marginBottom: 2,
};

const SEARCH_DEBOUNCE_MS = 300;

export const LogFilters: FC<LogFiltersProps> = ({
  source,
  level,
  search,
  container,
  onSourceChange,
  onLevelChange,
  onSearchChange,
  onContainerChange,
}) => {
  const [localSearch, setLocalSearch] = useState(search);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Sync external search changes into local state
  useEffect(() => {
    setLocalSearch(search);
  }, [search]);

  const handleSearchChange = (value: string) => {
    setLocalSearch(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSearchChange(value), SEARCH_DEBOUNCE_MS);
  };

  // Cleanup timer on unmount
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--sam-space-3)',
        alignItems: 'flex-end',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <label style={labelStyle}>Source</label>
        <select
          style={selectStyle}
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

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <label style={labelStyle}>Level</label>
        <select
          style={selectStyle}
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
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 140 }}>
          <label style={labelStyle}>Container</label>
          <input
            type="text"
            placeholder="All containers"
            value={container}
            onChange={(e) => onContainerChange(e.target.value)}
            style={{
              ...selectStyle,
              minWidth: 120,
            }}
          />
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 160 }}>
        <label style={labelStyle}>Search</label>
        <input
          type="text"
          placeholder="Search logs..."
          value={localSearch}
          onChange={(e) => handleSearchChange(e.target.value)}
          style={{
            ...selectStyle,
            minWidth: 120,
          }}
        />
      </div>
    </div>
  );
};
