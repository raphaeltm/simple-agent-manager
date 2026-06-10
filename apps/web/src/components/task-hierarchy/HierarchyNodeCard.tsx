import { AlertCircle, CheckCircle2, CirclePause, Loader2, XCircle } from 'lucide-react';

import { formatRelativeTime } from '../../lib/time-utils';
import type { HierarchyNode } from './buildHierarchyTree';

const STATUS_CONFIG: Record<
  string,
  { icon: typeof CheckCircle2; colorVar: string; label: string }
> = {
  completed: { icon: CheckCircle2, colorVar: 'var(--sam-color-success)', label: 'Completed' },
  in_progress: { icon: Loader2, colorVar: 'var(--sam-color-success)', label: 'Running' },
  failed: { icon: XCircle, colorVar: 'var(--sam-color-danger)', label: 'Failed' },
  cancelled: { icon: XCircle, colorVar: 'var(--sam-color-danger)', label: 'Cancelled' },
  queued: { icon: CirclePause, colorVar: 'var(--sam-color-warning)', label: 'Queued' },
  delegated: { icon: Loader2, colorVar: 'var(--sam-color-info)', label: 'Delegated' },
  ready: { icon: CirclePause, colorVar: 'var(--sam-color-warning)', label: 'Ready' },
  draft: { icon: CirclePause, colorVar: 'var(--sam-color-fg-muted)', label: 'Draft' },
};

function getStatusConfig(status: string) {
  return STATUS_CONFIG[status] ?? { icon: AlertCircle, colorVar: 'var(--sam-color-fg-muted)', label: status };
}

export function HierarchyNodeCard({
  node,
  isFocus,
  onNavigate,
  compact,
  depthBadge,
  isFilterMatch,
}: {
  node: HierarchyNode;
  isFocus: boolean;
  onNavigate: (sessionId: string) => void;
  compact?: boolean;
  depthBadge?: number;
  isFilterMatch?: boolean;
}) {
  const statusCfg = getStatusConfig(node.task.status);
  const StatusIcon = statusCfg.icon;
  const hasSession = node.sessionId != null;
  const isDisabled = !hasSession;

  return (
    <button
      type="button"
      data-focus={isFocus ? 'true' : undefined}
      onClick={() => {
        if (hasSession) onNavigate(node.sessionId!);
      }}
      disabled={isDisabled}
      title={isDisabled ? 'Task is queued — no session yet' : node.task.title}
      role="treeitem"
      aria-label={`${node.task.title}, ${statusCfg.label}${isFocus ? ', current task' : ''}${isDisabled ? ', no session available' : ''}`}
      className={`
        flex items-center gap-2 w-full text-left transition-all duration-150 rounded-lg
        ${compact ? 'px-2.5 py-1.5' : 'px-3 py-2'}
        ${isFocus
          ? 'border-2 shadow-sm'
          : isFilterMatch
            ? 'border shadow-sm'
            : 'border'
        }
        ${isDisabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}
      `}
      style={{
        borderColor: isFocus
          ? 'var(--sam-color-accent-primary)'
          : isFilterMatch
            ? 'var(--sam-color-info)'
            : 'var(--sam-color-border-default)',
        background: isFocus
          ? 'var(--sam-color-accent-primary-tint)'
          : isFilterMatch
            ? 'var(--sam-color-info-tint)'
            : 'var(--sam-color-bg-inset)',
        boxShadow: isFocus
          ? '0 0 12px var(--sam-color-accent-primary-tint)'
          : undefined,
        color: 'var(--sam-color-fg-primary)',
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        if (!isFocus && !isDisabled) {
          e.currentTarget.style.borderColor = 'var(--sam-color-accent-primary)';
          e.currentTarget.style.background = 'var(--sam-color-accent-primary-tint)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isFocus && !isDisabled) {
          e.currentTarget.style.borderColor = isFilterMatch
            ? 'var(--sam-color-info)'
            : 'var(--sam-color-border-default)';
          e.currentTarget.style.background = isFilterMatch
            ? 'var(--sam-color-info-tint)'
            : 'var(--sam-color-bg-inset)';
        }
      }}
    >
      <span style={{ color: statusCfg.colorVar }} className="flex shrink-0">
        <StatusIcon
          size={compact ? 14 : 16}
          className={node.task.status === 'in_progress' || node.task.status === 'delegated' ? 'motion-safe:animate-spin' : ''}
        />
      </span>
      <div className="flex-1 min-w-0">
        <div
          className="truncate"
          style={{
            fontSize: compact ? 11 : 12,
            fontWeight: isFocus ? 600 : 500,
          }}
        >
          {node.task.title}
        </div>
        <div
          className="flex items-center gap-1 mt-px"
          style={{ fontSize: compact ? 9 : 10, color: 'var(--sam-color-fg-muted)' }}
        >
          <span
            className="inline-block px-1 rounded-full font-semibold uppercase"
            style={{
              fontSize: 9,
              background: `color-mix(in srgb, ${statusCfg.colorVar} 15%, transparent)`,
              color: statusCfg.colorVar,
            }}
          >
            {statusCfg.label}
          </span>
          {node.task.blocked && (
            <span
              className="inline-block px-1 rounded-full font-semibold uppercase"
              style={{
                fontSize: 9,
                background: 'var(--sam-color-danger-tint)',
                color: 'var(--sam-color-danger)',
              }}
            >
              BLOCKED
            </span>
          )}
          {node.startedAt && (
            <span>{formatRelativeTime(node.startedAt)}</span>
          )}
        </div>
      </div>
      {depthBadge != null && depthBadge > 0 && (
        <span
          className="shrink-0 rounded-full font-semibold"
          style={{
            fontSize: 9,
            padding: '1px 5px',
            background: 'var(--sam-status-muted-bg)',
            color: 'var(--sam-color-fg-muted)',
          }}
        >
          L{depthBadge + 1}
        </span>
      )}
      {isFocus && (
        <span
          className="shrink-0 font-bold uppercase tracking-wide"
          style={{
            fontSize: 9,
            color: 'var(--sam-color-accent-primary)',
          }}
        >
          Current
        </span>
      )}
    </button>
  );
}
