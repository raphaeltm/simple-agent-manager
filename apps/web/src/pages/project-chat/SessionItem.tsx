import type { ReactNode } from 'react';
import { GitFork, Lightbulb } from 'lucide-react';

import type { ChatSessionResponse } from '../../lib/api';
import {
  formatRelativeTime,
  getLastActivity,
  getSessionState,
  STATE_COLORS,
  STATE_LABELS,
} from '../../lib/chat-session-utils';
import { stripMarkdown } from '../../lib/text-utils';

export type SessionItemVariant = 'default' | 'group-parent' | 'group-child';

export function SessionItem({
  session,
  isSelected,
  onSelect,
  onFork,
  ideaTitle,
  variant = 'default',
  badge,
  progressBar,
  blockedBadge,
  blockedByTitle,
}: {
  session: ChatSessionResponse;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onFork?: (session: ChatSessionResponse) => void;
  ideaTitle?: string;
  variant?: SessionItemVariant;
  /** Extra badge rendered next to the title (e.g., "3 SUB"). */
  badge?: ReactNode;
  /** Progress bar rendered below the title row (e.g., sub-task completion). */
  progressBar?: ReactNode;
  /** Whether to show a "BLOCKED" badge on this item. */
  blockedBadge?: boolean;
  /** Title of the task this item is blocked by. */
  blockedByTitle?: string;
}) {
  const state = getSessionState(session);
  const dotColor = blockedBadge ? 'var(--sam-color-danger, #ef4444)' : STATE_COLORS[state];
  const canFork = state === 'terminated' && !!session.task?.id;

  const isChild = variant === 'group-child';
  const isGrouped = variant !== 'default';

  // Font sizing: parent 13px/500, child 12px/400, default unchanged
  const titleStyle: React.CSSProperties = isChild
    ? { fontSize: 12, fontWeight: 400, color: 'var(--sam-color-fg-secondary, #c4d8d0)' }
    : variant === 'group-parent'
      ? { fontSize: 13, fontWeight: 500 }
      : {};

  const metaFontSize = isChild ? 10 : 11;

  return (
    <div
      className={
        isGrouped
          ? 'block w-full text-left transition-colors duration-100'
          : `block w-full text-left px-3 py-2.5 border-b border-border-default transition-colors duration-100 ${isSelected ? 'bg-inset' : 'hover:bg-surface-hover'}`
      }
      style={
        isGrouped
          ? { padding: isChild ? '6px 10px' : '8px 10px' }
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
        className="block w-full text-left bg-transparent border-none cursor-pointer p-0"
      >
        {/* Idea tag — only for default/parent variants */}
        {ideaTitle && !isChild && (
          <div className="flex items-center gap-1 mb-1 pl-[calc(6px+8px)]">
            <span
              className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full max-w-full overflow-hidden text-ellipsis whitespace-nowrap"
              style={{
                color: 'var(--sam-color-accent-primary)',
                background: 'color-mix(in srgb, var(--sam-color-accent-primary) 12%, transparent)',
              }}
              title={`Idea: ${ideaTitle}`}
            >
              <Lightbulb size={10} /> {ideaTitle}
            </span>
          </div>
        )}
        <div className="flex items-center gap-2 mb-0.5">
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
          className="flex items-center gap-2 text-fg-muted"
          style={{ fontSize: metaFontSize, paddingLeft: 'calc(6px + 8px)' }}
        >
          {blockedBadge && blockedByTitle ? (
            <span className="truncate" style={{ color: '#f87171' }}>
              Waiting on: {blockedByTitle}
            </span>
          ) : (
            <>
              <span style={{ color: dotColor }} className="font-medium">
                {STATE_LABELS[state]}
              </span>
              <span>{session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}</span>
              <span className="ml-auto">{formatRelativeTime(getLastActivity(session))}</span>
            </>
          )}
        </div>
        {progressBar}
      </button>
      {canFork && onFork && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onFork(session); }}
          className="mt-1 ml-[calc(6px+8px)] flex items-center gap-1 text-xs text-accent-primary bg-transparent border border-transparent rounded-sm cursor-pointer py-1 px-1.5 hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary transition-colors"
          title="Continue from this session"
        >
          <GitFork size={12} />
          Continue
        </button>
      )}
    </div>
  );
}
