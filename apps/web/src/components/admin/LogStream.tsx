import { type FC, useEffect, useRef, useState, useCallback } from 'react';
import { Card, Button, Body } from '@simple-agent-manager/ui';
import { useAdminLogStream, type StreamConnectionState } from '../../hooks/useAdminLogStream';

const LEVEL_COLORS: Record<string, string> = {
  error: '#f87171',
  warn: '#fbbf24',
  info: '#60a5fa',
};

const STATE_COLORS: Record<StreamConnectionState, string> = {
  connected: '#4ade80',
  connecting: '#fbbf24',
  reconnecting: '#fbbf24',
  disconnected: '#f87171',
};

const STATE_LABELS: Record<StreamConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting...',
  reconnecting: 'Reconnecting...',
  disconnected: 'Disconnected',
};

const LEVEL_OPTIONS = ['error', 'warn', 'info'] as const;

interface LogEntryRowProps {
  entry: { timestamp: string; level: string; event: string; message: string; details: Record<string, unknown>; scriptName: string };
}

const LogEntryRow: FC<LogEntryRowProps> = ({ entry }) => {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Object.keys(entry.details).length > 0;

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
          style={{ color: LEVEL_COLORS[entry.level] ?? 'var(--sam-color-fg-muted)' }}
        >
          {entry.level}
        </span>
        <span className="text-fg-muted text-xs">
          {new Date(entry.timestamp).toLocaleTimeString()}
        </span>
        <span className="text-fg-muted text-[0.7rem] opacity-70">
          {entry.event}
        </span>
      </div>
      <div className="overflow-hidden text-ellipsis whitespace-nowrap mt-0.5">
        {entry.message}
      </div>

      {expanded && hasDetails && (
        <pre className="mt-2 p-2 bg-inset rounded-sm text-xs overflow-auto whitespace-pre-wrap break-all" style={{ maxHeight: '200px' }}>
          {JSON.stringify(entry.details, null, 2)}
        </pre>
      )}
    </div>
  );
};

export const LogStream: FC = () => {
  const {
    entries,
    state,
    paused,
    clientCount,
    filter,
    setLevels,
    setSearch,
    togglePause,
    clear,
    retry,
  } = useAdminLogStream();

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [searchInput, setSearchInput] = useState('');

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  // Detect manual scroll to disable auto-scroll
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setAutoScroll(isAtBottom);
  }, []);

  const handleLevelToggle = useCallback((level: string) => {
    setLevels(
      filter.levels.includes(level)
        ? filter.levels.filter((l) => l !== level)
        : [...filter.levels, level],
    );
  }, [filter.levels, setLevels]);

  const handleSearchSubmit = useCallback(() => {
    setSearch(searchInput);
  }, [searchInput, setSearch]);

  return (
    <div>
      <Card>
        {/* Toolbar */}
        <div className="px-4 py-3 border-b border-border-default flex flex-wrap gap-2 items-center">
          {/* Connection status */}
          <div
            className="flex items-center gap-1"
            aria-label="Connection status"
          >
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: STATE_COLORS[state] }}
              data-testid="connection-indicator"
            />
            <span className="text-xs text-fg-muted">
              {STATE_LABELS[state]}
            </span>
            {state === 'connected' && clientCount > 0 && (
              <span className="text-[0.7rem] text-fg-muted opacity-60">
                ({clientCount} client{clientCount !== 1 ? 's' : ''})
              </span>
            )}
          </div>

          {/* Level filters */}
          <div className="flex gap-1">
            {LEVEL_OPTIONS.map((level) => (
              <button
                key={level}
                onClick={() => handleLevelToggle(level)}
                className="rounded-sm border border-border-default text-xs cursor-pointer capitalize"
                style={{
                  padding: '2px 8px',
                  backgroundColor: filter.levels.includes(level)
                    ? (LEVEL_COLORS[level] + '22')
                    : 'transparent',
                  color: filter.levels.includes(level)
                    ? LEVEL_COLORS[level]
                    : 'var(--sam-color-fg-muted)',
                }}
              >
                {level}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="flex gap-1 flex-1 min-w-0">
            <input
              type="text"
              placeholder="Search..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearchSubmit()}
              aria-label="Search stream"
              className="flex-1 px-2 py-1 rounded-sm border border-border-default bg-surface text-fg-primary text-sm"
            />
          </div>

          {/* Actions */}
          <Button size="sm" variant="ghost" onClick={togglePause}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="sm" variant="ghost" onClick={clear}>
            Clear
          </Button>
          {state === 'disconnected' && (
            <Button size="sm" variant="ghost" onClick={retry}>
              Reconnect
            </Button>
          )}

          {/* Entry count */}
          <span className="text-[0.7rem] text-fg-muted ml-auto">
            {entries.length} entries
          </span>
        </div>

        {/* Log entries -- scrollable container */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="overflow-y-auto"
          style={{ maxHeight: '600px', minHeight: '200px' }}
          data-testid="log-stream-entries"
        >
          {entries.length === 0 ? (
            <div className="p-8 text-center">
              <Body className="text-fg-muted">
                {state === 'connected'
                  ? paused
                    ? 'Stream paused. Click Resume to continue receiving logs.'
                    : 'Waiting for log entries...'
                  : state === 'disconnected'
                    ? 'Disconnected from log stream. Click Reconnect to try again.'
                    : 'Connecting to log stream...'}
              </Body>
            </div>
          ) : (
            entries.map((entry, i) => (
              <LogEntryRow key={`${entry.timestamp}-${i}`} entry={entry} />
            ))
          )}
        </div>

        {/* Auto-scroll indicator */}
        {!autoScroll && entries.length > 0 && (
          <div className="p-2 text-center border-t border-border-default">
            <button
              onClick={() => {
                setAutoScroll(true);
                if (scrollContainerRef.current) {
                  scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
                }
              }}
              className="px-3 py-0.5 rounded-sm border border-border-default bg-transparent text-fg-muted text-xs cursor-pointer"
            >
              Scroll to bottom
            </button>
          </div>
        )}
      </Card>
    </div>
  );
};
