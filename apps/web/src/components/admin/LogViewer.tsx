import { type FC, useState, useCallback } from 'react';
import { Card, Spinner, Button, Body } from '@simple-agent-manager/ui';
import { Copy, Check } from 'lucide-react';
import { useAdminLogQuery, type LogLevel, type LogTimeRange } from '../../hooks/useAdminLogQuery';
import { LogEntryRow, LEVEL_COLORS, formatLogEntries } from './LogEntryRow';

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
  const [copiedAll, setCopiedAll] = useState(false);

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

  const handleCopyAll = useCallback(() => {
    if (logs.length === 0) return;
    const text = formatLogEntries(logs);
    navigator.clipboard.writeText(text).then(() => {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    });
  }, [logs]);

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

          {/* Copy All */}
          {logs.length > 0 && (
            <button
              onClick={handleCopyAll}
              className="p-1.5 rounded-sm border border-border-default bg-surface text-fg-muted cursor-pointer"
              aria-label="Copy all visible logs"
              title="Copy all visible logs"
              data-testid="copy-all-button"
            >
              {copiedAll ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
            </button>
          )}
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
              <LogEntryRow key={`${log.timestamp}-${i}`} entry={log} searchTerm={filter.search} />
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
