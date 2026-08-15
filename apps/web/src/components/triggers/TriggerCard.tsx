import type { TriggerResponse } from '@simple-agent-manager/shared';
import { Card, DropdownMenu, type DropdownMenuItem, StatusBadge } from '@simple-agent-manager/ui';
import { Calendar, History, Play } from 'lucide-react';
import { type FC, useMemo } from 'react';

import { timeAgo } from '../../lib/time-utils';
import {
  FOCUS_RING,
  formatNextRun,
  formatTriggerSource,
  sourceIcon,
  statusBadgeKey,
} from './trigger-presentation';
import { TriggerCredentialWarning } from './TriggerCredentialWarning';

interface TriggerCardProps {
  trigger: TriggerResponse;
  onEdit: (trigger: TriggerResponse) => void;
  onRunNow: (trigger: TriggerResponse) => void;
  onTogglePause: (trigger: TriggerResponse) => void;
  onViewHistory: (trigger: TriggerResponse) => void;
  onDelete?: (trigger: TriggerResponse) => void;
}

export const TriggerCard: FC<TriggerCardProps> = ({
  trigger,
  onEdit,
  onRunNow,
  onTogglePause,
  onViewHistory,
  onDelete,
}) => {
  const isDisabled = trigger.status === 'disabled';
  const isPaused = trigger.status === 'paused';

  // No item icons: every other DropdownMenu in the app (WorkspaceCard, NodeCard,
  // ProjectSummaryCard) is icon-less, and a partially-iconed menu also misaligns
  // its own labels.
  const menuItems = useMemo<DropdownMenuItem[]>(() => {
    const items: DropdownMenuItem[] = [
      { id: 'edit', label: 'Edit', onClick: () => onEdit(trigger) },
      {
        id: 'pause',
        label: isPaused ? 'Resume' : 'Pause',
        onClick: () => onTogglePause(trigger),
      },
      {
        id: 'history',
        label: 'View history',
        onClick: () => onViewHistory(trigger),
      },
    ];
    if (onDelete) {
      items.push({
        id: 'delete',
        label: 'Delete',
        variant: 'danger',
        onClick: () => onDelete(trigger),
      });
    }
    return items;
  }, [isPaused, onDelete, onEdit, onTogglePause, onViewHistory, trigger]);

  return (
    <Card
      variant="glass"
      className={`p-4 transition-colors duration-150 hover:bg-surface-hover ${
        isDisabled ? 'opacity-60' : ''
      }`}
    >
      {/*
        Title row. `min-w-0` on the text column is what lets the title wrap
        instead of forcing the row wider than the card. The action cluster is
        `shrink-0` so it can never be squeezed off the right edge — the exact
        failure in the reported mobile screenshot.
      */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/*
            The name WRAPS (up to two lines) rather than using `truncate`. A
            truncated name is unreadable on a 375px screen, and `truncate`'s
            `white-space: nowrap` also made the heading's min-content width the
            full untruncated string, which is what blew the whole page past the
            viewport.
          */}
          <h3 className="sam-type-card-title m-0 line-clamp-2 break-words" title={trigger.name}>
            {trigger.name}
          </h3>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/*
            The label is hidden only where space is genuinely scarce. Running a
            trigger is this page's core action, and the desktop layout has room —
            dropping the label everywhere would make it less discoverable than
            the button it replaced, and inconsistent with the identical action on
            the detail page (ProjectTriggerDetail.tsx).
          */}
          <button
            type="button"
            onClick={() => onRunNow(trigger)}
            disabled={isDisabled}
            title={isDisabled ? 'Trigger is disabled' : 'Run now'}
            aria-label={`Run "${trigger.name}" now`}
            className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-sm border border-border-default bg-transparent px-2 text-xs font-medium text-fg-muted hover:bg-surface-hover hover:text-fg-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
          >
            <Play size={14} aria-hidden="true" />
            <span className="hidden sm:inline">Run now</span>
          </button>
          <DropdownMenu items={menuItems} aria-label={`Actions for "${trigger.name}"`} />
        </div>
      </div>

      {/*
        Status + what makes it fire, on their OWN full-width row. Keeping this
        inside the title column starved it of space and truncated the schedule
        to "At 7:00 AM on …" — the single most important fact about a cron
        trigger — while the row below sat empty.
      */}
      <div className="mt-2 flex items-center gap-2">
        <span className="shrink-0">
          <StatusBadge status={statusBadgeKey(trigger.status)} pulse={false} />
        </span>
        <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-fg-muted">
          <span className="shrink-0">{sourceIcon(trigger)}</span>
          <span className="truncate">{formatTriggerSource(trigger)}</span>
        </span>
      </div>

      {trigger.description && (
        // `break-words`: a long unbreakable token (a URL in a description) is
        // wider than the card, and `line-clamp`'s `overflow: hidden` shears it
        // off with no ellipsis and no way to scroll to it.
        <p className="sam-type-secondary text-fg-muted mt-2 mb-0 line-clamp-2 break-words">
          {trigger.description}
        </p>
      )}

      {(trigger.nextFireAt || trigger.lastTriggeredAt) && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
          {trigger.sourceType === 'cron' && trigger.nextFireAt && !isPaused && !isDisabled && (
            <span className="inline-flex items-center gap-1.5">
              <Calendar size={12} aria-hidden="true" />
              Next {formatNextRun(trigger.nextFireAt)}
            </span>
          )}
          {trigger.lastTriggeredAt && (
            <span className="inline-flex items-center gap-1.5">
              <History size={12} aria-hidden="true" />
              Last run {timeAgo(trigger.lastTriggeredAt)}
            </span>
          )}
        </div>
      )}

      {trigger.credentialAttribution?.multiplayerActive &&
        trigger.credentialAttribution.hasPersonalWarning && (
          <div className="mt-3">
            <TriggerCredentialWarning trigger={trigger} />
          </div>
        )}
    </Card>
  );
};
