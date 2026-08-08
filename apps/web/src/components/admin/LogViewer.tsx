import { Body, Button, Card, Spinner } from '@simple-agent-manager/ui';
import { type FC, useCallback, useState } from 'react';

import { type LogLevel, type LogTimeRange, useAdminLogQuery } from '../../hooks/useAdminLogQuery';
import { CopyButton } from '../shared/log';
import { formatLogEntries, LEVEL_COLORS, LEVEL_TINTS, LogEntryRow } from './LogEntryRow';

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
    setScriptName,
    loadMore,
    refresh,
    applyFilters,
  } = useAdminLogQuery();

  const [searchInput, setSearchInput] = useState(filter.search);
  const [scriptNameInput, setScriptNameInput] = useState(filter.scriptName);

  const handleApply = useCallback(() => {
    setSearch(searchInput);
    setScriptName(scriptNameInput);
    applyFilters();
  }, [searchInput, scriptNameInput, setSearch, setScriptName, applyFilters]);

  const handleSearchSubmit = useCallback(() => {
    setSearch(searchInput);
    applyFilters();
  }, [searchInput, setSearch, applyFilters]);

  const handleLevelToggle = useCallback(
    (level: LogLevel) => {
      setLevels(
        filter.levels.includes(level)
          ? filter.levels.filter((l) => l !== level)
          : [...filter.levels, level],
      );
    },
    [filter.levels, setLevels],
  );

  const getCopyAllText = useCallback(() => formatLogEntries(logs), [logs]);

  return (
    <div>
      {error && (
        <div className="mb-4 flex items-center justify-between rounded-sm bg-danger-tint p-3 text-sm text-danger-fg">
          <span>{error}</span>
          <Button size="sm" variant="ghost" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}

      <Card>
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border-default px-4 py-3">
          <select
            value={filter.timeRange}
            onChange={(e) => setTimeRange(e.target.value as LogTimeRange)}
            aria-label="Time range"
            className="rounded-sm bg-surface border border-border-default px-2 py-1 text-sm text-fg-primary"
          >
            {TIME_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <div className="flex gap-1">
            {LEVEL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => handleLevelToggle(opt.value)}
                className="cursor-pointer rounded-sm border border-border-default text-xs"
                style={{
                  padding: '2px 8px',
                  backgroundColor: filter.levels.includes(opt.value)
                    ? LEVEL_TINTS[opt.value]
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

          <input
            type="text"
            placeholder="Script name"
            value={scriptNameInput}
            onChange={(e) => setScriptNameInput(e.target.value.trim())}
            aria-label="Worker script name"
            className="w-32 rounded-sm bg-surface border border-border-default px-2 py-1 text-sm text-fg-primary"
          />

          <div className="flex min-w-0 flex-1 gap-1">
            <input
              type="text"
              placeholder="Search logs..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearchSubmit()}
              aria-label="Search logs"
              className="min-w-0 flex-1 rounded-sm bg-surface border border-border-default px-2 py-1 text-sm text-fg-primary"
            />
            <Button size="sm" variant="secondary" onClick={handleApply}>
              Apply
            </Button>
          </div>

          <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>
            Refresh
          </Button>

          {logs.length > 0 && (
            <CopyButton
              getText={getCopyAllText}
              label="Copy all visible logs"
              testId="copy-all-button"
              variant="toolbar"
            />
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
