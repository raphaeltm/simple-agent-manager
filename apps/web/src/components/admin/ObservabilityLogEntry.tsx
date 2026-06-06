import type { PlatformError } from '@simple-agent-manager/shared';
import { type FC,useState } from 'react';

interface ObservabilityLogEntryProps {
  error: PlatformError;
}

const SOURCE_COLORS: Record<string, { bg: string; text: string }> = {
  client: { bg: 'var(--sam-color-info-tint)', text: 'var(--sam-admin-chart-series-2, var(--sam-color-info-fg))' },
  'vm-agent': { bg: 'var(--sam-color-info-tint)', text: 'var(--sam-admin-chart-series-3, var(--sam-color-purple))' },
  api: { bg: 'var(--sam-color-warning-tint)', text: 'var(--sam-color-warning-fg)' },
};

const LEVEL_COLORS: Record<string, { bg: string; text: string }> = {
  error: { bg: 'var(--sam-color-danger-tint)', text: 'var(--sam-color-danger-fg)' },
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

export const ObservabilityLogEntry: FC<ObservabilityLogEntryProps> = ({ error: entry }) => {
  const [expanded, setExpanded] = useState(false);

  const sourceColor = SOURCE_COLORS[entry.source] ?? SOURCE_COLORS.api!;
  const levelColor = LEVEL_COLORS[entry.level] ?? LEVEL_COLORS.error!;
  const hasDetails = entry.stack || entry.context;

  return (
    <div
      className="border-b border-border-default px-4 py-3 transition-colors duration-150"
      style={{ cursor: hasDetails ? 'pointer' : 'default' }}
      onClick={() => hasDetails && setExpanded(!expanded)}
      onKeyDown={(e) => {
        if (hasDetails && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          setExpanded(!expanded);
        }
      }}
      role={hasDetails ? 'button' : undefined}
      tabIndex={hasDetails ? 0 : undefined}
      aria-expanded={hasDetails ? expanded : undefined}
    >
      {/* Main row */}
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="inline-flex items-center px-2 rounded-full text-[0.7rem] font-semibold uppercase tracking-tight"
          style={{ backgroundColor: levelColor.bg, color: levelColor.text, padding: '1px 8px' }}
        >
          {entry.level}
        </span>
        <span
          className="inline-flex items-center px-2 rounded-full text-[0.7rem] font-semibold uppercase tracking-tight"
          style={{ backgroundColor: sourceColor.bg, color: sourceColor.text, padding: '1px 8px' }}
        >
          {entry.source}
        </span>
        <span className="text-xs text-fg-muted whitespace-nowrap shrink-0">
          {formatTimestamp(entry.timestamp)}
        </span>
        {hasDetails && (
          <span
            className="text-[0.7rem] text-fg-muted shrink-0 ml-auto transition-transform duration-150"
            style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
          >
            ▶
          </span>
        )}
      </div>
      {/* Message on its own line for better mobile readability */}
      <div className="text-sm text-fg-primary mt-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {entry.message}
      </div>

      {/* Metadata row */}
      {(entry.userId || entry.nodeId || entry.workspaceId) && (
        <div className="flex gap-3 mt-1 text-xs text-fg-muted">
          {entry.userId && <span>user: {entry.userId}</span>}
          {entry.nodeId && <span>node: {entry.nodeId}</span>}
          {entry.workspaceId && <span>ws: {entry.workspaceId}</span>}
        </div>
      )}

      {/* Expanded details */}
      {expanded && hasDetails && (
        <div className="mt-3">
          {entry.stack && (
            <pre className="p-3 rounded-sm bg-inset text-fg-muted text-xs leading-normal overflow-auto m-0 whitespace-pre-wrap break-all" style={{ maxHeight: 200 }}>
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
