import { useState, type FC, type CSSProperties } from 'react';
import type { PlatformError } from '@simple-agent-manager/shared';

interface ObservabilityLogEntryProps {
  error: PlatformError;
}

const SOURCE_COLORS: Record<string, { bg: string; text: string }> = {
  client: { bg: 'rgba(59, 130, 246, 0.15)', text: '#60a5fa' },
  'vm-agent': { bg: 'rgba(168, 85, 247, 0.15)', text: '#c084fc' },
  api: { bg: 'rgba(245, 158, 11, 0.15)', text: '#fbbf24' },
};

const LEVEL_COLORS: Record<string, { bg: string; text: string }> = {
  error: { bg: 'rgba(239, 68, 68, 0.15)', text: '#f87171' },
  warn: { bg: 'rgba(245, 158, 11, 0.15)', text: '#fbbf24' },
  info: { bg: 'rgba(59, 130, 246, 0.15)', text: '#60a5fa' },
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

const badgeStyle = (colors: { bg: string; text: string }): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  padding: '1px 8px',
  borderRadius: 'var(--sam-radius-full)',
  fontSize: '0.7rem',
  fontWeight: 600,
  letterSpacing: '0.02em',
  backgroundColor: colors.bg,
  color: colors.text,
  textTransform: 'uppercase',
});

export const ObservabilityLogEntry: FC<ObservabilityLogEntryProps> = ({ error: entry }) => {
  const [expanded, setExpanded] = useState(false);

  const sourceColor = SOURCE_COLORS[entry.source] ?? SOURCE_COLORS.api!;
  const levelColor = LEVEL_COLORS[entry.level] ?? LEVEL_COLORS.error!;
  const hasDetails = entry.stack || entry.context;

  return (
    <div
      style={{
        borderBottom: '1px solid var(--sam-color-border-default)',
        padding: 'var(--sam-space-3) var(--sam-space-4)',
        cursor: hasDetails ? 'pointer' : 'default',
        transition: 'background 150ms ease',
      }}
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)', minWidth: 0 }}>
        <span style={badgeStyle(levelColor)}>{entry.level}</span>
        <span style={badgeStyle(sourceColor)}>{entry.source}</span>
        <span
          style={{
            fontSize: 'var(--sam-type-caption-size)',
            color: 'var(--sam-color-fg-muted)',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {formatTimestamp(entry.timestamp)}
        </span>
        {hasDetails && (
          <span
            style={{
              fontSize: '0.7rem',
              color: 'var(--sam-color-fg-muted)',
              transition: 'transform 150ms ease',
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
              flexShrink: 0,
              marginLeft: 'auto',
            }}
          >
            ▶
          </span>
        )}
      </div>
      {/* Message on its own line for better mobile readability */}
      <div
        style={{
          fontSize: 'var(--sam-type-secondary-size)',
          color: 'var(--sam-color-fg-primary)',
          marginTop: 'var(--sam-space-1)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.message}
      </div>

      {/* Metadata row */}
      {(entry.userId || entry.nodeId || entry.workspaceId) && (
        <div
          style={{
            display: 'flex',
            gap: 'var(--sam-space-3)',
            marginTop: 'var(--sam-space-1)',
            fontSize: 'var(--sam-type-caption-size)',
            color: 'var(--sam-color-fg-muted)',
          }}
        >
          {entry.userId && <span>user: {entry.userId}</span>}
          {entry.nodeId && <span>node: {entry.nodeId}</span>}
          {entry.workspaceId && <span>ws: {entry.workspaceId}</span>}
        </div>
      )}

      {/* Expanded details */}
      {expanded && hasDetails && (
        <div style={{ marginTop: 'var(--sam-space-3)' }}>
          {entry.stack && (
            <pre
              style={{
                padding: 'var(--sam-space-3)',
                borderRadius: 'var(--sam-radius-sm)',
                backgroundColor: 'var(--sam-color-bg-inset)',
                color: 'var(--sam-color-fg-muted)',
                fontSize: '0.75rem',
                lineHeight: 1.5,
                overflow: 'auto',
                maxHeight: 200,
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {entry.stack}
            </pre>
          )}
          {entry.context && (
            <pre
              style={{
                padding: 'var(--sam-space-3)',
                borderRadius: 'var(--sam-radius-sm)',
                backgroundColor: 'var(--sam-color-bg-inset)',
                color: 'var(--sam-color-fg-muted)',
                fontSize: '0.75rem',
                lineHeight: 1.5,
                overflow: 'auto',
                maxHeight: 200,
                margin: entry.stack ? 'var(--sam-space-2) 0 0' : 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {JSON.stringify(entry.context, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};
