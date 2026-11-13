import { PersonAvatar, personColorVar, personTextClassName } from '@simple-agent-manager/ui';
import { AlertCircle, GitPullRequest, ListTodo, MessageSquare } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

import type { ChatSessionResponse } from '../../lib/api';
import {
  ATTENTION_ICON,
  formatRelativeTime,
  getAttentionState,
  getLastActivity,
  getSessionMode,
} from '../../lib/chat-session-utils';
import { sessionOwner } from '../../lib/session-people';
import { stripMarkdown } from '../../lib/text-utils';

/**
 * One row of the chat list (SAM Glass "Chat list"): status icon, one-line title, badges on
 * the right, then a meta line with the owner and the age in mono. Rows someone else started
 * carry a thin light on the left edge in the owner's colour, so your own rows are the plain
 * ones. The open chat is raised and lit.
 */
export function SessionItem({
  session,
  isSelected,
  onSelect,
  badge,
  progressBar,
  blockedBadge,
  blockedByTitle,
  ariaLabel,
  lineageText,
  showOwnership = true,
}: {
  session: ChatSessionResponse;
  isSelected: boolean;
  onSelect: (id: string) => void;
  badge?: ReactNode;
  progressBar?: ReactNode;
  blockedBadge?: boolean;
  blockedByTitle?: string;
  ariaLabel?: string;
  lineageText?: string;
  showOwnership?: boolean;
}) {
  const attentionState = getAttentionState(session);
  const mode = getSessionMode(session);

  // Icon config — blocked overrides normal attention state
  const iconConfig = blockedBadge
    ? { icon: AlertCircle, color: 'var(--sam-color-danger, #ef4444)', label: 'Blocked' }
    : ATTENTION_ICON[attentionState];

  const StatusIcon = iconConfig.icon;
  const ModeIcon = mode === 'task' ? ListTodo : MessageSquare;
  const owner = showOwnership ? sessionOwner(session) : null;
  // Only rows someone else started get the edge light; yours stay plain.
  const edgeColor = owner && owner.slot !== 'you' ? personColorVar(owner.slot) : null;
  const hasPullRequest = Boolean(session.task?.outputPrUrl);
  // Work started from an external AI app reads "Chat via ChatGPT" on the meta line, where
  // it can truncate without moving the buttons on the title line.
  const connector =
    session.task?.triggeredBy === 'connector'
      ? session.task.connectorClientName || 'Connector'
      : null;
  const kindLabel = mode === 'task' ? 'Task' : 'Chat';
  const title = session.topic ? stripMarkdown(session.topic) : `Chat ${session.id.slice(0, 8)}`;

  return (
    <div
      data-selected={isSelected || undefined}
      className={`group/row relative rounded-[13px] transition-colors ${
        isSelected
          ? 'bg-[linear-gradient(180deg,var(--sam-glass-v2-raised),transparent)] shadow-[inset_0_1px_0_var(--sam-glass-v2-raised-edge),inset_0_-1px_0_var(--sam-glass-v2-rim-bottom),var(--sam-shadow-glow-active)]'
          : 'hover:bg-[var(--sam-glass-v2-raised)]'
      }`}
    >
      {edgeColor && (
        <span
          aria-hidden="true"
          data-testid="session-owner-edge"
          className="pointer-events-none absolute top-3 bottom-3 left-[3px] w-[3px] rounded-[3px]"
          style={{ background: edgeColor, boxShadow: `0 0 10px ${edgeColor}` } as CSSProperties}
        />
      )}
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        aria-label={ariaLabel}
        aria-current={isSelected ? 'true' : undefined}
        className="grid w-full cursor-pointer grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-[3px] rounded-[13px] border-none bg-transparent py-2.5 pr-3 pl-3.5 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--sam-color-focus-ring)]"
      >
        <span
          className="flex items-center justify-center"
          style={{ color: iconConfig.color }}
          title={iconConfig.label}
        >
          <StatusIcon
            size={17}
            strokeWidth={1.9}
            className={attentionState === 'active' ? 'motion-safe:animate-spin' : ''}
          />
          <span className="sr-only">{iconConfig.label}</span>
        </span>

        <span className="flex min-w-0 items-center gap-1.5">
          {attentionState === 'expired' && (
            <span className="shrink-0 text-xs text-fg-muted">Expired</span>
          )}
          <span
            className={`min-w-0 truncate text-[14.5px] text-fg-primary ${isSelected ? 'font-semibold' : 'font-medium'}`}
          >
            {title}
          </span>
        </span>

        <span className="flex items-center gap-1.5">
          {blockedBadge && (
            <span className="rounded-full bg-danger-tint px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wide text-danger-fg uppercase">
              Blocked
            </span>
          )}
          {hasPullRequest && (
            <span
              title="Has a pull request"
              className="inline-grid h-[26px] w-[26px] place-items-center rounded-lg bg-[var(--sam-status-purple-bg)] text-[var(--sam-status-purple-fg)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--sam-status-purple-fg)_35%,transparent)]"
            >
              <GitPullRequest size={14} strokeWidth={1.9} aria-hidden="true" />
              <span className="sr-only">Has a pull request</span>
            </span>
          )}
          {badge}
        </span>

        <span className="col-start-2 col-end-4 flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
          {blockedBadge && blockedByTitle ? (
            <span className="truncate text-danger-fg">Waiting on: {blockedByTitle}</span>
          ) : (
            <>
              {owner && (
                <span
                  className={`flex items-center gap-1.5 ${connector ? 'shrink-0' : 'min-w-0 shrink'}`}
                  title={owner.slot === 'you' ? 'Created by you' : `Created by ${owner.label}`}
                >
                  <PersonAvatar name={owner.name} person={owner.slot} size={14} decorative />
                  <span
                    className={`max-w-[110px] truncate ${owner.slot === 'you' ? 'text-fg-primary' : personTextClassName(owner.slot)}`}
                  >
                    {owner.label}
                  </span>
                </span>
              )}
              {owner && <span aria-hidden="true">&middot;</span>}
              <span
                className={`flex items-center gap-1 ${connector ? 'min-w-0' : 'shrink-0'}`}
                title={
                  connector
                    ? `${kindLabel} started from ${connector}`
                    : mode === 'task'
                      ? 'Task'
                      : 'Conversation'
                }
              >
                {!owner && (
                  <ModeIcon size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
                )}
                <span className="shrink-0">{kindLabel}</span>
                {connector && (
                  <span data-testid="session-connector" className="min-w-0 truncate">
                    {/* The leading space keeps "Task via X" one phrase for screen readers. */}
                    {' via '}
                    <span className="text-fg-secondary">{connector}</span>
                  </span>
                )}
              </span>
              {attentionState === 'needs_input' && (
                <span className="shrink-0 font-medium text-warning-fg">Needs input</span>
              )}
              {attentionState === 'wake_failed' && (
                <span className="shrink-0 font-medium text-danger-fg">Wake failed</span>
              )}
              {lineageText && (
                <>
                  <span aria-hidden="true">&middot;</span>
                  <span className="truncate">{lineageText}</span>
                </>
              )}
              <span className="ml-auto shrink-0 pl-1 font-mono text-xs text-fg-muted">
                {formatRelativeTime(getLastActivity(session))}
              </span>
            </>
          )}
        </span>
        {progressBar && <span className="col-span-3">{progressBar}</span>}
      </button>
    </div>
  );
}
