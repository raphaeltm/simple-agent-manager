import type { NodeLogEntry } from '@simple-agent-manager/shared';
import { type FC, useCallback,useState } from 'react';

import { CopyButton,highlightText } from '../shared/log';

interface LogEntryProps {
  entry: NodeLogEntry;
  searchTerm?: string;
}

const defaultLevelStyle = { color: 'var(--sam-color-fg-muted)', bg: 'transparent' };
const levelColors: Record<string, { color: string; bg: string }> = {
  error: { color: 'var(--sam-node-danger-fg)', bg: 'var(--sam-node-danger-tint)' },
  warn: { color: 'var(--sam-node-warning-fg)', bg: 'var(--sam-node-warning-tint)' },
  info: defaultLevelStyle,
  debug: { color: 'var(--sam-node-neutral-fg)', bg: 'transparent' },
};

function getLevelStyle(level: string): { color: string; bg: string } {
  return levelColors[level] ?? defaultLevelStyle;
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return ts;
  }
}

/** Format a node log entry as copyable plain text. */
export function formatNodeLogEntry(entry: NodeLogEntry): string {
  const ts = new Date(entry.timestamp).toISOString();
  const level = entry.level.toUpperCase().padEnd(5);
  let text = `[${ts}] ${level} [${entry.source}] ${entry.message}`;
  if (entry.metadata && Object.keys(entry.metadata).length > 0) {
    text += '\n' + JSON.stringify(entry.metadata, null, 2);
  }
  return text;
}

/** Format multiple node log entries for bulk copy. */
export function formatNodeLogEntries(entries: NodeLogEntry[]): string {
  return entries.map(formatNodeLogEntry).join('\n');
}

export const LogEntry: FC<LogEntryProps> = ({ entry, searchTerm }) => {
  const [expanded, setExpanded] = useState(false);
  const { color, bg } = getLevelStyle(entry.level);
  const hasMetadata = entry.metadata && Object.keys(entry.metadata).length > 0;

  const getCopyText = useCallback(() => formatNodeLogEntry(entry), [entry]);

  return (
    <div
      className="group flex items-start gap-2 px-2 font-mono leading-relaxed relative"
      style={{
        padding: '2px var(--sam-space-2)',
        fontSize: 'var(--sam-type-caption-size, 0.75rem)',
        backgroundColor: bg,
        borderLeft: entry.level === 'error' ? '2px solid var(--sam-node-danger-fg)' : entry.level === 'warn' ? '2px solid var(--sam-node-warning-fg)' : '2px solid transparent',
        cursor: hasMetadata ? 'pointer' : 'default',
      }}
      onClick={hasMetadata ? () => setExpanded(!expanded) : undefined}
      onKeyDown={hasMetadata ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setExpanded(!expanded);
        }
      } : undefined}
      role={hasMetadata ? 'button' : undefined}
      tabIndex={hasMetadata ? 0 : undefined}
      aria-expanded={hasMetadata ? expanded : undefined}
    >
      {/* Timestamp */}
      <span className="shrink-0 whitespace-nowrap" style={{ color: 'var(--sam-node-neutral-fg)' }}>
        {formatTimestamp(entry.timestamp)}
      </span>

      {/* Level badge */}
      <span
        className="shrink-0 w-9 text-center uppercase font-semibold"
        style={{
          fontSize: '0.625rem',
          color,
          letterSpacing: '0.02em',
        }}
      >
        {entry.level === 'warn' ? 'WRN' : entry.level === 'error' ? 'ERR' : entry.level === 'debug' ? 'DBG' : 'INF'}
      </span>

      {/* Source badge */}
      <span
        className="shrink-0 rounded-sm whitespace-nowrap text-fg-muted font-medium"
        style={{
          padding: '0 4px',
          fontSize: '0.625rem',
          backgroundColor: 'var(--sam-node-neutral-tint)',
        }}
      >
        {entry.source}
      </span>

      {/* Message */}
      <span className="text-fg-primary flex-1 break-words pr-8">
        {highlightText(entry.message, searchTerm)}
        {hasMetadata && (
          <span className="ml-1" style={{ color: 'var(--sam-node-neutral-fg)' }}>
            {expanded ? '\u25BC' : '\u25B6'}
          </span>
        )}
      </span>

      {/* Copy button — visible on hover */}
      <CopyButton
        getText={getCopyText}
        label="Copy log entry"
        testId="copy-entry-button"
        variant="inline"
      />

      {/* Expanded metadata */}
      {expanded && hasMetadata && (
        <div
          className="mt-1 p-2 rounded-sm text-fg-muted whitespace-pre-wrap break-all"
          style={{
            backgroundColor: 'var(--sam-node-code-subtle-bg)',
            fontSize: '0.6875rem',
          }}
        >
          {JSON.stringify(entry.metadata, null, 2)}
        </div>
      )}
    </div>
  );
};
