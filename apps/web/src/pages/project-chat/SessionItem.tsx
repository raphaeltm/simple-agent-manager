import {
  AlertCircle,
  CheckCircle2,
  CirclePause,
  HelpCircle,
  ListTodo,
  Loader2,
  MessageSquare,
  XCircle,
} from 'lucide-react';
import type { ReactNode } from 'react';

import type { ChatSessionResponse } from '../../lib/api';
import {
  type AttentionState,
  formatRelativeTime,
  getAttentionState,
  getLastActivity,
  getSessionMode,
} from '../../lib/chat-session-utils';
import { stripMarkdown } from '../../lib/text-utils';

export type SessionItemVariant = 'default' | 'group-parent' | 'group-child';

// ---------------------------------------------------------------------------
// Attention state -> icon + color mapping (uses design tokens)
// ---------------------------------------------------------------------------

const ATTENTION_ICON_MAP: Record<AttentionState, {
  icon: typeof HelpCircle;
  color: string;
  label: string;
}> = {
  needs_input: { icon: HelpCircle, color: 'var(--sam-color-warning, #f59e0b)', label: 'Needs input' },
  error:       { icon: AlertCircle, color: 'var(--sam-color-danger, #ef4444)', label: 'Error' },
  active:      { icon: Loader2, color: 'var(--sam-color-success)', label: 'Running' },
  idle:        { icon: CirclePause, color: 'var(--sam-color-warning, #f59e0b)', label: 'Idle' },
  completed:   { icon: CheckCircle2, color: 'var(--sam-color-fg-muted)', label: 'Completed' },
  failed:      { icon: XCircle, color: 'var(--sam-color-danger, #ef4444)', label: 'Failed' },
  stopped:     { icon: CirclePause, color: 'var(--sam-color-fg-muted)', label: 'Stopped' },
};

export function SessionItem({
  session,
  isSelected,
  onSelect,
  variant = 'default',
  badge,
  progressBar,
  blockedBadge,
  blockedByTitle,
  ariaLabel,
  lineageText,
}: {
  session: ChatSessionResponse;
  isSelected: boolean;
  onSelect: (id: string) => void;
  variant?: SessionItemVariant;
  badge?: ReactNode;
  progressBar?: ReactNode;
  blockedBadge?: boolean;
  blockedByTitle?: string;
  ariaLabel?: string;
  lineageText?: string;
}) {
  const attentionState = getAttentionState(session);
  const mode = getSessionMode(session);

  const isChild = variant === 'group-child';
  const isGrouped = variant !== 'default';

  // Icon config — blocked overrides normal attention state
  const iconConfig = blockedBadge
    ? { icon: AlertCircle, color: 'var(--sam-color-danger, #ef4444)', label: 'Blocked' }
    : ATTENTION_ICON_MAP[attentionState];

  const StatusIcon = iconConfig.icon;
  const ModeIcon = mode === 'task' ? ListTodo : MessageSquare;

  // Font sizing: parent 13px/500, child 12px/400, default unchanged
  const titleStyle: React.CSSProperties = isChild
    ? { fontSize: 12, fontWeight: 400, color: 'var(--sam-color-fg-muted, #9fb7ae)' }
    : variant === 'group-parent'
      ? { fontSize: 13, fontWeight: 500 }
      : {};

  return (
    <div
      className={
        isGrouped
          ? 'block w-full text-left transition-colors duration-100'
          : `block w-full text-left px-3 py-1.5 border-b border-[rgba(34,197,94,0.06)] transition-all duration-150 ${isSelected ? 'bg-[rgba(22,163,74,0.08)]' : 'hover:bg-[rgba(34,197,94,0.04)]'}`
      }
      style={
        isGrouped
          ? { padding: isChild ? '4px 10px' : '6px 10px' }
          : {
              borderLeft: isSelected
                ? '3px solid var(--sam-color-accent-primary)'
                : '3px solid transparent',
              boxShadow: isSelected
                ? 'inset 3px 0 8px -3px rgba(34, 197, 94, 0.3)'
                : undefined,
            }
      }
    >
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        aria-label={ariaLabel}
        className="block w-full text-left bg-transparent border-none cursor-pointer p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--sam-color-focus-ring)]"
      >
        <div className="flex items-center gap-1.5 mb-0.5">
          {/* Status icon — replaces the old colored dot */}
          <span
            className="shrink-0 flex items-center"
            style={{ color: iconConfig.color }}
            title={iconConfig.label}
          >
            <StatusIcon
              size={14}
              className={attentionState === 'active' ? 'motion-safe:animate-spin' : ''}
            />
            <span className="sr-only">{iconConfig.label}</span>
          </span>
          <span
            className={`overflow-hidden text-ellipsis whitespace-nowrap flex-1 ${
              !isChild
                ? isSelected ? 'font-semibold text-fg-primary' : 'font-medium text-fg-primary'
                : ''
            }`}
            style={titleStyle}
          >
            {session.topic ? stripMarkdown(session.topic) : `Chat ${session.id.slice(0, 8)}`}
          </span>
          {badge}
          {blockedBadge && (
            <span className="px-1 rounded-full text-danger-fg bg-danger-tint" style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
              BLOCKED
            </span>
          )}
        </div>
        <div
          className="flex items-center gap-1.5 text-fg-muted"
          style={{ fontSize: 10, paddingLeft: 20 }}
        >
          {blockedBadge && blockedByTitle ? (
            <span className="truncate text-danger-fg">
              Waiting on: {blockedByTitle}
            </span>
          ) : (
            <>
              {/* Mode icon + label */}
              <span className="flex items-center gap-0.5 shrink-0" title={mode === 'task' ? 'Task' : 'Conversation'}>
                <ModeIcon size={10} />
                <span>{mode === 'task' ? 'Task' : 'Chat'}</span>
              </span>
              {/* Attention label for high-priority states */}
              {attentionState === 'needs_input' && (
                <span className="text-warning-fg font-medium">Needs input</span>
              )}
              {lineageText && (
                <>
                  <span>&middot;</span>
                  <span className="truncate">{lineageText}</span>
                </>
              )}
              <span className="ml-auto shrink-0">{formatRelativeTime(getLastActivity(session))}</span>
            </>
          )}
        </div>
        {progressBar}
      </button>
    </div>
  );
}
