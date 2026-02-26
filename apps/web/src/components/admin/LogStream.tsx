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
            color: LEVEL_COLORS[entry.level] ?? 'var(--sam-color-fg-muted)',
            fontWeight: 600,
            textTransform: 'uppercase',
            fontSize: '0.7rem',
            minWidth: '3rem',
          }}
        >
          {entry.level}
        </span>
        <span style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.75rem' }}>
          {new Date(entry.timestamp).toLocaleTimeString()}
        </span>
        <span style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.7rem', opacity: 0.7 }}>
          {entry.event}
        </span>
      </div>
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
        {entry.message}
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
          {/* Connection status */}
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-1)' }}
            aria-label="Connection status"
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: STATE_COLORS[state],
                display: 'inline-block',
              }}
              data-testid="connection-indicator"
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)' }}>
              {STATE_LABELS[state]}
            </span>
            {state === 'connected' && clientCount > 0 && (
              <span style={{ fontSize: '0.7rem', color: 'var(--sam-color-fg-muted)', opacity: 0.6 }}>
                ({clientCount} client{clientCount !== 1 ? 's' : ''})
              </span>
            )}
          </div>

          {/* Level filters */}
          <div style={{ display: 'flex', gap: 'var(--sam-space-1)' }}>
            {LEVEL_OPTIONS.map((level) => (
              <button
                key={level}
                onClick={() => handleLevelToggle(level)}
                style={{
                  padding: '2px 8px',
                  borderRadius: 'var(--sam-radius-sm)',
                  border: '1px solid var(--sam-color-border-default)',
                  backgroundColor: filter.levels.includes(level)
                    ? (LEVEL_COLORS[level] + '22')
                    : 'transparent',
                  color: filter.levels.includes(level)
                    ? LEVEL_COLORS[level]
                    : 'var(--sam-color-fg-muted)',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {level}
              </button>
            ))}
          </div>

          {/* Search */}
          <div style={{ display: 'flex', gap: 'var(--sam-space-1)', flex: 1, minWidth: 0 }}>
            <input
              type="text"
              placeholder="Search..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearchSubmit()}
              aria-label="Search stream"
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
          <span style={{ fontSize: '0.7rem', color: 'var(--sam-color-fg-muted)', marginLeft: 'auto' }}>
            {entries.length} entries
          </span>
        </div>

        {/* Log entries — scrollable container */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          style={{
            maxHeight: '600px',
            overflowY: 'auto',
            minHeight: '200px',
          }}
          data-testid="log-stream-entries"
        >
          {entries.length === 0 ? (
            <div style={{ padding: 'var(--sam-space-8)', textAlign: 'center' }}>
              <Body style={{ color: 'var(--sam-color-fg-muted)' }}>
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
          <div
            style={{
              padding: 'var(--sam-space-2)',
              textAlign: 'center',
              borderTop: '1px solid var(--sam-color-border-default)',
            }}
          >
            <button
              onClick={() => {
                setAutoScroll(true);
                if (scrollContainerRef.current) {
                  scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
                }
              }}
              style={{
                padding: '2px 12px',
                borderRadius: 'var(--sam-radius-sm)',
                border: '1px solid var(--sam-color-border-default)',
                backgroundColor: 'transparent',
                color: 'var(--sam-color-fg-muted)',
                fontSize: '0.75rem',
                cursor: 'pointer',
              }}
            >
              Scroll to bottom
            </button>
          </div>
        )}
      </Card>
    </div>
  );
};
