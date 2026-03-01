import { type FC, useState, useCallback } from 'react';
import { Card, Spinner, Button, Body } from '@simple-agent-manager/ui';
import { useAdminLogQuery, type LogLevel, type LogTimeRange } from '../../hooks/useAdminLogQuery';

const LEVEL_OPTIONS: { value: LogLevel; label: string }[] = [
  { value: 'error', label: 'Error' },
  { value: 'warn', label: 'Warn' },
  { value: 'info', label: 'Info' },
  { value: 'debug', label: 'Debug' },
  { value: 'log', label: 'Log' },
];

const TIME_RANGE_OPTIONS: { value: LogTimeRange; label: string }[] = [
  { value: '1h', label: 'Last 1 hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
];

interface LogEntryRowProps {
  log: { timestamp: string; level: string; event: string; message: string; details: Record<string, unknown>; invocationId?: string };
}

const LEVEL_COLORS: Record<string, string> = {
  error: '#f87171',
  warn: '#fbbf24',
  info: '#60a5fa',
  debug: '#a78bfa',
  log: 'var(--sam-color-fg-muted)',
};

const LogEntryRow: FC<LogEntryRowProps> = ({ log }) => {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Object.keys(log.details).length > 0;

  return (
    <div
      className="px-4 py-2 border-b border-border-default text-sm"
      style={{ cursor: hasDetails ? 'pointer' : 'default' }}
      onClick={() => hasDetails && setExpanded(!expanded)}
      role={hasDetails ? 'button' : undefined}
      tabIndex={hasDetails ? 0 : undefined}
      aria-expanded={hasDetails ? expanded : undefined}
    >
      <div className="flex gap-2 items-baseline flex-wrap">
        <span
          className="font-semibold uppercase text-[0.7rem] min-w-[3rem]"
          style={{ color: LEVEL_COLORS[log.level] ?? 'var(--sam-color-fg-muted)' }}
        >
          {log.level}
        </span>
        <span className="text-fg-muted text-xs">
          {new Date(log.timestamp).toLocaleTimeString()}
        </span>
        <span className="text-fg-muted text-[0.7rem] opacity-70">
          {log.event}
        </span>
      </div>
      <div className="overflow-hidden text-ellipsis whitespace-nowrap mt-0.5">
        {log.message}
      </div>

      {expanded && hasDetails && (
        <pre className="mt-2 p-2 bg-inset rounded-sm text-xs overflow-auto whitespace-pre-wrap break-all" style={{ maxHeight: '200px' }}>
          {JSON.stringify(log.details, null, 2)}
        </pre>
      )}
    </div>
  );
};

export const LogViewer: FC = () => {
  const {
    logs,
    loading,
    error,
    hasMore,
    filter,
    setLevels,
    setSearch,
    setTimeRange,
    loadMore,
    refresh,
  } = useAdminLogQuery();

  const [searchInput, setSearchInput] = useState('');

  const handleSearchSubmit = useCallback(() => {
    setSearch(searchInput);
  }, [searchInput, setSearch]);

  const handleLevelToggle = useCallback((level: LogLevel) => {
    setLevels(
      filter.levels.includes(level)
        ? filter.levels.filter(l => l !== level)
        : [...filter.levels, level]
    );
  }, [filter.levels, setLevels]);

  return (
    <div>
      {error && (
        <div className="p-3 mb-4 rounded-sm bg-danger-tint text-danger-fg text-sm flex justify-between items-center">
          <span>{error}</span>
          <Button size="sm" variant="ghost" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}

      <Card>
        {/* Filters */}
        <div className="px-4 py-3 border-b border-border-default flex flex-wrap gap-2 items-center">
          {/* Time range */}
          <select
            value={filter.timeRange}
            onChange={(e) => setTimeRange(e.target.value as LogTimeRange)}
            aria-label="Time range"
            className="px-2 py-1 rounded-sm border border-border-default bg-surface text-fg-primary text-sm"
          >
            {TIME_RANGE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          {/* Level toggles */}
          <div className="flex gap-1">
            {LEVEL_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => handleLevelToggle(opt.value)}
                className="rounded-sm border border-border-default text-xs cursor-pointer"
                style={{
                  padding: '2px 8px',
                  backgroundColor: filter.levels.includes(opt.value)
                    ? (LEVEL_COLORS[opt.value] + '22')
                    : 'transparent',
                  color: filter.levels.includes(opt.value)
                    ? LEVEL_COLORS[opt.value]
                    : 'var(--sam-color-fg-muted)',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="flex gap-1 flex-1 min-w-0">
            <input
              type="text"
              placeholder="Search logs..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearchSubmit()}
              aria-label="Search logs"
              className="flex-1 px-2 py-1 rounded-sm border border-border-default bg-surface text-fg-primary text-sm"
            />
            <Button size="sm" variant="ghost" onClick={handleSearchSubmit}>
              Search
            </Button>
          </div>

          <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
        </div>

        {/* Log entries */}
        {loading && logs.length === 0 ? (
          <div className="flex justify-center p-8">
            <Spinner size="lg" />
          </div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-center">
            <Body className="text-fg-muted">
              No logs found for the selected filters. Try adjusting the time range or search query.
            </Body>
          </div>
        ) : (
          <>
            {logs.map((log, i) => (
              <LogEntryRow key={`${log.timestamp}-${i}`} log={log} />
            ))}

            {hasMore && (
              <div className="flex justify-center p-4">
                <Button size="sm" variant="secondary" onClick={loadMore} disabled={loading}>
                  {loading ? 'Loading...' : 'Load More'}
                </Button>
              </div>
            )}

            {loading && logs.length > 0 && (
              <div className="flex justify-center p-3">
                <Spinner size="sm" />
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
};
