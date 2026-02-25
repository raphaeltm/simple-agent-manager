import { useState, useEffect, useRef, type FC, type CSSProperties } from 'react';
import type { PlatformErrorSource, PlatformErrorLevel } from '@simple-agent-manager/shared';
import type { TimeRange } from '../../hooks/useAdminErrors';

interface ObservabilityFiltersProps {
  source: PlatformErrorSource | 'all';
  level: PlatformErrorLevel | 'all';
  search: string;
  timeRange: TimeRange;
  onSourceChange: (source: PlatformErrorSource | 'all') => void;
  onLevelChange: (level: PlatformErrorLevel | 'all') => void;
  onSearchChange: (search: string) => void;
  onTimeRangeChange: (range: TimeRange) => void;
}

const SOURCE_OPTIONS: { value: PlatformErrorSource | 'all'; label: string }[] = [
  { value: 'all', label: 'All Sources' },
  { value: 'client', label: 'Client' },
  { value: 'vm-agent', label: 'VM Agent' },
  { value: 'api', label: 'API' },
];

const LEVEL_OPTIONS: { value: PlatformErrorLevel | 'all'; label: string }[] = [
  { value: 'all', label: 'All Levels' },
  { value: 'error', label: 'Error' },
  { value: 'warn', label: 'Warning' },
  { value: 'info', label: 'Info' },
];

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: '1h', label: 'Last Hour' },
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
];

const selectStyle: CSSProperties = {
  padding: 'var(--sam-space-2) var(--sam-space-3)',
  borderRadius: 'var(--sam-radius-sm)',
  border: '1px solid var(--sam-color-border-default)',
  background: 'var(--sam-color-bg-surface)',
  color: 'var(--sam-color-fg-primary)',
  fontSize: 'var(--sam-type-secondary-size)',
  cursor: 'pointer',
  outline: 'none',
};

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 160,
  padding: 'var(--sam-space-2) var(--sam-space-3)',
  borderRadius: 'var(--sam-radius-sm)',
  border: '1px solid var(--sam-color-border-default)',
  background: 'var(--sam-color-bg-surface)',
  color: 'var(--sam-color-fg-primary)',
  fontSize: 'var(--sam-type-secondary-size)',
  outline: 'none',
};

const SEARCH_DEBOUNCE_MS = 300;

export const ObservabilityFilters: FC<ObservabilityFiltersProps> = ({
  source,
  level,
  search,
  timeRange,
  onSourceChange,
  onLevelChange,
  onSearchChange,
  onTimeRangeChange,
}) => {
  const [searchInput, setSearchInput] = useState(search);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Sync external search changes
  useEffect(() => {
    setSearchInput(search);
  }, [search]);

  const handleSearchInput = (value: string) => {
    setSearchInput(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onSearchChange(value);
    }, SEARCH_DEBOUNCE_MS);
  };

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--sam-space-2)',
        padding: 'var(--sam-space-3) var(--sam-space-4)',
        borderBottom: '1px solid var(--sam-color-border-default)',
        alignItems: 'center',
      }}
    >
      <select
        value={source}
        onChange={(e) => onSourceChange(e.target.value as PlatformErrorSource | 'all')}
        style={selectStyle}
        aria-label="Filter by source"
      >
        {SOURCE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      <select
        value={level}
        onChange={(e) => onLevelChange(e.target.value as PlatformErrorLevel | 'all')}
        style={selectStyle}
        aria-label="Filter by level"
      >
        {LEVEL_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      <select
        value={timeRange}
        onChange={(e) => onTimeRangeChange(e.target.value as TimeRange)}
        style={selectStyle}
        aria-label="Filter by time range"
      >
        {TIME_RANGE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      <input
        type="text"
        placeholder="Search messages..."
        value={searchInput}
        onChange={(e) => handleSearchInput(e.target.value)}
        style={inputStyle}
        aria-label="Search error messages"
      />
    </div>
  );
};
