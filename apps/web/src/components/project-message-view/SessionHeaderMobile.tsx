import type { DetectedPort } from '@simple-agent-manager/shared';
import { chipClassName, paneClassName } from '@simple-agent-manager/ui';
import { ChevronDown, Globe } from 'lucide-react';
import type { ReactNode } from 'react';

import { SessionCommentChip } from './SessionCommentChip';
import type { SessionStateTone } from './SessionHeaderChips';
import { SessionInfoSheet } from './SessionInfoSheet';

const DOT_COLOR: Record<SessionStateTone, string> = {
  success: 'text-[var(--sam-status-success-fg)]',
  info: 'text-[var(--sam-status-info-fg)]',
  muted: 'text-[var(--sam-status-muted-fg)]',
};

/**
 * The session header on a phone: one 48px row instead of a two-line title, a wrapping chip row
 * and the public-ports switch, which together took about a quarter of the screen.
 *
 * The row keeps what is used constantly: the status (as a dot), the title, unresolved comments
 * (a discovery surface, so it must stay visible) and the first forwarded port. Tapping the
 * title opens `SessionInfoSheet` with everything else, including the full details panel. The
 * rail's "Details" action opens the same sheet, because `expanded` drives both.
 */
export function SessionHeaderMobile({
  title,
  stateLabel,
  stateTone,
  firstPort,
  getWorkspacePortHref,
  unresolvedCommentCount,
  needsAttentionCommentCount,
  onOpenComments,
  expanded,
  onExpandedChange,
  people,
  belowRow,
  sheetContent,
}: Readonly<{
  title: string;
  stateLabel: string;
  stateTone: SessionStateTone;
  firstPort: DetectedPort | undefined;
  getWorkspacePortHref: (port: DetectedPort) => string;
  unresolvedCommentCount: number;
  needsAttentionCommentCount: number;
  onOpenComments?: () => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  people?: ReactNode;
  /** Rows that must stay on screen with the sheet closed (the mark-complete error). */
  belowRow?: ReactNode;
  sheetContent: ReactNode;
}>) {
  return (
    <div
      data-testid="session-header"
      data-layout="mobile"
      className={`${paneClassName('slab')} flex shrink-0 flex-col overflow-hidden`}
    >
      <div className="flex min-h-12 items-center gap-1.5 py-0.5 pr-2 pl-1.5">
        <button
          type="button"
          // Focus target after an in-chat link opens another chat (session-focus-handoff).
          data-session-title
          onClick={() => onExpandedChange(true)}
          aria-expanded={expanded}
          aria-haspopup="dialog"
          aria-label={`${title}. ${stateLabel}. Show session info`}
          title={title}
          className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-[var(--sam-radius-control)] border-none bg-transparent px-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <span
            aria-hidden="true"
            className={`h-2 w-2 shrink-0 rounded-full bg-current shadow-[0_0_8px_currentColor] ${DOT_COLOR[stateTone]}`}
          />
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg-primary">
            {title}
          </span>
          <ChevronDown size={16} aria-hidden="true" className="shrink-0 text-fg-muted" />
        </button>

        {onOpenComments && unresolvedCommentCount > 0 && (
          <SessionCommentChip
            unresolvedCommentCount={unresolvedCommentCount}
            needsAttentionCommentCount={needsAttentionCommentCount}
            onOpenComments={onOpenComments}
          />
        )}

        {firstPort && (
          <a
            href={getWorkspacePortHref(firstPort)}
            target="_blank"
            rel="noopener noreferrer"
            // The pseudo-element widens the hit area to 44px without growing the chip.
            className={`${chipClassName({ tone: 'success', size: 'sm' })} relative transition-[filter] after:absolute after:-inset-x-1 after:-inset-y-2.5 after:content-[''] hover:brightness-110`}
            title={`${firstPort.label} — ${firstPort.url}`}
            aria-label={`Open port ${firstPort.port}`}
          >
            <Globe size={12} strokeWidth={1.75} aria-hidden="true" />
            {firstPort.port}
          </a>
        )}
      </div>

      {belowRow}

      {expanded && (
        <SessionInfoSheet title={title} people={people} onClose={() => onExpandedChange(false)}>
          {sheetContent}
        </SessionInfoSheet>
      )}
    </div>
  );
}
