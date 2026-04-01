import { type FC, useCallback,useState } from 'react';

import { CopyButton,highlightText } from '../shared/log';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogEntry {
  timestamp: string;
  level: string;
  event: string;
  message: string;
  details: Record<string, unknown>;
  /** Only present on stream entries */
  scriptName?: string;
  /** Only present on historical entries */
  invocationId?: string;
}

export interface LogEntryRowProps {
  entry: LogEntry;
  /** When set, matching substrings in the message are highlighted. */
  searchTerm?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LEVEL_COLORS: Record<string, string> = {
  error: '#f87171',
  warn: '#fbbf24',
  info: '#60a5fa',
  debug: '#a78bfa',
  log: 'var(--sam-color-fg-muted)',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a single log entry as copyable plain text. */
export function formatLogEntry(entry: LogEntry): string {
  const ts = new Date(entry.timestamp).toISOString();
  const level = entry.level.toUpperCase().padEnd(5);
  const hasDetails = Object.keys(entry.details).length > 0;
  let text = `[${ts}] ${level} ${entry.event}: ${entry.message}`;
  if (hasDetails) {
    text += '\n' + JSON.stringify(entry.details, null, 2);
  }
  return text;
}

/** Format multiple entries for bulk copy. */
export function formatLogEntries(entries: LogEntry[]): string {
  return entries.map(formatLogEntry).join('\n\n');
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const LogEntryRow: FC<LogEntryRowProps> = ({ entry, searchTerm }) => {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Object.keys(entry.details).length > 0;

  const getCopyText = useCallback(() => formatLogEntry(entry), [entry]);

  return (
    <div
      className="group px-4 py-2 border-b border-border-default text-sm relative"
      style={{ cursor: hasDetails ? 'pointer' : 'default' }}
      onClick={() => hasDetails && setExpanded(!expanded)}
      onKeyDown={hasDetails ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setExpanded(!expanded);
        }
      } : undefined}
      role={hasDetails ? 'button' : undefined}
      tabIndex={hasDetails ? 0 : undefined}
      aria-expanded={hasDetails ? expanded : undefined}
    >
      <div className="flex gap-2 items-baseline flex-wrap pr-8">
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
      <div className="overflow-hidden text-ellipsis whitespace-nowrap mt-0.5 pr-8">
        {highlightText(entry.message, searchTerm)}
      </div>

      <CopyButton
        getText={getCopyText}
        label="Copy log entry"
        testId="copy-entry-button"
        variant="inline"
      />

      {expanded && hasDetails && (
        <pre className="mt-2 p-2 bg-inset rounded-sm text-xs overflow-auto whitespace-pre-wrap break-all" style={{ maxHeight: '200px' }}>
          {JSON.stringify(entry.details, null, 2)}
        </pre>
      )}
    </div>
  );
};
