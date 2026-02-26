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
      style={{
        padding: 'var(--sam-space-2) var(--sam-space-4)',
        borderBottom: '1px solid var(--sam-color-border-default)',
        cursor: hasDetails ? 'pointer' : 'default',
        fontSize: 'var(--sam-type-secondary-size)',
      }}
      onClick={() => hasDetails && setExpanded(!expanded)}
      role={hasDetails ? 'button' : undefined}
      tabIndex={hasDetails ? 0 : undefined}
      aria-expanded={hasDetails ? expanded : undefined}
    >
      <div style={{ display: 'flex', gap: 'var(--sam-space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span
          style={{
            color: LEVEL_COLORS[log.level] ?? 'var(--sam-color-fg-muted)',
            fontWeight: 600,
            textTransform: 'uppercase',
            fontSize: '0.7rem',
            minWidth: '3rem',
          }}
        >
          {log.level}
        </span>
        <span style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.75rem' }}>
          {new Date(log.timestamp).toLocaleTimeString()}
        </span>
        <span style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.7rem', opacity: 0.7 }}>
          {log.event}
        </span>
      </div>
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
        {log.message}
      </div>

      {expanded && hasDetails && (
        <pre
          style={{
            marginTop: 'var(--sam-space-2)',
            padding: 'var(--sam-space-2)',
            backgroundColor: 'var(--sam-color-bg-inset)',
            borderRadius: 'var(--sam-radius-sm)',
            fontSize: '0.75rem',
            overflow: 'auto',
            maxHeight: '200px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
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
        <div
          style={{
            padding: 'var(--sam-space-3)',
            marginBottom: 'var(--sam-space-4)',
            borderRadius: 'var(--sam-radius-sm)',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            color: '#f87171',
            fontSize: 'var(--sam-type-secondary-size)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{error}</span>
          <Button size="sm" variant="ghost" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}

      <Card>
        {/* Filters */}
        <div
          style={{
            padding: 'var(--sam-space-3) var(--sam-space-4)',
            borderBottom: '1px solid var(--sam-color-border-default)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--sam-space-2)',
            alignItems: 'center',
          }}
        >
          {/* Time range */}
          <select
            value={filter.timeRange}
            onChange={(e) => setTimeRange(e.target.value as LogTimeRange)}
            aria-label="Time range"
            style={{
              padding: 'var(--sam-space-1) var(--sam-space-2)',
              borderRadius: 'var(--sam-radius-sm)',
              border: '1px solid var(--sam-color-border-default)',
              backgroundColor: 'var(--sam-color-bg-surface)',
              color: 'var(--sam-color-fg-default)',
              fontSize: 'var(--sam-type-secondary-size)',
            }}
          >
            {TIME_RANGE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          {/* Level toggles */}
          <div style={{ display: 'flex', gap: 'var(--sam-space-1)' }}>
            {LEVEL_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => handleLevelToggle(opt.value)}
                style={{
                  padding: '2px 8px',
                  borderRadius: 'var(--sam-radius-sm)',
                  border: '1px solid var(--sam-color-border-default)',
                  backgroundColor: filter.levels.includes(opt.value)
                    ? (LEVEL_COLORS[opt.value] + '22')
                    : 'transparent',
                  color: filter.levels.includes(opt.value)
                    ? LEVEL_COLORS[opt.value]
                    : 'var(--sam-color-fg-muted)',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Search */}
          <div style={{ display: 'flex', gap: 'var(--sam-space-1)', flex: 1, minWidth: 0 }}>
            <input
              type="text"
              placeholder="Search logs..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearchSubmit()}
              aria-label="Search logs"
              style={{
                flex: 1,
                padding: 'var(--sam-space-1) var(--sam-space-2)',
                borderRadius: 'var(--sam-radius-sm)',
                border: '1px solid var(--sam-color-border-default)',
                backgroundColor: 'var(--sam-color-bg-surface)',
                color: 'var(--sam-color-fg-default)',
                fontSize: 'var(--sam-type-secondary-size)',
              }}
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
          <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-8)' }}>
            <Spinner size="lg" />
          </div>
        ) : logs.length === 0 ? (
          <div style={{ padding: 'var(--sam-space-8)', textAlign: 'center' }}>
            <Body style={{ color: 'var(--sam-color-fg-muted)' }}>
              No logs found for the selected filters. Try adjusting the time range or search query.
            </Body>
          </div>
        ) : (
          <>
            {logs.map((log, i) => (
              <LogEntryRow key={`${log.timestamp}-${i}`} log={log} />
            ))}

            {hasMore && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-4)' }}>
                <Button size="sm" variant="secondary" onClick={loadMore} disabled={loading}>
                  {loading ? 'Loading...' : 'Load More'}
                </Button>
              </div>
            )}

            {loading && logs.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-3)' }}>
                <Spinner size="sm" />
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
};
