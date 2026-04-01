import type { PlatformErrorLevel,PlatformErrorSource } from '@simple-agent-manager/shared';
import { type FC,useEffect, useRef, useState } from 'react';

import type { TimeRange } from '../../hooks/useAdminErrors';
import { useIsMobile } from '../../hooks/useIsMobile';

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
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Sync external search changes
  useEffect(() => {
    setSearchInput(search);
  }, [search]);

  const isMobile = useIsMobile();

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
      className={`flex flex-wrap gap-2 px-4 py-3 border-b border-border-default ${
        isMobile ? 'flex-col items-stretch' : 'flex-row items-center'
      }`}
    >
      <div className="flex gap-2 flex-wrap">
        <select
          value={source}
          onChange={(e) => onSourceChange(e.target.value as PlatformErrorSource | 'all')}
          className={`px-3 py-2 rounded-sm border border-border-default bg-surface text-fg-primary text-sm cursor-pointer outline-none ${
            isMobile ? 'flex-1 min-w-0' : ''
          }`}
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
          className={`px-3 py-2 rounded-sm border border-border-default bg-surface text-fg-primary text-sm cursor-pointer outline-none ${
            isMobile ? 'flex-1 min-w-0' : ''
          }`}
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
          className={`px-3 py-2 rounded-sm border border-border-default bg-surface text-fg-primary text-sm cursor-pointer outline-none ${
            isMobile ? 'flex-1 min-w-0' : ''
          }`}
          aria-label="Filter by time range"
        >
          {TIME_RANGE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <input
        type="text"
        placeholder="Search messages..."
        value={searchInput}
        onChange={(e) => handleSearchInput(e.target.value)}
        className="flex-1 min-w-0 px-3 py-2 rounded-sm border border-border-default bg-surface text-fg-primary text-sm outline-none"
        aria-label="Search error messages"
      />
    </div>
  );
};
