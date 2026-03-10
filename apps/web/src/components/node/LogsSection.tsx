import { type FC, useCallback, useEffect, useRef } from 'react';
import { ScrollText, Pause, Play, RefreshCw } from 'lucide-react';
import { Skeleton } from '@simple-agent-manager/ui';
import { SectionHeader } from './SectionHeader';
import { Section } from './Section';
import { LogEntry, formatNodeLogEntries } from './LogEntry';
import { LogFilters } from './LogFilters';
import { CopyButton } from '../shared/log';
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

  const getCopyAllText = useCallback(() => formatNodeLogEntries(entries), [entries]);

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
        <div className="text-fg-muted" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>
          Start the node to view its logs.
        </div>
      ) : (
        <>
          {/* Toolbar */}
          <div className="flex justify-between items-end gap-3 mb-3 flex-wrap">
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

            <div className="flex gap-2 items-center">
              {/* Streaming indicator */}
              <span
                className="inline-flex items-center gap-1 font-semibold"
                style={{
                  fontSize: '0.625rem',
                  color: streaming ? '#22c55e' : 'var(--sam-color-fg-muted)',
                }}
              >
                <span
                  className="rounded-full"
                  style={{
                    width: 6,
                    height: 6,
                    backgroundColor: streaming ? '#22c55e' : 'var(--sam-color-fg-disabled)',
                  }}
                />
                {streaming ? 'LIVE' : 'DISCONNECTED'}
              </span>

              {/* Pause/Resume */}
              <button
                onClick={togglePause}
                title={paused ? 'Resume streaming' : 'Pause streaming'}
                className="inline-flex items-center justify-center w-7 h-7 rounded-sm border border-border-default bg-surface text-fg-muted cursor-pointer"
              >
                {paused ? <Play size={14} /> : <Pause size={14} />}
              </button>

              {/* Refresh */}
              <button
                onClick={refresh}
                title="Refresh logs"
                className="inline-flex items-center justify-center w-7 h-7 rounded-sm border border-border-default bg-surface text-fg-muted cursor-pointer"
              >
                <RefreshCw size={14} />
              </button>

              {/* Copy All */}
              {entries.length > 0 && (
                <CopyButton
                  getText={getCopyAllText}
                  label="Copy all visible logs"
                  testId="copy-all-button"
                  variant="toolbar"
                />
              )}
            </div>
          </div>

          {/* Error banner */}
          {error && (
            <div
              className="px-3 py-2 rounded-sm mb-2"
              style={{
                backgroundColor: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                color: 'var(--sam-color-fg-danger, #ef4444)',
                fontSize: 'var(--sam-type-caption-size)',
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
            <div className="text-fg-muted py-4" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>
              No log entries found with the current filters.
            </div>
          ) : (
            <div
              ref={listRef}
              onScroll={handleScroll}
              className="max-h-[500px] overflow-y-auto border border-border-default rounded-md"
              style={{ backgroundColor: 'var(--sam-color-bg-primary, #0d1117)' }}
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
                <div className="p-2 text-center">
                  <button
                    onClick={loadMore}
                    disabled={loading}
                    className="bg-transparent border-none underline"
                    style={{
                      fontSize: 'var(--sam-type-caption-size)',
                      color: 'var(--sam-color-fg-accent, #3b82f6)',
                      cursor: loading ? 'default' : 'pointer',
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
            <div className="text-fg-muted mt-1" style={{ fontSize: '0.6875rem' }}>
              {entries.length} entries matching &ldquo;{filter.search}&rdquo;
            </div>
          )}
        </>
      )}
    </Section>
  );
};
