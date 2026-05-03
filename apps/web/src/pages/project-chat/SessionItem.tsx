import { GitFork } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ChatSessionResponse } from '../../lib/api';
import {
  formatRelativeTime,
  getLastActivity,
  getSessionState,
  STATE_COLORS,
} from '../../lib/chat-session-utils';
import { stripMarkdown } from '../../lib/text-utils';

export type SessionItemVariant = 'default' | 'group-parent' | 'group-child';

export function SessionItem({
  session,
  isSelected,
  onSelect,
  onFork,
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
  onFork?: (session: ChatSessionResponse) => void;
  variant?: SessionItemVariant;
  /** Extra badge rendered next to the title (e.g., expand toggle). */
  badge?: ReactNode;
  /** Progress bar rendered below the title row (e.g., sub-task completion). */
  progressBar?: ReactNode;
  /** Whether to show a "BLOCKED" badge on this item. */
  blockedBadge?: boolean;
  /** Title of the task this item is blocked by. */
  blockedByTitle?: string;
  /** Accessible label override for the select button (e.g., context-anchor annotation). */
  ariaLabel?: string;
  /** Lineage subtitle text (e.g., "↩ attempt 3" or "⑂ forked from X"). */
  lineageText?: string;
}) {
  const state = getSessionState(session);
  const dotColor = blockedBadge ? 'var(--sam-color-danger, #ef4444)' : STATE_COLORS[state];
  const canFork = state === 'terminated' && !!session.task?.id;

  const isChild = variant === 'group-child';
  const isGrouped = variant !== 'default';

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
          : `block w-full text-left px-3 py-1.5 border-b border-border-default transition-colors duration-100 ${isSelected ? 'bg-inset' : 'hover:bg-surface-hover'}`
      }
      style={
        isGrouped
          ? { padding: isChild ? '4px 10px' : '6px 10px' }
          : {
              borderLeft: isSelected
                ? '3px solid var(--sam-color-accent-primary)'
                : '3px solid transparent',
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
          <span
            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: dotColor }}
          />
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
            <span
              style={{
                background: 'rgba(239,68,68,0.15)',
                color: '#f87171',
                padding: '0 5px',
                borderRadius: 9999,
                fontSize: 9,
                fontWeight: 600,
                textTransform: 'uppercase',
                whiteSpace: 'nowrap',
              }}
            >
              BLOCKED
            </span>
          )}
        </div>
        <div
          className="flex items-center gap-1.5 text-fg-muted"
          style={{ fontSize: 10, paddingLeft: 'calc(6px + 6px)' }}
        >
          {blockedBadge && blockedByTitle ? (
            <span className="truncate" style={{ color: '#f87171' }}>
              Waiting on: {blockedByTitle}
            </span>
          ) : (
            <>
              {lineageText && (
                <span className="truncate" style={{ color: 'var(--sam-color-fg-muted)' }}>
                  {lineageText}
                </span>
              )}
              <span className="ml-auto shrink-0">{formatRelativeTime(getLastActivity(session))}</span>
            </>
          )}
        </div>
        {progressBar}
      </button>
      {canFork && onFork && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onFork(session); }}
          className="mt-1 ml-[calc(6px+6px)] flex items-center gap-1 text-xs text-accent-primary bg-transparent border border-transparent rounded-sm cursor-pointer py-0.5 px-1.5 hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary transition-colors"
          title="Continue from this session"
        >
          <GitFork size={12} />
          Continue
        </button>
      )}
    </div>
  );
}
