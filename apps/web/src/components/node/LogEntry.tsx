import { type FC, useState } from 'react';
import type { NodeLogEntry } from '@simple-agent-manager/shared';

interface LogEntryProps {
  entry: NodeLogEntry;
  searchTerm?: string;
}

const defaultLevelStyle = { color: 'var(--sam-color-fg-muted)', bg: 'transparent' };
const levelColors: Record<string, { color: string; bg: string }> = {
  error: { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.12)' },
  warn: { color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)' },
  info: defaultLevelStyle,
  debug: { color: 'var(--sam-color-fg-disabled, #6b7280)', bg: 'transparent' },
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

function highlightSearch(text: string, term: string): (string | JSX.Element)[] {
  if (!term) return [text];
  const parts: (string | JSX.Element)[] = [];
  const lower = text.toLowerCase();
  const termLower = term.toLowerCase();
  let lastIdx = 0;

  let idx = lower.indexOf(termLower);
  while (idx !== -1) {
    if (idx > lastIdx) parts.push(text.slice(lastIdx, idx));
    parts.push(
      <mark
        key={idx}
        style={{
          backgroundColor: 'rgba(250, 204, 21, 0.3)',
          color: 'inherit',
          borderRadius: 2,
          padding: '0 1px',
        }}
      >
        {text.slice(idx, idx + term.length)}
      </mark>
    );
    lastIdx = idx + term.length;
    idx = lower.indexOf(termLower, lastIdx);
  }

  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

export const LogEntry: FC<LogEntryProps> = ({ entry, searchTerm }) => {
  const [expanded, setExpanded] = useState(false);
  const { color, bg } = getLevelStyle(entry.level);
  const hasMetadata = entry.metadata && Object.keys(entry.metadata).length > 0;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--sam-space-2)',
        padding: '2px var(--sam-space-2)',
        fontSize: 'var(--sam-type-caption-size, 0.75rem)',
        fontFamily: 'monospace',
        lineHeight: 1.6,
        backgroundColor: bg,
        borderLeft: entry.level === 'error' ? '2px solid #ef4444' : entry.level === 'warn' ? '2px solid #f59e0b' : '2px solid transparent',
        cursor: hasMetadata ? 'pointer' : 'default',
      }}
      onClick={hasMetadata ? () => setExpanded(!expanded) : undefined}
    >
      {/* Timestamp */}
      <span style={{ color: 'var(--sam-color-fg-disabled, #6b7280)', flexShrink: 0, whiteSpace: 'nowrap' }}>
        {formatTimestamp(entry.timestamp)}
      </span>

      {/* Level badge */}
      <span
        style={{
          flexShrink: 0,
          width: 36,
          textAlign: 'center',
          textTransform: 'uppercase',
          fontSize: '0.625rem',
          fontWeight: 600,
          color,
          letterSpacing: '0.02em',
        }}
      >
        {entry.level === 'warn' ? 'WRN' : entry.level === 'error' ? 'ERR' : entry.level === 'debug' ? 'DBG' : 'INF'}
      </span>

      {/* Source badge */}
      <span
        style={{
          flexShrink: 0,
          padding: '0 4px',
          borderRadius: 3,
          fontSize: '0.625rem',
          fontWeight: 500,
          color: 'var(--sam-color-fg-muted)',
          backgroundColor: 'rgba(128, 128, 128, 0.1)',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.source}
      </span>

      {/* Message */}
      <span style={{ color: 'var(--sam-color-fg-primary)', flex: 1, wordBreak: 'break-word' }}>
        {searchTerm ? highlightSearch(entry.message, searchTerm) : entry.message}
        {hasMetadata && (
          <span style={{ color: 'var(--sam-color-fg-disabled)', marginLeft: 4 }}>
            {expanded ? '\u25BC' : '\u25B6'}
          </span>
        )}
      </span>

      {/* Expanded metadata */}
      {expanded && hasMetadata && (
        <div
          style={{
            marginTop: 4,
            padding: 'var(--sam-space-2)',
            backgroundColor: 'rgba(0, 0, 0, 0.05)',
            borderRadius: 'var(--sam-radius-sm, 4px)',
            fontSize: '0.6875rem',
            color: 'var(--sam-color-fg-muted)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {JSON.stringify(entry.metadata, null, 2)}
        </div>
      )}
    </div>
  );
};
