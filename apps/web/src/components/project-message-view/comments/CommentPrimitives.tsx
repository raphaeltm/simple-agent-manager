import { Button, Popover } from '@simple-agent-manager/ui';

import { COMMENT_STATUS_LABELS, type UiMessageCommentThread } from './comment-utils';

export function CommentGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 9.5A1.5 1.5 0 0 1 12.5 11H5l-3 3V3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5z" />
    </svg>
  );
}

export function CommentStatusPill({ status }: Pick<UiMessageCommentThread, 'status'>) {
  const toneClass =
    status === 'resolved'
      ? 'bg-success-tint text-success-fg'
      : status === 'sent'
        ? 'bg-info-tint text-info-fg'
        : 'bg-warning-tint text-warning-fg';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium whitespace-nowrap ${toneClass}`}
    >
      {status === 'sent' && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />}
      {COMMENT_STATUS_LABELS[status]}
    </span>
  );
}

export function QuotedAnchor({ quote }: { quote: string }) {
  return (
    <blockquote className="mb-2 border-l-2 border-tn-blue pl-2 text-xs italic text-fg-muted [overflow-wrap:anywhere]">
      {quote}
    </blockquote>
  );
}

export function CommentCountMarker({
  count,
  unresolvedCount,
  expanded,
  onClick,
}: {
  count: number;
  unresolvedCount: number;
  expanded: boolean;
  onClick: () => void;
}) {
  const label = `${count} comment${count === 1 ? '' : 's'} on this message${
    unresolvedCount > 0 ? `, ${unresolvedCount} unresolved` : ''
  }`;

  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium transition-colors ${
        unresolvedCount > 0
          ? 'border-warning text-warning-fg bg-warning-tint'
          : 'border-border-default text-fg-muted hover:text-fg-primary'
      }`}
    >
      <CommentGlyph />
      <span>{count}</span>
    </button>
  );
}

export function SelectionPopover({
  x,
  y,
  onComment,
}: {
  x: number;
  y: number;
  onComment: () => void;
}) {
  return (
    <Popover open anchorPoint={{ x, y }} side="top" aria-label="Comment on selection">
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onComment}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
      >
        <CommentGlyph />
        Comment
      </button>
    </Popover>
  );
}

export function SelectionActionBar({
  quote,
  onComment,
  onDismiss,
}: {
  quote: string;
  onComment: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label="Comment on selection"
      className="fixed inset-x-0 bottom-0 z-panel border-t border-border-default bg-surface px-3 pt-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] shadow-lg"
    >
      <p className="m-0 mb-2 line-clamp-2 border-l-2 border-tn-blue pl-2 text-xs italic text-fg-muted [overflow-wrap:anywhere]">
        {quote}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onMouseDown={(e: React.MouseEvent) => e.preventDefault()} onClick={onComment}>
          Comment on selection
        </Button>
        <Button size="sm" variant="ghost" onMouseDown={(e: React.MouseEvent) => e.preventDefault()} onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
