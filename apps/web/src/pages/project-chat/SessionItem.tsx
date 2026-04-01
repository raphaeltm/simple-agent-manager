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

export function SessionItem({
  session,
  isSelected,
  onSelect,
  onFork,
  ideaTitle,
}: {
  session: ChatSessionResponse;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onFork?: (session: ChatSessionResponse) => void;
  ideaTitle?: string;
}) {
  const state = getSessionState(session);
  const dotColor = STATE_COLORS[state];
  const canFork = state === 'terminated' && !!session.task?.id;

  return (
    <div
      className={`block w-full text-left px-3 py-2.5 border-b border-border-default transition-colors duration-100 ${isSelected ? 'bg-inset' : 'hover:bg-surface-hover'}`}
      style={{
        borderLeft: isSelected
          ? '3px solid var(--sam-color-accent-primary)'
          : '3px solid transparent',
      }}
    >
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        className="block w-full text-left bg-transparent border-none cursor-pointer p-0"
      >
        {/* Idea tag */}
        {ideaTitle && (
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
          <span className={`text-sm overflow-hidden text-ellipsis whitespace-nowrap flex-1 ${isSelected ? 'font-semibold text-fg-primary' : 'font-medium text-fg-primary'}`}>
            {session.topic ? stripMarkdown(session.topic) : `Chat ${session.id.slice(0, 8)}`}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-muted pl-[calc(6px+8px)]">
          <span style={{ color: dotColor }} className="font-medium">
            {STATE_LABELS[state]}
          </span>
          <span>{session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}</span>
          <span className="ml-auto">{formatRelativeTime(getLastActivity(session))}</span>
        </div>
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
