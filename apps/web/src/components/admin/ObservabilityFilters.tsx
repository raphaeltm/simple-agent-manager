import type { PlatformErrorLevel, PlatformErrorSource } from '@simple-agent-manager/shared';
import { type FC, useEffect, useRef, useState } from 'react';

import type { TimeRange } from '../../hooks/useAdminErrors';
import { useIsMobile } from '../../hooks/useIsMobile';

interface ObservabilityFiltersProps {
  source: PlatformErrorSource | 'all';
  level: PlatformErrorLevel | 'all';
  search: string;
  timeRange: TimeRange;
  nodeId?: string;
  workspaceId?: string;
  taskId?: string;
  sessionId?: string;
  userId?: string;
  autoRefresh?: boolean;
  onSourceChange: (source: PlatformErrorSource | 'all') => void;
  onLevelChange: (level: PlatformErrorLevel | 'all') => void;
  onSearchChange: (search: string) => void;
  onTimeRangeChange: (range: TimeRange) => void;
  onNodeIdChange?: (nodeId: string) => void;
  onWorkspaceIdChange?: (workspaceId: string) => void;
  onTaskIdChange?: (taskId: string) => void;
  onSessionIdChange?: (sessionId: string) => void;
  onUserIdChange?: (userId: string) => void;
  onAutoRefreshChange?: (on: boolean) => void;
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
const ID_DEBOUNCE_MS = 500;

const selectClass =
  'px-3 py-2 rounded-sm text-fg-primary text-sm cursor-pointer outline-none bg-surface border border-border-default';
const inputClass =
  'min-w-0 px-3 py-2 rounded-sm text-fg-primary text-sm outline-none bg-surface border border-border-default';

export const ObservabilityFilters: FC<ObservabilityFiltersProps> = ({
  source,
  level,
  search,
  timeRange,
  nodeId = '',
  workspaceId = '',
  taskId = '',
  sessionId = '',
  userId = '',
  autoRefresh = false,
  onSourceChange,
  onLevelChange,
  onSearchChange,
  onTimeRangeChange,
  onNodeIdChange,
  onWorkspaceIdChange,
  onTaskIdChange,
  onSessionIdChange,
  onUserIdChange,
  onAutoRefreshChange,
}) => {
  const [searchInput, setSearchInput] = useState(search);
  const [idExpanded, setIdExpanded] = useState(
    Boolean(nodeId || workspaceId || taskId || sessionId || userId),
  );
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const idDebounceRefs = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    setSearchInput(search);
  }, [search]);

  const isMobile = useIsMobile();

  const handleSearchInput = (value: string) => {
    setSearchInput(value);
    clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      onSearchChange(value);
    }, SEARCH_DEBOUNCE_MS);
  };

  const makeDebouncedIdHandler = (key: string, handler?: (v: string) => void) => {
    return (value: string) => {
      if (!handler) return;
      clearTimeout(idDebounceRefs.current[key]);
      idDebounceRefs.current[key] = setTimeout(() => handler(value), ID_DEBOUNCE_MS);
    };
  };

  useEffect(() => {
    return () => {
      clearTimeout(searchDebounceRef.current);
      for (const t of Object.values(idDebounceRefs.current)) clearTimeout(t);
    };
  }, []);

  const hasActiveIdFilters = Boolean(nodeId || workspaceId || taskId || sessionId || userId);

  return (
    <div className="border-b border-border-default px-4 py-3">
      <div
        className={`flex flex-wrap gap-2 ${
          isMobile ? 'flex-col items-stretch' : 'flex-row items-center'
        }`}
      >
        <div className="flex flex-wrap gap-2">
          <select
            value={source}
            onChange={(e) => onSourceChange(e.target.value as PlatformErrorSource | 'all')}
            className={`${selectClass} ${isMobile ? 'flex-1 min-w-0' : ''}`}
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
            className={`${selectClass} ${isMobile ? 'flex-1 min-w-0' : ''}`}
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
            className={`${selectClass} ${isMobile ? 'flex-1 min-w-0' : ''}`}
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
          className={`flex-1 ${inputClass}`}
          aria-label="Search error messages"
        />

        <div className="flex items-center gap-2">
          {onAutoRefreshChange && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => onAutoRefreshChange(e.target.checked)}
                className="accent-accent-primary"
              />
              Auto-refresh
            </label>
          )}

          <button
            type="button"
            onClick={() => setIdExpanded(!idExpanded)}
            className="flex items-center gap-1 rounded-sm px-2 py-1.5 text-xs text-fg-muted hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent transition-colors"
            aria-expanded={idExpanded}
            aria-label="Toggle ID filters"
          >
            ID filters
            {hasActiveIdFilters && (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent-primary" />
            )}
            <span
              aria-hidden="true"
              className="text-[0.6rem] transition-transform duration-150"
              style={{ transform: idExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
            >
              ▶
            </span>
          </button>
        </div>
      </div>

      {/* ID filter inputs (collapsible) */}
      {idExpanded && (
        <div className="mt-2 flex flex-wrap gap-2">
          <IdFilterInput
            label="Node ID"
            defaultValue={nodeId}
            onChange={makeDebouncedIdHandler('nodeId', onNodeIdChange)}
          />
          <IdFilterInput
            label="Workspace ID"
            defaultValue={workspaceId}
            onChange={makeDebouncedIdHandler('workspaceId', onWorkspaceIdChange)}
          />
          <IdFilterInput
            label="Task ID"
            defaultValue={taskId}
            onChange={makeDebouncedIdHandler('taskId', onTaskIdChange)}
          />
          <IdFilterInput
            label="Session ID"
            defaultValue={sessionId}
            onChange={makeDebouncedIdHandler('sessionId', onSessionIdChange)}
          />
          <IdFilterInput
            label="User ID"
            defaultValue={userId}
            onChange={makeDebouncedIdHandler('userId', onUserIdChange)}
          />
        </div>
      )}
    </div>
  );
};

const IdFilterInput: FC<{
  label: string;
  defaultValue: string;
  onChange: (value: string) => void;
}> = ({ label, defaultValue, onChange }) => (
  <input
    type="text"
    placeholder={label}
    defaultValue={defaultValue}
    onChange={(e) => onChange(e.target.value.trim())}
    className={`w-36 ${inputClass} text-xs`}
    aria-label={`Filter by ${label}`}
  />
);
