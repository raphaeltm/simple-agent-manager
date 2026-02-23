import { type FC, useCallback, useEffect, useRef } from 'react';
import { ScrollText, Pause, Play, RefreshCw } from 'lucide-react';
import { Skeleton } from '@simple-agent-manager/ui';
import { SectionHeader } from './SectionHeader';
import { Section } from './Section';
import { LogEntry } from './LogEntry';
import { LogFilters } from './LogFilters';
import { useNodeLogs } from '../../hooks/useNodeLogs';

interface LogsSectionProps {
  nodeId: string | undefined;
  nodeStatus: string | undefined;
}

export const LogsSection: FC<LogsSectionProps> = ({ nodeId, nodeStatus }) => {
  const {
    entries,
    loading,
    error,
    hasMore,
    streaming,
    paused,
    filter,
    setSource,
    setLevel,
    setContainer,
    setSearch,
    loadMore,
    togglePause,
    refresh,
  } = useNodeLogs({ nodeId, nodeStatus });

  const listRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const prevEntryCountRef = useRef(0);

  // Auto-scroll to bottom when new entries arrive (unless user scrolled up)
  useEffect(() => {
    if (autoScrollRef.current && entries.length > prevEntryCountRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevEntryCountRef.current = entries.length;
  }, [entries.length]);

  // Track user scroll position
  const handleScroll = useCallback(() => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    // Auto-scroll is on when user is near the bottom (within 50px)
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  const isRunning = nodeStatus === 'running';

  return (
    <Section>
      <SectionHeader
        icon={<ScrollText size={20} color="#06b6d4" />}
        iconBg="rgba(6, 182, 212, 0.15)"
        title="Logs"
        description={
          isRunning
            ? `${entries.length} entries${streaming ? ' \u00b7 Live' : ''}${paused ? ' (paused)' : ''}`
            : 'Node must be running to view logs'
        }
      />

      {!isRunning ? (
        <div style={{ fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)' }}>
          Start the node to view its logs.
        </div>
      ) : (
        <>
          {/* Toolbar */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
              gap: 'var(--sam-space-3)',
              marginBottom: 'var(--sam-space-3)',
              flexWrap: 'wrap',
            }}
          >
            <LogFilters
              source={filter.source}
              level={filter.level}
              search={filter.search}
              container={filter.container}
              onSourceChange={setSource}
              onLevelChange={setLevel}
              onSearchChange={setSearch}
              onContainerChange={setContainer}
            />

            <div style={{ display: 'flex', gap: 'var(--sam-space-2)', alignItems: 'center' }}>
              {/* Streaming indicator */}
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: '0.625rem',
                  fontWeight: 600,
                  color: streaming ? '#22c55e' : 'var(--sam-color-fg-muted)',
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    backgroundColor: streaming ? '#22c55e' : 'var(--sam-color-fg-disabled)',
                  }}
                />
                {streaming ? 'LIVE' : 'DISCONNECTED'}
              </span>

              {/* Pause/Resume */}
              <button
                onClick={togglePause}
                title={paused ? 'Resume streaming' : 'Pause streaming'}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 28,
                  height: 28,
                  borderRadius: 'var(--sam-radius-sm, 4px)',
                  border: '1px solid var(--sam-color-border-default)',
                  backgroundColor: 'var(--sam-color-bg-surface)',
                  color: 'var(--sam-color-fg-muted)',
                  cursor: 'pointer',
                }}
              >
                {paused ? <Play size={14} /> : <Pause size={14} />}
              </button>

              {/* Refresh */}
              <button
                onClick={refresh}
                title="Refresh logs"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 28,
                  height: 28,
                  borderRadius: 'var(--sam-radius-sm, 4px)',
                  border: '1px solid var(--sam-color-border-default)',
                  backgroundColor: 'var(--sam-color-bg-surface)',
                  color: 'var(--sam-color-fg-muted)',
                  cursor: 'pointer',
                }}
              >
                <RefreshCw size={14} />
              </button>
            </div>
          </div>

          {/* Error banner */}
          {error && (
            <div
              style={{
                padding: 'var(--sam-space-2) var(--sam-space-3)',
                borderRadius: 'var(--sam-radius-sm, 4px)',
                backgroundColor: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                color: 'var(--sam-color-fg-danger, #ef4444)',
                fontSize: 'var(--sam-type-caption-size)',
                marginBottom: 'var(--sam-space-2)',
              }}
            >
              {error}
            </div>
          )}

          {/* Log list */}
          {loading && entries.length === 0 ? (
            <div>
              <Skeleton width="100%" height={20} style={{ marginBottom: 4 }} />
              <Skeleton width="100%" height={20} style={{ marginBottom: 4 }} />
              <Skeleton width="90%" height={20} style={{ marginBottom: 4 }} />
              <Skeleton width="95%" height={20} />
            </div>
          ) : entries.length === 0 ? (
            <div style={{ fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)', padding: 'var(--sam-space-4) 0' }}>
              No log entries found with the current filters.
            </div>
          ) : (
            <div
              ref={listRef}
              onScroll={handleScroll}
              style={{
                maxHeight: 500,
                overflowY: 'auto',
                border: '1px solid var(--sam-color-border-default)',
                borderRadius: 'var(--sam-radius-md)',
                backgroundColor: 'var(--sam-color-bg-primary, #0d1117)',
              }}
            >
              {entries.map((entry, idx) => (
                <LogEntry
                  key={`${entry.timestamp}-${idx}`}
                  entry={entry}
                  searchTerm={filter.search}
                />
              ))}

              {/* Load more */}
              {hasMore && (
                <div style={{ padding: 'var(--sam-space-2)', textAlign: 'center' }}>
                  <button
                    onClick={loadMore}
                    disabled={loading}
                    style={{
                      fontSize: 'var(--sam-type-caption-size)',
                      color: 'var(--sam-color-fg-accent, #3b82f6)',
                      background: 'none',
                      border: 'none',
                      cursor: loading ? 'default' : 'pointer',
                      textDecoration: 'underline',
                    }}
                  >
                    {loading ? 'Loading...' : 'Load older entries'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Match count when searching */}
          {filter.search && entries.length > 0 && (
            <div style={{ fontSize: '0.6875rem', color: 'var(--sam-color-fg-muted)', marginTop: 'var(--sam-space-1)' }}>
              {entries.length} entries matching &ldquo;{filter.search}&rdquo;
            </div>
          )}
        </>
      )}
    </Section>
  );
};
