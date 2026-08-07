import type { PlatformError } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { type FC, useState } from 'react';

interface ObservabilityLogEntryProps {
  error: PlatformError;
  onDiagnose?: (error: PlatformError) => void;
}

const DEFAULT_SOURCE_COLOR = {
  bg: 'var(--sam-color-warning-tint)',
  text: 'var(--sam-color-warning-fg)',
};
const DEFAULT_LEVEL_COLOR = {
  bg: 'var(--sam-color-danger-tint)',
  text: 'var(--sam-color-danger-fg)',
};

const SOURCE_COLORS: Record<string, { bg: string; text: string }> = {
  client: {
    bg: 'var(--sam-color-info-tint)',
    text: 'var(--sam-admin-chart-series-2, var(--sam-color-info-fg))',
  },
  'vm-agent': {
    bg: 'var(--sam-color-info-tint)',
    text: 'var(--sam-admin-chart-series-3, var(--sam-color-purple))',
  },
  api: DEFAULT_SOURCE_COLOR,
};

const LEVEL_COLORS: Record<string, { bg: string; text: string }> = {
  error: DEFAULT_LEVEL_COLOR,
  warn: { bg: 'var(--sam-color-warning-tint)', text: 'var(--sam-color-warning-fg)' },
  info: { bg: 'var(--sam-color-info-tint)', text: 'var(--sam-color-info-fg)' },
};

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export const ObservabilityLogEntry: FC<ObservabilityLogEntryProps> = ({
  error: entry,
  onDiagnose,
}) => {
  const [expanded, setExpanded] = useState(false);

  const sourceColor = SOURCE_COLORS[entry.source] ?? DEFAULT_SOURCE_COLOR;
  const levelColor = LEVEL_COLORS[entry.level] ?? DEFAULT_LEVEL_COLOR;
  const hasDetails = entry.stack || entry.context;

  return (
    <div
      data-testid="observability-log-entry"
      className="min-w-0 border-b border-border-default px-4 py-3 transition-colors duration-150"
    >
      {/* Main row */}
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className="inline-flex items-center rounded-full px-2 text-[0.7rem] font-semibold uppercase tracking-tight"
            style={{ backgroundColor: levelColor.bg, color: levelColor.text, padding: '1px 8px' }}
          >
            {entry.level}
          </span>
          <span
            className="inline-flex items-center rounded-full px-2 text-[0.7rem] font-semibold uppercase tracking-tight"
            style={{ backgroundColor: sourceColor.bg, color: sourceColor.text, padding: '1px 8px' }}
          >
            {entry.source}
          </span>
          {entry.incident && (
            <span
              className="inline-flex items-center rounded-full bg-surface-secondary px-2 py-0.5 text-[0.7rem] font-medium text-fg-muted"
              aria-label={`Automatic VM evidence: ${entry.incident.status}`}
            >
              evidence {entry.incident.status}
            </span>
          )}
          <span className="min-w-0 text-xs text-fg-muted">{formatTimestamp(entry.timestamp)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1 self-end sm:ml-auto sm:self-auto">
          {onDiagnose && (
            <Button
              size="sm"
              variant="ghost"
              onClick={(event) => {
                event.stopPropagation();
                onDiagnose(entry);
              }}
            >
              Diagnose
            </Button>
          )}
          {hasDetails && (
            <button
              type="button"
              className="flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded-sm text-[0.7rem] text-fg-muted transition-colors hover:bg-control-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              aria-label={expanded ? 'Hide error details' : 'Show error details'}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              <span
                aria-hidden="true"
                className="transition-transform duration-150"
                style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
              >
                ▶
              </span>
            </button>
          )}
        </div>
      </div>
      {/* Message on its own line for better mobile readability */}
      <div className="mt-1 min-w-0 whitespace-normal break-words text-sm text-fg-primary">
        {entry.message}
      </div>

      {/* Metadata row */}
      {(entry.userId || entry.nodeId || entry.workspaceId) && (
        <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
          {entry.userId && <span className="min-w-0 break-all">user: {entry.userId}</span>}
          {entry.nodeId && <span className="min-w-0 break-all">node: {entry.nodeId}</span>}
          {entry.workspaceId && <span className="min-w-0 break-all">ws: {entry.workspaceId}</span>}
        </div>
      )}

      {/* Expanded details */}
      {expanded && hasDetails && (
        <div className="mt-3">
          {entry.stack && (
            <pre
              className="p-3 rounded-sm bg-inset text-fg-muted text-xs leading-normal overflow-auto m-0 whitespace-pre-wrap break-all"
              style={{ maxHeight: 200 }}
            >
              {entry.stack}
            </pre>
          )}
          {entry.context && (
            <pre
              className="p-3 rounded-sm bg-inset text-fg-muted text-xs leading-normal overflow-auto whitespace-pre-wrap break-all"
              style={{ maxHeight: 200, margin: entry.stack ? 'var(--sam-space-2) 0 0' : 0 }}
            >
              {JSON.stringify(entry.context, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};
