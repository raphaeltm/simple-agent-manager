import { type FC, useState, useCallback, type ReactNode } from 'react';
import { Copy, Check } from 'lucide-react';

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

/**
 * Highlight occurrences of `term` within `text` by wrapping matches in <mark>.
 * Returns the original string if no term is provided or no match is found.
 */
function highlightText(text: string, term: string | undefined): ReactNode {
  if (!term || term.length === 0) return text;

  // Escape regex special chars in the search term
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);

  if (parts.length === 1) return text; // no match

  return parts.map((part, i) =>
    regex.test(part) ? (
      <mark key={i} className="bg-accent-tint text-fg-primary rounded-[2px] px-px">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const LogEntryRow: FC<LogEntryRowProps> = ({ entry, searchTerm }) => {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const hasDetails = Object.keys(entry.details).length > 0;

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation(); // Don't toggle expand
      const text = formatLogEntry(entry);
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    },
    [entry],
  );

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

      {/* Copy button — visible on hover (desktop) or always visible (touch) */}
      <button
        onClick={handleCopy}
        className="absolute right-2 top-1 p-2.5 rounded-sm border border-border-default bg-surface text-fg-muted opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus:opacity-100 transition-opacity cursor-pointer"
        style={{ minWidth: '44px', minHeight: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        aria-label="Copy log entry"
        title="Copy log entry"
        data-testid="copy-entry-button"
      >
        {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
      </button>

      {expanded && hasDetails && (
        <pre className="mt-2 p-2 bg-inset rounded-sm text-xs overflow-auto whitespace-pre-wrap break-all" style={{ maxHeight: '200px' }}>
          {JSON.stringify(entry.details, null, 2)}
        </pre>
      )}
    </div>
  );
};
